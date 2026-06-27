import { createWriteStream } from 'fs'
import { ipcMain, net, session } from 'electron'
import { access, rename, unlink } from 'fs/promises'
import { dirname, join } from 'path'
import { HUB_HTTP_USER_AGENT } from '@shared/hub-http.js'
import {
  setPackageDirect,
  deletePackage,
  getSetting,
  setPackageTypeOverride,
  setPackageCorrupted,
  setHubResourceId,
  applyHubDetailToPackage,
} from '../db.js'
import { scanAndUpsert } from '../scanner/ingest.js'
import { readVar } from '../scanner/var-reader.js'
import { verifyPackageFull } from '../scanner/integrity.js'
import {
  getFilteredPackages,
  getPackageDetail,
  getPackageIndex,
  getGroupIndex,
  getStats,
  getStatusCounts,
  getTypeCounts,
  getTagCounts,
  getAuthorCounts,
  getForwardDeps,
  getReverseDeps,
  getOrphanSet,
  getMissingDeps,
  setPrefsMap,
  buildFromDb,
  patchTypeOverride,
  getFilteredContents,
  isNotDownloadable,
} from '../store.js'
import { hidePackageContent, unhidePackageContent, readAllPrefs } from '../vam-prefs.js'
import { computeRemovableDeps, computeCascadeDisable, computeCascadeEnable } from '../scanner/graph.js'
import { applyStorageState, parseDisableBehavior, nextStorageStateForIntent } from '../storage-state.js'
import { pkgVarPath, getMainLibraryDirPath } from '../library-dirs.js'
import {
  enqueueInstall,
  enqueueInstallMissing,
  enqueueInstallAllMissing,
  enqueueInstallRef,
  enqueueInstallBatch,
} from '../downloads/manager.js'
import {
  fetchPackagesJson,
  getPackagesIndex,
  getPackagesFilenameIndex,
  checkUpdatesFromIndex,
  getPackagesIndexAge,
} from '../hub/packages-json.js'
import { notify } from '../notify.js'
import { recordOwnedPath, withBulkWindow } from '../watcher.js'
import { pLimit } from '../p-limit.js'
import { getResourceDetail, findPackages } from '../hub/client.js'
import { cacheAvatarsFromResources } from '../avatar-cache.js'
import { resolvePackageThumbnails } from '../thumb-resolver.js'
import { VISIBLE_CATEGORIES } from '@shared/content-types.js'

/** Matches libuv FS worker pool default (`UV_THREADPOOL_SIZE`); renames are pure fs ops. */
const RENAME_CONCURRENCY = 4

/** Throttle for mid-batch `packages:updated` progress notifies during multi-root toggle/set-enabled. */
const TOGGLE_PROGRESS_NOTIFY_MS = 500

const ALLOWED_PACKAGE_TYPE_OVERRIDES = new Set([...VISIBLE_CATEGORIES, 'Other'])

function normalizeFilenameArgs(arg) {
  return Array.isArray(arg) ? arg : [arg]
}

/**
 * Record-as-owned + unlink the indexed physical file plus any stray main-dir
 * aliases (`<fn>` and `<fn>.disabled` in main) external tools may have left
 * around. Each path is unlinked at most once. Caller is responsible for
 * `deletePackage`. Effective only when caller wraps in `withBulkWindow`;
 * single non-bulk uninstalls accept the watcher event (idempotent).
 */
async function unlinkPackagePhysicalAndAliases(pkg, filename) {
  const physical = pkg ? pkgVarPath(pkg) : null
  const mainDir = getMainLibraryDirPath()
  const targets = [physical]
  if (mainDir) targets.push(join(mainDir, filename), join(mainDir, filename + '.disabled'))
  const seen = new Set()
  for (const p of targets) {
    if (!p || seen.has(p)) continue
    seen.add(p)
    recordOwnedPath(p)
    try {
      await unlink(p)
    } catch {}
  }
}

