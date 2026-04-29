import { createWriteStream } from 'fs'
import { stat as fsStat, rename, unlink, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { HUB_HTTP_USER_AGENT } from '../../shared/hub-http.js'
import { session } from 'electron'
import yauzl from 'yauzl'
import {
  insertDownload,
  getDownload,
  getDownloadByRef,
  getAllDownloads,
  updateDownloadStatus,
  resetActiveDownloads,
  failUnfinishedDownloads,
  cancelAllDownloads,
  cancelDownload as dbCancel,
  retryDownload as dbRetry,
  clearCompletedDownloads,
  clearFailedDownloads,
  deleteDownload,
  getSetting,
  setHubDisplayName,
  upsertHubUser,
  setHubResourceId,
  setHubUserId,
  setPackageHubMeta,
} from '../db.js'
import { getResourceDetail, getResourceDetailByName, getCachedDetail, findPackages } from '../hub/client.js'
import { notify } from '../notify.js'
import { scanAndUpsert } from '../scanner/ingest.js'
import { computeCascadeEnable, parseDepRef, isFlexibleRef } from '../scanner/graph.js'
import {
  buildFromDb,
  buildGraphOnly,
  setPrefsMap,
  getForwardDeps,
  getReverseDeps,
  getPackageIndex,
  getTransitiveMissingRefs,
  findLocalByFilename,
} from '../store.js'
import { readAllPrefs, hidePackageContent } from '../vam-prefs.js'
import { suppressPrefsStem, unsuppressPrefsStem, suppressPath } from '../watcher.js'
import { resolvePackageThumbnails } from '../thumb-resolver.js'
import { applyStorageState, computeInstallTarget, parseDisableBehavior } from '../storage-state.js'
import { getMainLibraryDirPath } from '../library-dirs.js'

const MAX_CONCURRENT = 5
const PROGRESS_INTERVAL_MS = 250
const MAX_AUTO_RETRIES = 5
const RETRY_BASE_DELAY_MS = 2000 // 2s, 4s, 8s, 16s, 32s

/** True for errors that are likely transient network failures (Wi-Fi switch, brief outage). */
function isTransientNetworkError(err) {
  if (err.name === 'AbortError') return false
  const code = err.cause?.code || err.code || ''
  if (
    /ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|ENETDOWN|EPIPE|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT/i.test(
      code,
    )
  )
    return true
  if (/network|socket hang up|fetch failed/i.test(err.message)) return true
  if (/Resume range rejected/i.test(err.message)) return true
  return false
}

/** Quick structural integrity check — opens the ZIP central directory and iterates all entries. */
function verifyZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err)
      zipfile.readEntry()
      zipfile.on('entry', () => zipfile.readEntry())
      zipfile.on('end', () => resolve())
      zipfile.on('error', reject)
    })
  })
}

let activeTransfers = new Map()
let progressTimers = new Map()
let pausedProgress = new Map() // id → { progress, bytesLoaded } snapshot from when paused
let retryCounters = new Map() // id → number of auto-retries attempted
let retryTimers = new Map() // id → pending setTimeout handle
let paused = false
let pendingDepLookups = new Set() // dep refs currently in-flight via findPackages

export async function initDownloadManager() {
  // Clean up temp files from any interrupted downloads before marking them failed
  const rows = getAllDownloads()
  for (const r of rows) {
    if (r.temp_path && (r.status === 'active' || r.status === 'queued')) {
      try {
        await unlink(r.temp_path)
      } catch {}
    }
  }
  failUnfinishedDownloads()
  clearCompleted()
}

function emitUpdated() {
  notify('downloads:updated')
}

function emitFailed(entry, error) {
  notify('download:failed', {
    packageRef: entry.package_ref,
    displayName: entry.display_name || null,
    error: error || null,
  })
}

function emitProgress(id, data) {
  notify('download:progress', { id, ...data })
}

function ensureVarExt(filename) {
  if (!filename) return filename
  return /\.var$/i.test(filename) ? filename : filename + '.var'
}

/**
 * True when the version segment of a .var filename is a flexible dep-ref token
 * ("latest" or "minN") — i.e. a filename that must never be written to disk or
 * stored as a concrete download_ref.
 */
function isFlexibleFilename(filename) {
  if (!filename) return false
  const stem = filename.replace(/\.var$/i, '')
  const parts = stem.split('.')
  if (parts.length < 3) return false
  const last = parts[parts.length - 1].toLowerCase()
  return last === 'latest' || /^min\d+$/.test(last)
}

/**
 * Build a concrete .var filename from a Hub dependency entry.
 * The authoritative field is `latest_version` (see docs/API.md):
 *   - For numeric refs it mirrors `version`.
 *   - For flexible refs (.latest, .minN) it holds the concrete integer the URL serves.
 * Returns null if `packageName` or `latest_version` is missing/non-numeric;
 * callers then fall through to a findPackages lookup rather than writing a
 * flexible-tokened filename into the downloads table.
 */
function concreteDepFilename(file) {
  const name = file?.packageName
  const ver = file?.latest_version
  if (!name || !/^\d+$/.test(String(ver))) return null
  return name + '.' + ver + '.var'
}

// --- Public API (called by IPC handlers) ---

export async function enqueueInstall(
  resourceId,
  hubDetailData,
  autoQueueDeps = true,
  packageName,
  asDependency = false,
) {
  const detail =
    hubDetailData || (packageName ? await getResourceDetailByName(packageName) : await getResourceDetail(resourceId))
  if (!detail) throw new Error('Resource not found on Hub')

  // hub_json auto-persisted by getResourceDetail/getResourceDetailByName
  try {
    if (detail.user_id) {
      upsertHubUser(String(detail.user_id), detail.username, {
        user_id: detail.user_id,
        username: detail.username,
        avatar_date: detail.avatar_date,
      })
    }
  } catch {}

  const hubFiles = detail.hubFiles || []
  if (hubFiles.length === 0) throw new Error('No downloadable files')

  const isPaid = detail.category === 'Paid'
  if (isPaid) throw new Error('Cannot download paid packages')

  const hubTitle = detail.title || null
  let inserted = 0
  let alreadyLocal = 0
  let alreadyQueued = 0
  for (const file of hubFiles) {
    const url = resolveDownloadUrl(file)
    const fn = ensureVarExt(file.filename)
    if (!url || !fn) continue
    if (findLocalByFilename(fn)) {
      alreadyLocal++
      continue
    }
    const existing = getDownloadByRef(fn)
    if (existing) {
      if (existing.status === 'queued' || existing.status === 'active') {
        alreadyQueued++
        continue
      }
      deleteDownload(existing.id)
    }
    insertDownload({
      packageRef: fn,
      hubResourceId: String(detail.resource_id || ''),
      downloadUrl: url,
      fileSize: parseInt(file.file_size || '0', 10) || null,
      priority: asDependency ? 'dependency' : 'direct',
      parentRef: null,
      displayName: hubTitle,
      autoQueueDeps: autoQueueDeps ? 1 : 0,
    })
    inserted++
  }
  if (inserted + alreadyLocal + alreadyQueued === 0) throw new Error('No download URL available')

  emitUpdated()
  processQueue()

  const mainRef = ensureVarExt(hubFiles[0].filename)
  const unresolvedDeps = await enqueueMissingDeps(detail, mainRef, autoQueueDeps)

  emitUpdated()
  processQueue()
  return { ok: true, inserted, alreadyLocal, alreadyQueued, paused, unresolvedDeps }
}

export async function enqueueInstallMissing(packageFilename, autoQueueDeps = true) {
  const missingRefs = getTransitiveMissingRefs(packageFilename, { includeFallbacks: true })
  if (missingRefs.size === 0) return { ok: true, queued: 0, unresolvedDeps: [] }

  const uniqueMissing = [...missingRefs]
  let hubResults = {}
  try {
    hubResults = await findPackages(uniqueMissing)
  } catch (err) {
    console.warn('findPackages failed:', err.message)
    return { ok: true, queued: 0, unresolvedDeps: uniqueMissing }
  }

  // find_json auto-persisted by findPackages

  let queued = 0
  const unresolvedDeps = []

  for (const ref of uniqueMissing) {
    const hubFile = hubResults[ref]
    if (!hubFile) {
      unresolvedDeps.push(ref)
      continue
    }
    const fn = ensureVarExt(hubFile.filename)
    if (!fn) {
      unresolvedDeps.push(ref)
      continue
    }
    if (findLocalByFilename(fn)) continue
    const existing = getDownloadByRef(fn)
    if (existing && (existing.status === 'queued' || existing.status === 'active')) continue
    const url = resolveDownloadUrl(hubFile)
    if (!url) {
      unresolvedDeps.push(ref)
      continue
    }
    if (existing) deleteDownload(existing.id)
    insertDownload({
      packageRef: fn,
      hubResourceId: hubFile.resource_id ? String(hubFile.resource_id) : null,
      downloadUrl: url,
      fileSize: parseInt(hubFile.file_size || '0', 10) || null,
      priority: 'dependency',
      parentRef: packageFilename,
      displayName: null,
      autoQueueDeps: autoQueueDeps ? 1 : 0,
    })
    queued++
  }

  if (queued > 0) {
    emitUpdated()
    processQueue()
  }
  return { ok: true, queued, unresolvedDeps }
}