/**
 * Shared worker for `packages:toggle-enabled` and `packages:set-enabled`. The
 * caller supplies `intentFn(pkg)` returning `'enable' | 'disable'`; for each
 * filename we resolve the resulting storage_state target via the
 * `nextStorageStateForIntent` matrix (which encodes "no-op when already at
 * the target end of the spectrum"), apply it via `applyStorageState`, and
 * cascade through `computeCascadeEnable / computeCascadeDisable` according
 * to the same intent. The `disable_behavior` setting decides whether disable
 * means `.var.disabled` in main or move-to-aux.
 *
 * Returns the same shape on toggle and set-enabled so the renderer doesn't
 * branch: `{ ok, filename?, storageState?, cascadeCount?, unchanged?, error? }` per
 * filename, wrapped in the standard single/array envelope.
 *
 * Root rename failures yield `{ ok: false, filename, error }` and do not abort
 * remaining filenames in the batch. Cascade renames run in parallel (bounded by
 * `RENAME_CONCURRENCY`) only after the root rename succeeds. Cascade-member
 * failures still log + continue.
 *
 * Does not emit `contents:updated`: storage-state toggles don't change content
 * prefs (`hidden`/`favorite`), and content rows reference their package via
 * `c.package` on the renderer — `useLibraryStore.fetchPackages` triggers a
 * `useContentStore.relink()` after refetch, refreshing the package fields any
 * content view reads (e.g. disabled badge dim) without a `contents:list` IPC.
 *
 * For multi-root batches a `packages:updated` notify is emitted after each root completes,
 * throttled to `TOGGLE_PROGRESS_NOTIFY_MS`. The renderer's `packagesFetchInFlight` gate
 * coalesces bursts, so the throttle is a soft floor on refetch frequency rather than a
 * hard cap. A final notify always fires on completion.
 */
async function applyStorageStateChange(filenames, intentFn) {
  if (!getSetting('vam_dir')) throw new Error('VaM directory not configured')
  const parsedBehavior = parseDisableBehavior(getSetting('disable_behavior'))
  const disableTarget =
    parsedBehavior.kind === 'move-to'
      ? { storageState: 'offloaded', libraryDirId: parsedBehavior.auxDirId }
      : { storageState: 'disabled', libraryDirId: null }

  // Wrap the whole bulk in a watcher window so the ~hundreds of fs.rename's
  // we're about to fire don't get interpreted as external changes (each rename
  // is recorded via recordOwnedPath inside applyStorageState). Single-toggle
  // case still works — the window is cheap when there's only one rename in it.
  return withBulkWindow(async () => {
    const out = []
    let lastProgressEmit = 0
    const emitProgressIfDue = () => {
      if (filenames.length <= 1) return
      const now = Date.now()
      if (now - lastProgressEmit < TOGGLE_PROGRESS_NOTIFY_MS) return
      lastProgressEmit = now
      notify('packages:updated')
    }
    for (const filename of filenames) {
      const pkg = getPackageIndex().get(filename)
      if (!pkg) {
        out.push({ ok: false, filename, error: `Package not found: ${filename}` })
        continue
      }

      const intent = intentFn(pkg)
      const target = nextStorageStateForIntent({ current: pkg.storage_state, intent, disableTarget })
      if (!target) {
        out.push({
          ok: true,
          filename,
          storageState: pkg.storage_state,
          cascadeCount: 0,
          unchanged: true,
        })
        continue
      }

      const cascadeSet =
        intent === 'enable'
          ? computeCascadeEnable(filename, getPackageIndex(), getForwardDeps())
          : computeCascadeDisable(filename, getPackageIndex(), getForwardDeps(), getReverseDeps())

      try {
        await applyStorageState(filename, target)
      } catch (err) {
        out.push({ ok: false, filename, error: err.message })
        continue
      }

      const limit = pLimit(RENAME_CONCURRENCY)
      await Promise.all(
        [...cascadeSet].map((depFilename) =>
          limit(async () => {
            const depPkg = getPackageIndex().get(depFilename)
            if (!depPkg) return
            const depTarget = nextStorageStateForIntent({ current: depPkg.storage_state, intent, disableTarget })
            if (!depTarget) return
            try {
              await applyStorageState(depFilename, depTarget)
            } catch (err) {
              console.warn(`Cascade ${intent} failed for ${depFilename}:`, err.message)
            }
          }),
        ),
      )

      out.push({
        ok: true,
        filename,
        storageState: target.storageState,
        cascadeCount: cascadeSet.size,
      })
      emitProgressIfDue()
    }

    notify('packages:updated')
    return filenames.length === 1 ? out[0] : { ok: true, results: out }
  })
}