export async function enqueueInstallAllMissing() {
  const fwd = getForwardDeps()
  const pkgIndex = getPackageIndex()
  const allMissing = new Set()

  for (const [filename] of pkgIndex) {
    for (const d of fwd.get(filename) || []) {
      if (!d.resolved || d.resolution === 'fallback') allMissing.add(d.ref)
    }
  }

  if (allMissing.size === 0) return { ok: true, queued: 0, unresolvedDeps: [] }

  const uniqueMissing = [...allMissing]
  let hubResults = {}
  try {
    hubResults = await findPackages(uniqueMissing)
  } catch (err) {
    console.warn('findPackages failed:', err.message)
    return { ok: true, queued: 0, unresolvedDeps: uniqueMissing }
  }

  // find_json auto-persisted by findPackages

  let queued = 0
  const unresolvedDeps = []

  for (const ref of uniqueMissing) {
    const hubFile = hubResults[ref]
    if (!hubFile) {
      unresolvedDeps.push(ref)
      continue
    }
    const fn = ensureVarExt(hubFile.filename)
    if (!fn) {
      unresolvedDeps.push(ref)
      continue
    }
    if (findLocalByFilename(fn)) continue
    const existing = getDownloadByRef(fn)
    if (existing && (existing.status === 'queued' || existing.status === 'active')) continue
    const url = resolveDownloadUrl(hubFile)
    if (!url) {
      unresolvedDeps.push(ref)
      continue
    }
    if (existing) deleteDownload(existing.id)
    insertDownload({
      packageRef: fn,
      hubResourceId: hubFile.resource_id ? String(hubFile.resource_id) : null,
      downloadUrl: url,
      fileSize: parseInt(hubFile.file_size || '0', 10) || null,
      priority: 'dependency',
      parentRef: null,
      displayName: null,
      autoQueueDeps: 1,
    })
    queued++
  }

  if (queued > 0) {
    emitUpdated()
    processQueue()
  }
  return { ok: true, queued, unresolvedDeps }
}

export async function enqueueInstallBatch(hubFileDataArray, autoQueueDeps = true) {
  // Collect items that need URL resolution via findPackages
  const needsResolve = []
  const readyItems = []
  for (const hubFileData of hubFileDataArray) {
    const fn = ensureVarExt(hubFileData.filename)
    if (!fn) continue
    if (findLocalByFilename(fn)) continue
    const existing = getDownloadByRef(fn)
    if (existing && (existing.status === 'queued' || existing.status === 'active')) continue
    const url = resolveDownloadUrl(hubFileData)
    if (url) {
      readyItems.push({ fn, hubFileData, url })
    } else {
      needsResolve.push({ fn, hubFileData })
    }
  }

  // Batch-resolve missing URLs
  if (needsResolve.length > 0) {
    const refs = needsResolve.map((item) => item.fn.replace(/\.var$/i, ''))
    try {
      const results = await findPackages(refs)
      for (let i = 0; i < needsResolve.length; i++) {
        const resolved = results[refs[i]]
        if (!resolved) continue
        const url = resolveDownloadUrl(resolved)
        if (!url) continue
        const item = needsResolve[i]
        readyItems.push({
          fn: item.fn,
          url,
          hubFileData: {
            ...item.hubFileData,
            file_size: item.hubFileData.file_size || resolved.file_size,
            resource_id: item.hubFileData.resource_id || resolved.resource_id,
          },
        })
      }
    } catch (err) {
      console.warn('enqueueInstallBatch: findPackages failed:', err.message)
    }
  }

  let queued = 0
  for (const { fn, hubFileData, url } of readyItems) {
    const existing = getDownloadByRef(fn)
    if (existing && (existing.status === 'queued' || existing.status === 'active')) continue
    if (existing) deleteDownload(existing.id)
    insertDownload({
      packageRef: fn,
      hubResourceId: hubFileData.resource_id ? String(hubFileData.resource_id) : null,
      downloadUrl: url,
      fileSize: parseInt(hubFileData.file_size || '0', 10) || null,
      priority: 'dependency',
      parentRef: null,
      displayName: null,
      autoQueueDeps: autoQueueDeps ? 1 : 0,
    })
    queued++
  }
  if (queued > 0) {
    emitUpdated()
    processQueue()
  }
  return { ok: true, queued }
}

export async function enqueueInstallRef(hubFileData) {
  const fn = ensureVarExt(hubFileData.filename)
  if (!fn) throw new Error('No filename in hub data')
  if (findLocalByFilename(fn)) return { ok: true, already: true }
  const existing = getDownloadByRef(fn)
  if (existing && (existing.status === 'queued' || existing.status === 'active')) return { ok: true, queued: true }

  let url = resolveDownloadUrl(hubFileData)
  let fileSize = parseInt(hubFileData.file_size || '0', 10) || null
  let resourceId = hubFileData.resource_id ? String(hubFileData.resource_id) : null

  // When called from packages.json-based resolution we may not have a download URL yet
  if (!url) {
    const ref = fn.replace(/\.var$/i, '')
    const results = await findPackages([ref])
    const resolved = results[ref]
    if (resolved) {
      url = resolveDownloadUrl(resolved)
      if (!fileSize) fileSize = parseInt(resolved.file_size || '0', 10) || null
      if (!resourceId && resolved.resource_id) resourceId = String(resolved.resource_id)
    }
  }
  if (!url) throw new Error('No download URL available')

  if (existing) deleteDownload(existing.id)
  insertDownload({
    packageRef: fn,
    hubResourceId: resourceId,
    downloadUrl: url,
    fileSize,
    priority: 'dependency',
    parentRef: null,
    displayName: null,
    autoQueueDeps: 0,
  })
  emitUpdated()
  processQueue()
  return { ok: true }
}

/** @returns {Promise<string[]>} Dep refs that could not be queued (not on Hub or no download URL). */
async function enqueueMissingDeps(detail, parentRef, autoQueueDeps = true) {
  if (!detail.dependencies) return []

  const needsLookup = new Set()
  for (const [group, files] of Object.entries(detail.dependencies)) {
    for (const file of files) {
      // file.filename is the dep-ref verbatim (e.g. ".latest", ".min5") — not a concrete filename.
      // Always derive the stored filename from packageName + latest_version.
      const depFn = concreteDepFilename(file)
      if (!depFn) {
        const depKey = file.packageName || file.filename || group
        if (depKey) needsLookup.add(depKey)
        continue
      }
      if (findLocalByFilename(depFn)) continue
      const url = resolveDownloadUrl(file)
      if (url) {
        const existingDep = getDownloadByRef(depFn)
        if (existingDep && (existingDep.status === 'queued' || existingDep.status === 'active')) {
          // already in progress
        } else {
          if (existingDep) deleteDownload(existingDep.id)
          insertDownload({
            packageRef: depFn,
            hubResourceId: file.resource_id != null && file.resource_id !== '' ? String(file.resource_id) : null,
            downloadUrl: url,
            fileSize: parseInt(file.file_size || '0', 10) || null,
            priority: 'dependency',
            parentRef,
            displayName: null,
            autoQueueDeps: autoQueueDeps ? 1 : 0,
          })
        }
      } else {
        const depKey = file.packageName || file.filename || group
        if (depKey) needsLookup.add(depKey)
      }
    }
  }

  if (needsLookup.size === 0) return []

  const refs = [...needsLookup].filter(Boolean)
  let hubResults = {}
  try {
    hubResults = await findPackages(refs)
  } catch (err) {
    console.warn('Failed to resolve some dependency URLs:', err.message)
    return refs
  }

  // find_json auto-persisted by findPackages

  const unresolved = []
  for (const ref of refs) {
    const hubFile = hubResults[ref]
    if (!hubFile) {
      unresolved.push(ref)
      continue
    }
    // findPackages returns concrete filenames; reject flexible ones defensively so they
    // can never land in downloads.package_ref.
    const depFn = ensureVarExt(hubFile.filename)
    if (!depFn || isFlexibleFilename(depFn)) {
      unresolved.push(ref)
      continue
    }
    if (findLocalByFilename(depFn)) continue
    const existingDep = getDownloadByRef(depFn)
    if (existingDep && (existingDep.status === 'queued' || existingDep.status === 'active')) continue
    const url = resolveDownloadUrl(hubFile)
    if (!url) {
      unresolved.push(ref)
      continue
    }
    if (existingDep) deleteDownload(existingDep.id)
    insertDownload({
      packageRef: depFn,
      hubResourceId: hubFile.resource_id ? String(hubFile.resource_id) : null,
      downloadUrl: url,
      fileSize: parseInt(hubFile.file_size || '0', 10) || null,
      priority: 'dependency',
      parentRef,
      displayName: null,
      autoQueueDeps: autoQueueDeps ? 1 : 0,
    })
  }

  return unresolved
}