export function registerPackageHandlers() {
  ipcMain.handle('packages:list', (_, filters) => {
    return getFilteredPackages(filters)
  })

  ipcMain.handle('packages:detail', (_, filename) => {
    return getPackageDetail(filename)
  })

  ipcMain.handle('packages:stats', () => {
    return getStats()
  })

  ipcMain.handle('packages:status-counts', () => {
    return getStatusCounts()
  })

  ipcMain.handle('packages:type-counts', () => {
    return getTypeCounts()
  })

  ipcMain.handle('packages:tag-counts', () => {
    return getTagCounts()
  })

  ipcMain.handle('packages:author-counts', () => {
    return getAuthorCounts()
  })

  ipcMain.handle('packages:install', async (_, { resourceId, hubDetail, autoQueueDeps, packageName, asDependency }) => {
    return await enqueueInstall(resourceId, hubDetail, autoQueueDeps !== false, packageName, !!asDependency)
  })

  ipcMain.handle('packages:install-missing', async (_, { filename, autoQueueDeps }) => {
    return await enqueueInstallMissing(filename, autoQueueDeps !== false)
  })

  ipcMain.handle('packages:promote', async (_, filenameOrFilenames, hubResourceId) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')

    const filenames = normalizeFilenameArgs(filenameOrFilenames)
    for (const filename of filenames) {
      setPackageDirect(filename, true)
      const contents = getFilteredContents({ packageFilename: filename })
      const paths = contents.map((c) => c.internalPath)
      await unhidePackageContent(vamDir, filename, paths)
    }
    const prefs = await readAllPrefs(vamDir)
    setPrefsMap(prefs)
    buildFromDb({ skipGraph: true })

    if (filenames.length === 1 && hubResourceId != null && String(hubResourceId).trim() !== '') {
      try {
        const detail = await getResourceDetail(String(hubResourceId))
        await cacheAvatarsFromResources([detail])
        notify('avatars:updated')
      } catch {}
    }

    notify('packages:updated')
    notify('contents:updated')
    return filenames.length === 1 ? { ok: true } : { ok: true, count: filenames.length }
  })

  ipcMain.handle('packages:setHubResource', async (_, filename, resourceId) => {
    const pkg = getPackageIndex().get(filename)
    if (!pkg) throw new Error(`Package not found: ${filename}`)
    const rid = String(resourceId ?? '').trim()
    if (!/^\d+$/.test(rid)) throw new Error('Invalid hub resource id')

    const detail = await getResourceDetail(rid)
    if (!detail?.resource_id || !detail?.title) throw new Error('No resource found for that id')

    setHubResourceId(filename, rid)
    applyHubDetailToPackage(filename, detail)
    buildFromDb({ skipGraph: true })

    try {
      await cacheAvatarsFromResources([detail])
      notify('avatars:updated')
    } catch {}

    notify('packages:updated')
    // Fetch the Hub thumbnail now that the package is linked; resolver emits
    // 'thumbnails:updated' so the card refreshes without waiting for a rescan.
    void resolvePackageThumbnails()
    return { ok: true, resourceId: rid }
  })

  ipcMain.handle('packages:uninstall', async (_, filenameOrFilenames) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    const filenames = normalizeFilenameArgs(filenameOrFilenames)
    return withBulkWindow(async () => {
      const results = []
      for (const filename of filenames) {
        const pkg = getPackageIndex().get(filename)
        if (!pkg) throw new Error(`Package not found: ${filename}`)

        const dependents = getReverseDeps().get(filename)
        if (dependents && dependents.size > 0) {
          setPackageDirect(filename, false)
          const contents = getFilteredContents({ packageFilename: filename })
          const paths = contents.map((c) => c.internalPath)
          await hidePackageContent(vamDir, filename, paths)
          const prefs = await readAllPrefs(vamDir)
          setPrefsMap(prefs)
          buildFromDb({ skipGraph: true })
          results.push({ ok: true, demoted: true })
          continue
        }

        const { removableFilenames } = computeRemovableDeps(
          filename,
          getPackageIndex(),
          getForwardDeps(),
          getReverseDeps(),
        )
        // Keep local-only deps (not available on Hub) as orphans instead of auto-deleting
        const filteredRemovable = [...removableFilenames].filter((fn) => {
          const depPkg = getPackageIndex().get(fn)
          return !depPkg || !isNotDownloadable(depPkg)
        })
        const toDelete = [filename, ...filteredRemovable]
        for (const fn of toDelete) {
          await unlinkPackagePhysicalAndAliases(getPackageIndex().get(fn), fn)
          deletePackage(fn)
        }
        buildFromDb()
        results.push({ ok: true, deleted: toDelete.length })
      }

      notify('packages:updated')
      notify('contents:updated')
      if (filenames.length === 1) return results[0]
      return { ok: true, results }
    })
  })

  ipcMain.handle('packages:set-type-override', (_, payload) => {
    const { filename, typeOverride, filenames: filenamesField } = payload
    const filenames = filenamesField?.length ? filenamesField : filename != null ? normalizeFilenameArgs(filename) : []
    if (filenames.length === 0) throw new Error('Package not found')
    if (typeOverride != null && !ALLOWED_PACKAGE_TYPE_OVERRIDES.has(typeOverride)) {
      throw new Error('Invalid package type')
    }
    for (const fn of filenames) {
      const pkg = getPackageIndex().get(fn)
      if (!pkg) throw new Error(`Package not found: ${fn}`)
      setPackageTypeOverride(fn, typeOverride)
      patchTypeOverride(fn, typeOverride)
    }
    notify('packages:updated')
    return { ok: true, count: filenames.length }
  })

  ipcMain.handle('packages:toggle-enabled', async (_, filenameOrFilenames) => {
    return await applyStorageStateChange(normalizeFilenameArgs(filenameOrFilenames), (pkg) =>
      pkg.storage_state === 'enabled' ? 'disable' : 'enable',
    )
  })

  // Explicit-target setter (used by labels' "enable matching" bulk action). Maps
  // boolean → intent so the same nextStorageStateForIntent matrix decides per
  // package whether it's a no-op (already at that end of the spectrum) or a
  // real move (e.g. enabling an offloaded pkg moves it back to main).
  ipcMain.handle('packages:set-enabled', async (_, { filenames, enabled }) => {
    const intent = enabled ? 'enable' : 'disable'
    return await applyStorageStateChange(normalizeFilenameArgs(filenames), () => intent)
  })

  ipcMain.handle('packages:force-remove', async (_, filenameOrFilenames) => {
    const filenames = normalizeFilenameArgs(filenameOrFilenames)
    return withBulkWindow(async () => {
      for (const filename of filenames) {
        await unlinkPackagePhysicalAndAliases(getPackageIndex().get(filename), filename)
        deletePackage(filename)
      }
      buildFromDb()
      notify('packages:updated')
      notify('contents:updated')
      return filenames.length === 1 ? { ok: true } : { ok: true, count: filenames.length }
    })
  })

  ipcMain.handle('packages:missing-deps', async () => {
    // Ensure packages.json is loaded (same stale logic as check-updates)
    const STALE_MS = 5 * 60 * 1000
    if (!getPackagesIndex() || getPackagesIndexAge() > STALE_MS) {
      try {
        await fetchPackagesJson()
      } catch (err) {
        console.warn('[missing-deps] Failed to fetch packages.json:', err.message)
      }
    }
    return getMissingDeps(getPackagesIndex(), getPackagesFilenameIndex())
  })

  ipcMain.handle('packages:enrich-from-hub', async (_, packageStems) => {
    if (!packageStems?.length) return {}
    const results = await findPackages(packageStems)
    const enriched = {}
    const isReal = (v) => v && v !== 'null'
    // Seed a null placeholder for every requested stem so callers can distinguish
    // "not on Hub / no URL" (null) from "enrichment hasn't returned yet" (undefined).
    // Without this, a stem missing from `results` would leave downloadUrl undefined
    // on the caller side, causing the UI to offer Install for something the Hub
    // can't actually serve, and the install IPC then fails with "No download URL".
    for (const stem of packageStems) enriched[stem] = { fileSize: null, downloadUrl: null }
    for (const [stem, hubFile] of Object.entries(results)) {
      const url = isReal(hubFile.downloadUrl)
        ? hubFile.downloadUrl
        : isReal(hubFile.urlHosted)
          ? hubFile.urlHosted
          : null
      enriched[stem] = {
        fileSize: isReal(hubFile.file_size) ? parseInt(hubFile.file_size, 10) || null : null,
        downloadUrl: url,
      }
    }
    return enriched
  })

  ipcMain.handle('packages:remove-orphans', async () => {
    const orphans = getOrphanSet()
    if (orphans.size === 0) return { ok: true, count: 0, freedBytes: 0 }

    return withBulkWindow(async () => {
      let freedBytes = 0
      for (const fn of orphans) {
        const pkg = getPackageIndex().get(fn)
        if (pkg) freedBytes += pkg.size_bytes
        await unlinkPackagePhysicalAndAliases(pkg, fn)
        deletePackage(fn)
      }

      buildFromDb()
      notify('packages:updated')
      notify('contents:updated')
      return { ok: true, count: orphans.size, freedBytes }
    })
  })

  ipcMain.handle('packages:install-all-missing', async () => {
    return await enqueueInstallAllMissing()
  })

  ipcMain.handle('packages:install-deps-batch', async (_, { items, autoQueueDeps }) => {
    return await enqueueInstallBatch(items, autoQueueDeps !== false)
  })

  ipcMain.handle('packages:install-dep', async (_, hubFileData) => {
    return await enqueueInstallRef(hubFileData)
  })

  ipcMain.handle('packages:file-list', async (_, filename) => {
    const pkg = getPackageIndex().get(filename)
    if (!pkg) throw new Error(`Package not found: ${filename}`)
    const varPath = pkgVarPath(pkg)
    if (!varPath) throw new Error('Library directory not configured')
    await access(varPath)
    const { fileList } = await readVar(varPath)
    return { fileList, varPath }
  })

  ipcMain.handle('packages:check-updates', async (_, { forceRefresh } = {}) => {
    // Fetch or refresh the CDN packages index
    const STALE_MS = 5 * 60 * 1000
    if (!getPackagesIndex() || forceRefresh || getPackagesIndexAge() > STALE_MS) {
      try {
        await fetchPackagesJson({ force: !!forceRefresh })
      } catch (err) {
        console.warn('[check-updates] Failed to fetch packages.json:', err.message)
        if (!getPackagesIndex()) return {}
      }
    }

    return checkUpdatesFromIndex(getPackageIndex(), getGroupIndex(), getForwardDeps()) ?? {}
  })

  ipcMain.handle('packages:redownload', async (_, filename) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    const pkg = getPackageIndex().get(filename)
    if (!pkg) throw new Error('Package not found')
    const finalPath = pkgVarPath(pkg)
    if (!finalPath) throw new Error('Library directory not configured for this package')
    const targetDir = dirname(finalPath)

    let downloadUrl = null
    let hubResourceId = pkg.hub_resource_id

    // Resolve download URL via Hub
    if (hubResourceId) {
      try {
        const detail = await getResourceDetail(hubResourceId)
        const file = (detail?.hubFiles || []).find((f) => {
          const fn = f.filename?.endsWith('.var') ? f.filename : f.filename + '.var'
          return fn === filename
        })
        downloadUrl = file?.downloadUrl || file?.urlHosted || null
        if (!downloadUrl && detail?.hubFiles?.[0]) {
          downloadUrl = detail.hubFiles[0].downloadUrl || detail.hubFiles[0].urlHosted || null
        }
      } catch {}
    }

    if (!downloadUrl) {
      try {
        const results = await findPackages([filename.replace(/\.var$/i, '')])
        const hubFile = Object.values(results)[0]
        if (hubFile) {
          downloadUrl = hubFile.downloadUrl || hubFile.urlHosted || null
          if (!hubResourceId && hubFile.resource_id) hubResourceId = String(hubFile.resource_id)
        }
      } catch {}
    }

    if (!downloadUrl) throw new Error('Could not resolve download URL from Hub')

    const tempPath = join(targetDir, filename + '.redownload.tmp')

    try {
      const hubSession = session.fromPartition('persist:hub')
      const cookies = await hubSession.cookies.get({ url: 'https://hub.virtamate.com' })
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

      const res = await net.fetch(downloadUrl, {
        headers: { 'User-Agent': HUB_HTTP_USER_AGENT, Cookie: cookieHeader },
        redirect: 'follow',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)

      const fileStream = createWriteStream(tempPath)
      const fileError = new Promise((_, reject) => fileStream.on('error', reject))
      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!fileStream.write(value)) {
          await new Promise((r) => fileStream.once('drain', r))
        }
      }
      await Promise.race([new Promise((resolve) => fileStream.end(() => resolve())), fileError])

      // Verify the newly downloaded file
      await verifyPackageFull(tempPath)

      // Replace the old file (unlink indexed path and any stray main-dir aliases, then write temp → final).
      // Wrap in a watcher window so the unlink-then-rename pair is treated as one app-coordinated change.
      await withBulkWindow(async () => {
        await unlinkPackagePhysicalAndAliases(pkg, filename)
        recordOwnedPath(finalPath)
        await rename(tempPath, finalPath)
      })

      // Clear corrupted flag and re-scan the package
      setPackageCorrupted(filename, false)
      try {
        await scanAndUpsert(finalPath, {
          isDirect: pkg.is_direct ? 1 : 0,
          storageState: pkg.storage_state,
          libraryDirId: pkg.library_dir_id ?? null,
          subpath: pkg.subpath ?? '',
        })
      } catch (err) {
        console.warn(`Post-redownload rescan failed for ${filename}:`, err.message)
      }

      buildFromDb()
      notify('packages:updated')
      notify('contents:updated')
      return { ok: true }
    } catch (err) {
      try {
        await unlink(tempPath)
      } catch {}
      throw err
    }
  })
}