function resolveDownloadUrl(hubFile) {
  if (hubFile.downloadUrl && hubFile.downloadUrl !== 'null' && !hubFile.downloadUrl.endsWith('?file=')) {
    return hubFile.downloadUrl
  }
  if (hubFile.urlHosted && hubFile.urlHosted !== 'null') {
    return hubFile.urlHosted
  }
  return null
}

export function getDownloadList() {
  const rows = getAllDownloads()
  return rows.map((row) => {
    const live = activeTransfers.get(row.id)
    const snap = pausedProgress.get(row.id)
    return {
      ...row,
      progress: live?.progress ?? snap?.progress ?? (row.status === 'completed' ? 100 : 0),
      speed: live?.speed ?? 0,
      bytesLoaded: live?.bytesLoaded ?? snap?.bytesLoaded ?? 0,
    }
  })
}

export async function cancelItem(id) {
  const row = getDownload(id)
  const transfer = activeTransfers.get(id)
  if (transfer?.controller) {
    transfer.controller.abort()
  }
  dbCancel(id)
  cleanupTransfer(id)
  pausedProgress.delete(id)
  clearRetryState(id)
  if (row?.temp_path) {
    try {
      await unlink(row.temp_path)
    } catch {}
  }
  emitUpdated()
}

export function retryItem(id) {
  clearRetryState(id)
  dbRetry(id)
  emitUpdated()
  processQueue()
}

export function clearCompleted() {
  clearCompletedDownloads()
  emitUpdated()
}

export function clearFailed() {
  clearFailedDownloads()
  emitUpdated()
}

export function removeFailedItem(id) {
  const row = getDownload(id)
  if (!row || row.status !== 'failed') return
  deleteDownload(id)
  emitUpdated()
}

export function isPaused() {
  return paused
}

export function pauseAll() {
  paused = true
  const ids = [...activeTransfers.keys()]
  for (const id of ids) {
    const transfer = activeTransfers.get(id)
    if (transfer) {
      pausedProgress.set(id, { progress: transfer.progress, bytesLoaded: transfer.bytesLoaded })
    }
    if (transfer?.controller) transfer.controller.abort()
    cleanupTransfer(id)
  }
  emitUpdated()
}

export function resumeAll() {
  paused = false
  resetActiveDownloads()
  emitUpdated()
  processQueue()
}

export async function cancelAll() {
  // Collect temp paths from all non-completed downloads before wiping DB state
  const allRows = getAllDownloads()
  const tempPaths = allRows.filter((r) => r.temp_path && r.status !== 'completed').map((r) => r.temp_path)

  const ids = [...activeTransfers.keys()]
  for (const id of ids) {
    const transfer = activeTransfers.get(id)
    if (transfer?.controller) transfer.controller.abort()
    cleanupTransfer(id)
  }
  cancelAllDownloads()
  paused = false
  pausedProgress.clear()
  for (const timer of retryTimers.values()) clearTimeout(timer)
  retryTimers.clear()
  retryCounters.clear()

  for (const p of tempPaths) {
    try {
      await unlink(p)
    } catch {}
  }
  emitUpdated()
}

// --- Download engine ---

function getActiveCount() {
  return activeTransfers.size
}

function processQueue() {
  if (paused) return
  while (getActiveCount() < MAX_CONCURRENT) {
    const next = pickNextQueued()
    if (!next) break
    startDownload(next)
  }
}

function pickNextQueued() {
  const all = getAllDownloads()
  // Direct first, then dependencies, ordered by created_at
  const queued = all.filter((d) => d.status === 'queued')
  queued.sort((a, b) => {
    if (a.priority === 'direct' && b.priority !== 'direct') return -1
    if (a.priority !== 'direct' && b.priority === 'direct') return 1
    return a.created_at - b.created_at
  })
  return queued[0] || null
}

async function startDownload(entry) {
  const { id, download_url, package_ref, file_size, hub_resource_id } = entry

  updateDownloadStatus(id, 'active')
  emitUpdated()

  const vamDir = getSetting('vam_dir')
  if (!vamDir) {
    updateDownloadStatus(id, 'failed', { error: 'VaM directory not configured' })
    emitFailed(entry, 'VaM directory not configured')
    emitUpdated()
    processQueue()
    return
  }

  const addonDir = getMainLibraryDirPath()
  if (!addonDir) {
    updateDownloadStatus(id, 'failed', { error: 'Main library directory not configured' })
    emitFailed(entry, 'Main library directory not configured')
    emitUpdated()
    processQueue()
    return
  }
  const finalPath = join(addonDir, package_ref)
  const tempPath = finalPath + '.tmp'

  const controller = new AbortController()
  const transferState = {
    controller,
    startTime: Date.now(),
    bytesLoaded: 0,
    progress: 0,
    speed: 0,
    lastSpeedCheck: Date.now(),
    lastSpeedBytes: 0,
  }
  activeTransfers.set(id, transferState)
  pausedProgress.delete(id)

  updateDownloadStatus(id, 'active', { tempPath })

  // Start progress reporting
  const progressTimer = setInterval(() => {
    const elapsed = Date.now() - transferState.lastSpeedCheck
    if (elapsed > 0) {
      transferState.speed = Math.round(((transferState.bytesLoaded - transferState.lastSpeedBytes) / elapsed) * 1000)
      transferState.lastSpeedCheck = Date.now()
      transferState.lastSpeedBytes = transferState.bytesLoaded
    }
    if (file_size && file_size > 0) {
      transferState.progress = Math.min(99, Math.round((transferState.bytesLoaded / file_size) * 100))
    }
    emitProgress(id, {
      progress: transferState.progress,
      speed: transferState.speed,
      bytesLoaded: transferState.bytesLoaded,
      fileSize: file_size,
    })
  }, PROGRESS_INTERVAL_MS)
  progressTimers.set(id, progressTimer)

  try {
    await mkdir(dirname(tempPath), { recursive: true })

    // Check for existing partial download to resume
    let existingBytes = 0
    try {
      const tmpStat = await fsStat(tempPath)
      existingBytes = tmpStat.size
    } catch {}
    transferState.bytesLoaded = existingBytes

    // Get cookies from the hub session for consent
    const hubSession = session.fromPartition('persist:hub')
    const cookies = await hubSession.cookies.get({ url: 'https://hub.virtamate.com' })
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

    const headers = { 'User-Agent': HUB_HTTP_USER_AGENT, Cookie: cookieHeader }
    if (existingBytes > 0) headers['Range'] = `bytes=${existingBytes}-`

    const res = await fetch(download_url, {
      signal: controller.signal,
      headers,
      redirect: 'follow',
    })

    if (existingBytes > 0 && res.status === 200) {
      // Server doesn't support Range — restart from scratch
      existingBytes = 0
      transferState.bytesLoaded = 0
    } else if (existingBytes > 0 && res.status === 416) {
      // Range not satisfiable — file changed on server, restart
      try {
        await unlink(tempPath)
      } catch {}
      existingBytes = 0
      // Re-fetch without Range (recursive would be messy, just throw to retry)
      throw new Error('Resume range rejected by server, will retry from scratch')
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }

    const fileStream = createWriteStream(tempPath, existingBytes > 0 ? { flags: 'a' } : undefined)
    const fileError = new Promise((_, reject) => fileStream.on('error', reject))

    const reader = res.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!fileStream.write(value)) {
        await new Promise((r) => fileStream.once('drain', r))
      }
      transferState.bytesLoaded += value.byteLength
    }

    await Promise.race([new Promise((resolve) => fileStream.end(() => resolve())), fileError])

    // Validate: if byte count diverges from expected, verify ZIP integrity
    if (file_size && file_size > 0 && Math.abs(transferState.bytesLoaded - file_size) > 1024) {
      try {
        await verifyZip(tempPath)
        console.warn(
          `Size mismatch for ${package_ref} (expected ${file_size}, got ${transferState.bytesLoaded}) but ZIP is valid — accepting`,
        )
      } catch (zipErr) {
        throw new Error(
          `Download corrupted (size mismatch: expected ${file_size}, got ${transferState.bytesLoaded}; ZIP check: ${zipErr.message})`,
        )
      }
    }

    // Move temp to final
    suppressPath(finalPath)
    await rename(tempPath, finalPath)

    cleanupTransfer(id)
    retryCounters.delete(id)
    updateDownloadStatus(id, 'completed')
    emitProgress(id, { progress: 100, speed: 0, bytesLoaded: transferState.bytesLoaded, fileSize: file_size })

    // Post-download: scan and integrate
    await postDownloadIntegrate(
      package_ref,
      finalPath,
      entry.priority === 'direct',
      hub_resource_id,
      !!entry.auto_queue_deps,
    )

    emitUpdated()
  } catch (err) {
    cleanupTransfer(id)

    if (err.name === 'AbortError' && paused) {
      // Paused — keep temp file for resume
    } else if (isTransientNetworkError(err)) {
      // Transient network error — auto-retry with backoff, keep temp for resume
      const attempt = (retryCounters.get(id) || 0) + 1
      if (attempt <= MAX_AUTO_RETRIES) {
        retryCounters.set(id, attempt)
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
        console.warn(
          `Download ${package_ref} network error (attempt ${attempt}/${MAX_AUTO_RETRIES}), retrying in ${delay}ms: ${err.message}`,
        )
        updateDownloadStatus(id, 'queued')
        emitUpdated()
        const timer = setTimeout(() => {
          retryTimers.delete(id)
          processQueue()
        }, delay)
        retryTimers.set(id, timer)
      } else {
        // Exhausted retries — fail permanently
        retryCounters.delete(id)
        try {
          await unlink(tempPath)
        } catch {}
        updateDownloadStatus(id, 'failed', { error: `Network error after ${MAX_AUTO_RETRIES} retries: ${err.message}` })
        emitFailed(entry, err.message)
        emitUpdated()
      }
    } else {
      try {
        await unlink(tempPath)
      } catch {}
      if (err.name !== 'AbortError') {
        updateDownloadStatus(id, 'failed', { error: err.message })
        emitFailed(entry, err.message)
        emitUpdated()
      }
    }
  }

  processQueue()
}

function cleanupTransfer(id) {
  activeTransfers.delete(id)
  const timer = progressTimers.get(id)
  if (timer) {
    clearInterval(timer)
    progressTimers.delete(id)
  }
}

function clearRetryState(id) {
  retryCounters.delete(id)
  const timer = retryTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    retryTimers.delete(id)
  }
}

/** Called when OS reports network is back online — immediately retry any queued downloads waiting on backoff. */
export function onNetworkOnline() {
  if (paused) return
  let woke = false
  for (const [id, timer] of retryTimers) {
    clearTimeout(timer)
    retryTimers.delete(id)
    woke = true
  }
  if (woke) {
    console.log('Network online — resuming queued downloads')
    processQueue()
  }
}

async function postDownloadIntegrate(filename, fullPath, isDirect, hubResourceId, autoQueueDeps) {
  try {
    const cached = hubResourceId ? getCachedDetail(hubResourceId) : null
    const hubType = cached?.type?.trim() || null
    const hubDisplayName = cached?.title?.trim() || null

    const result = await scanAndUpsert(fullPath, {
      isDirect: isDirect ? 1 : 0,
      storageState: 'enabled',
      libraryDirId: null,
      typeOverride: hubType || undefined,
    })
    if (!result) return
    const { contentItems } = result

    if (hubDisplayName) setHubDisplayName(filename, hubDisplayName)
    if (hubResourceId) setHubResourceId(filename, String(hubResourceId))
    if (cached?.user_id) setHubUserId(filename, String(cached.user_id))
    if (cached?.tags || cached?.promotional_link) {
      setPackageHubMeta(filename, { tags: cached.tags, promotionalLink: cached.promotional_link })
    }

    // If dependency and auto-hide is enabled, hide content.
    // Suppress this package's stem so the watcher doesn't flood with events
    // for sidecars we're about to write (we rebuild prefs from disk after).
    const vamDir = getSetting('vam_dir')
    const autoHide = getSetting('auto_hide_deps')
    if (!isDirect && autoHide === '1' && vamDir) {
      const paths = contentItems.map((c) => c.internalPath)
      if (paths.length > 0) {
        const stem = filename.replace(/\.var$/i, '')
        suppressPrefsStem(stem)
        try {
          await hidePackageContent(vamDir, filename, paths)
        } finally {
          unsuppressPrefsStem(stem)
        }
      }
      const prefs = await readAllPrefs(vamDir)
      setPrefsMap(prefs)
    }

    // Build graph only (skip expensive aggregates) — we need packageIndex + deps
    // for cascade-enable, target-state lookup, and auto-queue-deps; full aggregates come at the end.
    buildGraphOnly()

    // Plan §"Dep install target": land at max(storage_state) of installed dependents.
    // The file is currently 'enabled' in main; relocate iff a less-active state satisfies all dependents.
    let landingState = 'enabled'
    try {
      const dependents = getReverseDeps().get(filename) || null
      const parsed = parseDisableBehavior(getSetting('disable_behavior'))
      const target = computeInstallTarget({
        dependents,
        packageIndex: getPackageIndex(),
        disableBehaviorTargetId: parsed.kind === 'move-to' ? parsed.auxDirId : null,
      })
      if (target) {
        await applyStorageState(filename, target)
        landingState = target.storageState
      }
    } catch (err) {
      console.warn(`Install-target relocation failed for ${filename}:`, err.message)
    }

    // Cascade-enable forward deps only when the new package itself ends up active.
    // An offloaded/disabled new package doesn't require its forward deps to be enabled.
    if (landingState === 'enabled') {
      const cascadeEnable = computeCascadeEnable(filename, getPackageIndex(), getForwardDeps())
      for (const depFn of cascadeEnable) {
        try {
          await applyStorageState(depFn, { storageState: 'enabled', libraryDirId: null })
        } catch (err) {
          console.warn(`Cascade-enable after install failed for ${depFn}:`, err.message)
        }
      }
    }

    // Discover and queue transitive deps if auto_queue_deps is set
    if (autoQueueDeps) {
      const newFwd = getForwardDeps().get(filename) || []
      const missing = newFwd
        .filter((d) => !d.resolved)
        .map((d) => d.ref)
        .filter(Boolean)

      // Build a set of base package names already queued/active so flexible refs
      // (.latest, .minN) don't cause redundant lookups when a resolved version is
      // already downloading.
      const queuedBaseNames = new Set()
      for (const d of getAllDownloads()) {
        if (d.status === 'queued' || d.status === 'active') {
          const parsed = parseDepRef(d.package_ref.replace(/\.var$/i, ''))
          if (parsed) queuedBaseNames.add(parsed.packageName)
        }
      }

      const trulyMissing = missing.filter((ref) => {
        if (pendingDepLookups.has(ref)) return false
        const fn = ensureVarExt(ref) || ref
        if (findLocalByFilename(fn) || getDownloadByRef(fn)) return false
        const parsed = parseDepRef(ref)
        if (isFlexibleRef(parsed) && queuedBaseNames.has(parsed.packageName)) return false
        return true
      })
      if (trulyMissing.length > 0) {
        for (const ref of trulyMissing) pendingDepLookups.add(ref)
        // Propagate root parent so aggregate progress bars count transitive deps
        const selfEntry = getDownloadByRef(filename)
        const rootParentRef = selfEntry?.parent_ref || filename
        try {
          const hubResults = await findPackages([...new Set(trulyMissing)])
          for (const hubFile of Object.values(hubResults)) {
            const depFn = ensureVarExt(hubFile?.filename)
            if (!depFn || findLocalByFilename(depFn)) continue
            const existing = getDownloadByRef(depFn)
            if (existing && (existing.status === 'queued' || existing.status === 'active')) continue
            const url = resolveDownloadUrl(hubFile)
            if (!url) continue
            if (existing) deleteDownload(existing.id)
            insertDownload({
              packageRef: depFn,
              hubResourceId: hubFile.resource_id ? String(hubFile.resource_id) : null,
              downloadUrl: url,
              fileSize: parseInt(hubFile.file_size || '0', 10) || null,
              priority: 'dependency',
              parentRef: rootParentRef,
              displayName: null,
              autoQueueDeps: 1,
            })
          }
          emitUpdated()
          processQueue()
        } catch (err) {
          console.warn('Transitive dep discovery failed:', err.message)
        } finally {
          for (const ref of trulyMissing) pendingDepLookups.delete(ref)
        }
      }
    }

    // Single full aggregate rebuild (reuses graph from buildGraphOnly above)
    buildFromDb({ skipGraph: true })

    notify('packages:updated')
    notify('contents:updated')
    resolvePackageThumbnails()
  } catch (err) {
    console.warn(`Post-download integration failed for ${filename}:`, err.message)
  }
}
