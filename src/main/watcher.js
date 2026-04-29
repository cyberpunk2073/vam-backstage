import { watch } from 'fs'
import chokidar from 'chokidar'
import { join, extname, basename, relative, sep, dirname } from 'path'
import { stat, mkdir, rename, unlink } from 'fs/promises'
import { ADDON_PACKAGES_FILE_PREFS } from '../shared/paths.js'
import { LOCAL_PACKAGE_FILENAME, LOCAL_CONTENT_ROOTS } from '../shared/local-package.js'
import { isVarFilename, canonicalVarFilename } from './scanner/var-reader.js'
import { scanAndUpsert } from './scanner/ingest.js'
import { runLocalScan } from './scanner/local.js'
import { deletePackage, getPackageCacheInfo, setStorageState } from './db.js'
import { buildFromDb, getPrefsMap, setPrefsMap, getPackageIndex, getForwardDeps } from './store.js'
import { computeCascadeEnable } from './scanner/graph.js'
import { notify } from './notify.js'
import { enrichNewPackages } from './hub/scanner.js'
import { getAllLibraryDirs, refreshLibraryDirs } from './library-dirs.js'
import { applyStorageState } from './storage-state.js'

const DEBOUNCE_MS = 500

let packageWatcher = null
let prefsWatcher = null
let localWatcher = null
let prefsDirPath = null
let vamDirPath = null
/** Map<fullPath, { type, libraryDirId }> */
let pendingPackageEvents = new Map() // fullPath -> 'add'|'change'|'unlink'
let pendingPrefsEvents = new Map() // fullPath -> 'check'
let pendingLocalContent = false
let pendingLocalPrefs = new Map() // fullPath -> 'check'
let debounceTimer = null
let processing = false

// Paths the app itself is about to write — watcher should ignore these
const suppressedPaths = new Set()
const SUPPRESS_TTL_MS = 5000

// Package stems whose prefs sidecar events should be temporarily ignored
// (used during bulk writes where the caller rebuilds prefs from disk after)
const suppressedStems = new Set()

export function suppressPath(path) {
  suppressedPaths.add(path)
  setTimeout(() => suppressedPaths.delete(path), SUPPRESS_TTL_MS)
}

export function suppressPrefsStem(stem) {
  suppressedStems.add(stem)
}

export function unsuppressPrefsStem(stem) {
  suppressedStems.delete(stem)
}

/** Restart the package watcher with the current library_dirs registry. Idempotent.
 * Aux dirs that aren't currently reachable (unmounted drive, etc.) are skipped so
 * chokidar doesn't spam errors; they'll be picked up on the next restart after the
 * dir comes back online (any successful scan or library-dirs change retriggers this). */
export async function restartPackageWatcher() {
  refreshLibraryDirs()
  const allDirs = getAllLibraryDirs().filter((d) => !!d.path)
  const dirs = []
  for (const d of allDirs) {
    try {
      const s = await stat(d.path)
      if (s.isDirectory()) dirs.push(d)
    } catch {
      console.warn(`[watcher] Skipping unreachable library dir: ${d.path}`)
    }
  }
  if (packageWatcher) {
    await packageWatcher.close().catch(() => {})
    packageWatcher = null
  }
  if (dirs.length === 0) return

  const packageWatcherT0 = Date.now()
  packageWatcher = chokidar.watch(
    dirs.map((d) => d.path),
    {
      ignoreInitial: true,
      depth: 10,
      // Some VaM plugins (e.g. JayJayWon's BrowserAssist) drop directory symlinks under
      // Saves/PluginData/.../SymLinks pointing back at AddonPackages, AddonPackagesFilePrefs,
      // Custom, etc. Following them would have chokidar enumerate the 60k+ FilePrefs tree
      // (the very thing prefsWatcher uses native fs.watch for), pinning libuv for ~100s.
      // Equally critical for aux dirs on remote/network shares where symlinks are common.
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 300 },
    },
  )

  // Build prefix → id map for path-to-libraryDirId classification
  const prefixes = dirs
    .map((d) => ({ id: d.id, prefix: d.path.replace(/[\\/]+$/, '') + sep }))
    .sort((a, b) => b.prefix.length - a.prefix.length) // longest match first
  const classify = (p) => {
    for (const { id, prefix } of prefixes) {
      if (p === prefix.slice(0, -1) || p.startsWith(prefix)) return id
    }
    return null
  }

  packageWatcher
    .on('add', (p) => onPackageEvent(p, 'add', classify(p)))
    .on('change', (p) => onPackageEvent(p, 'change', classify(p)))
    .on('unlink', (p) => onPackageEvent(p, 'unlink', classify(p)))
    .on('error', (err) => console.warn('Package watcher error:', err.message))
    .on('ready', () => {
      const watched = packageWatcher.getWatched()
      let files = 0
      for (const arr of Object.values(watched)) files += arr.length
      const watchedDirs = Object.keys(watched).length
      console.info(
        `FS watcher 'packageWatcher' ready in ${Date.now() - packageWatcherT0} ms ` +
          `(${files} files / ${watchedDirs} dirs across ${dirs.length} library root(s))`,
      )
    })
}

export async function startWatcher(vamDir) {
  vamDirPath = vamDir

  await restartPackageWatcher()

  const prefsDir = join(vamDir, ADDON_PACKAGES_FILE_PREFS)
  // Ensure prefs dir exists before the prefs watcher attaches
  await mkdir(prefsDir, { recursive: true }).catch(() => {})
  initPrefsWatcher(prefsDir)
  initLocalWatcher(vamDir)
}

/**
 * Watch loose-content roots (`Saves/`, `Custom/`) for both content changes and
 * sibling `.hide`/`.fav` sidecars. Content files trigger a debounced
 * `runLocalScan()` to reconcile the `__local__`-owned `contents` rows; sidecar
 * files update the in-memory prefs map directly so the UI flips without a
 * full rescan.
 */
function initLocalWatcher(vamDir) {
  if (localWatcher) {
    localWatcher.close()
    localWatcher = null
  }
  const roots = LOCAL_CONTENT_ROOTS.map((r) => join(vamDir, r))
  const localWatcherT0 = Date.now()
  localWatcher = chokidar.watch(roots, {
    ignoreInitial: true,
    depth: 20,
    // See packageWatcher comment — same reasoning, more critical here because Saves/
    // is exactly where BrowserAssist drops the symlink farm.
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  })
  localWatcher
    .on('add', (p) => onLocalEvent(p))
    .on('change', (p) => onLocalEvent(p))
    .on('unlink', (p) => onLocalEvent(p))
    .on('error', (err) => console.warn('Local watcher error:', err.message))
    .on('ready', () => {
      const watched = localWatcher.getWatched()
      let files = 0
      for (const arr of Object.values(watched)) files += arr.length
      const dirs = Object.keys(watched).length
      console.info(
        `FS watcher 'localWatcher' ready in ${Date.now() - localWatcherT0} ms (${files} files / ${dirs} dirs)`,
      )
    })
}

function onLocalEvent(fullPath) {
  if (suppressedPaths.delete(fullPath)) return
  const ext = extname(fullPath).toLowerCase()
  if (ext === '.hide' || ext === '.fav') {
    pendingLocalPrefs.set(fullPath, 'check')
    scheduleBatch()
    return
  }
  pendingLocalContent = true
  scheduleBatch()
}

function initPrefsWatcher(prefsDir) {
  if (prefsWatcher) {
    prefsWatcher.close()
    prefsWatcher = null
  }
  prefsDirPath = prefsDir
  try {
    prefsWatcher = watch(prefsDir, { recursive: true }, (_eventType, filename) => {
      if (filename) onPrefsEvent(filename)
    })
    prefsWatcher.on('error', (err) => {
      console.warn('Prefs watcher error:', err.message)
      if (err.code === 'EMFILE' || err.code === 'ENFILE') {
        setTimeout(() => initPrefsWatcher(prefsDir), 3000)
      }
    })
  } catch (err) {
    console.warn('Failed to start prefs watcher:', err.message)
  }
}

export function stopWatcher() {
  if (packageWatcher) {
    packageWatcher.close()
    packageWatcher = null
  }
  if (prefsWatcher) {
    prefsWatcher.close()
    prefsWatcher = null
  }
  if (localWatcher) {
    localWatcher.close()
    localWatcher = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pendingPackageEvents.clear()
  pendingPrefsEvents.clear()
  pendingLocalPrefs.clear()
  pendingLocalContent = false
  vamDirPath = null
}

function onPackageEvent(path, type, libraryDirId) {
  if (!isVarFilename(basename(path))) return
  if (suppressedPaths.delete(path)) return
  pendingPackageEvents.set(path, { type, libraryDirId })
  scheduleBatch()
}

function onPrefsEvent(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/')
  const ext = extname(normalized).toLowerCase()
  if (ext !== '.hide' && ext !== '.fav') return

  const segments = normalized.split('/')
  if (segments.length < 2) return
  if (suppressedStems.has(segments[0])) return

  const fullPath = join(prefsDirPath, relativePath)
  if (suppressedPaths.delete(fullPath)) return

  pendingPrefsEvents.set(fullPath, 'check')
  scheduleBatch()
}

function scheduleBatch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(processBatch, DEBOUNCE_MS)
}

/**
 * Compute the storage state implied by a single observed event's path + libraryDirId.
 * Aux dirs always imply 'offloaded'; main dir branches on .disabled. (Aux-dir `.var.disabled`
 * files are normalized to bare `.var` before reaching this function — see `processBatch`.)
 */
function inferStorageState({ libraryDirId, isDisabled }) {
  if (libraryDirId != null) return 'offloaded'
  return isDisabled ? 'disabled' : 'enabled'
}

/**
 * Normalize a stray `.var.disabled` in an aux dir to bare `.var`. Aux dirs only ever
 * hold suffix-less files in our model — anything `.disabled` there came from external
 * tooling. Suppresses both source and dest paths so the rename/unlink is silent.
 *
 * Returns the bare path on successful rename, or `null` if:
 *   - a bare sibling already exists (we drop or refuse the duplicate),
 *   - the rename itself fails (permissions, mid-flight unlink, etc.).
 *
 * Callers should treat null as "skip this file" — caller-side behavior is identical
 * for the watcher (skip the add event) and the scanner (skip the index entry).
 */
export async function normalizeAuxDisabled(fullPath) {
  const dir = dirname(fullPath)
  const name = basename(fullPath)
  const canonical = canonicalVarFilename(name)
  const bare = join(dir, canonical)
  suppressPath(fullPath)
  suppressPath(bare)
  let bareStat = null
  try {
    bareStat = await stat(bare)
  } catch {}
  if (bareStat) {
    try {
      const disabledStat = await stat(fullPath)
      if (disabledStat.size === bareStat.size) {
        try {
          await unlink(fullPath)
        } catch {}
      } else {
        console.warn(
          `[normalizeAuxDisabled] Refusing to remove ${fullPath}: bare sibling exists with different size ` +
            `(${disabledStat.size} vs ${bareStat.size}). Leaving both in place.`,
        )
      }
    } catch {}
    return null
  }
  try {
    await rename(fullPath, bare)
    return bare
  } catch (err) {
    console.warn(`[normalizeAuxDisabled] Could not normalize ${fullPath} -> ${bare}: ${err.message}`)
    return null
  }
}

async function processBatch() {
  if (processing) {
    scheduleBatch() // reschedule if already processing
    return
  }
  processing = true

  const pkgEvents = new Map(pendingPackageEvents)
  const prefsEvents = new Map(pendingPrefsEvents)
  const localPrefsEvents = new Map(pendingLocalPrefs)
  const localContentChanged = pendingLocalContent
  pendingPackageEvents.clear()
  pendingPrefsEvents.clear()
  pendingLocalPrefs.clear()
  pendingLocalContent = false

  let packagesChanged = false
  let contentsChanged = false
  const newlyScannedEnabled = [] // enabled filenames that were freshly added/changed

  // --- Package events ---
  if (pkgEvents.size > 0) {
    // Normalize any aux-dir `.var.disabled` adds/changes to bare `.var` before grouping.
    // We mutate event paths in-place; the rename suppresses its own follow-up events.
    const normalized = []
    for (const [fullPath, ev] of pkgEvents) {
      const name = basename(fullPath)
      const isDisabled = /\.disabled$/i.test(name)
      if (ev.libraryDirId != null && isDisabled && ev.type !== 'unlink') {
        const newPath = await normalizeAuxDisabled(fullPath)
        if (!newPath) continue // unlinked redundant copy or rename failed
        normalized.push([newPath, ev])
      } else {
        normalized.push([fullPath, ev])
      }
    }

    const byCanonical = new Map()
    for (const [fullPath, { type, libraryDirId }] of normalized) {
      const name = basename(fullPath)
      const isDisabled = /\.disabled$/i.test(name)
      const canonical = isDisabled ? canonicalVarFilename(name) : name
      if (!byCanonical.has(canonical)) byCanonical.set(canonical, [])
      byCanonical.get(canonical).push({ fullPath, type, isDisabled, libraryDirId })
    }

    const allDirs = getAllLibraryDirs()

    for (const [canonical, events] of byCanonical) {
      const adds = events.filter((e) => e.type !== 'unlink')
      const unlinks = events.filter((e) => e.type === 'unlink')

      // Unlinks: probe every registered dir for a sibling before deleting. When the
      // batch also has an add (cross-dir move within one batch), findElsewhere finds
      // the new location and updates state; the add is then a no-op because
      // scanSingleVar's cache check matches mtime+size against the now-current row.
      // No in-mem patch needed here — the trailing buildFromDb() reloads packageIndex
      // from DB whenever packagesChanged is set.
      if (unlinks.length > 0) {
        const altLocation = await findElsewhere(canonical, allDirs)
        if (altLocation) {
          setStorageState(canonical, altLocation.storageState, altLocation.libraryDirId)
          packagesChanged = true
        } else {
          deletePackage(canonical)
          packagesChanged = true
          contentsChanged = true
        }
      }

      // Adds/changes: install or in-place state flip via scanSingleVar.
      for (const { fullPath, type, isDisabled, libraryDirId } of adds) {
        const newState = inferStorageState({ libraryDirId, isDisabled })
        try {
          const changed = await scanSingleVar(fullPath, newState, libraryDirId)
          if (changed) {
            packagesChanged = true
            contentsChanged = true
            if (newState === 'enabled') newlyScannedEnabled.push(canonical)
          }
        } catch (err) {
          console.warn(`Watcher: ${type} failed for`, canonical, err.message)
          notify('scan:unreadable', { filename: canonical })
        }
      }
    }

    if (packagesChanged) buildFromDb()

    // Cascade-enable disabled/offloaded deps needed by newly enabled packages
    if (newlyScannedEnabled.length > 0) {
      const pkgIndex = getPackageIndex()
      const fwd = getForwardDeps()
      const allToEnable = new Set()
      for (const fn of newlyScannedEnabled) {
        for (const dep of computeCascadeEnable(fn, pkgIndex, fwd)) allToEnable.add(dep)
      }
      if (allToEnable.size > 0) {
        for (const depFn of allToEnable) {
          try {
            await applyStorageState(depFn, { storageState: 'enabled', libraryDirId: null })
          } catch (err) {
            console.warn(`Cascade-enable failed for ${depFn}:`, err.message)
          }
        }
      }
    }

    if (newlyScannedEnabled.length > 0) {
      enrichNewPackages(newlyScannedEnabled)
    }
  }

  // --- Prefs/sidecar events ---
  if (prefsEvents.size > 0) {
    const prefsDir = join(vamDirPath, ADDON_PACKAGES_FILE_PREFS)
    const prefsMap = getPrefsMap()

    for (const [fullPath] of prefsEvents) {
      try {
        const rel = relative(prefsDir, fullPath)
        const segments = rel.split(sep)
        if (segments.length < 2) continue

        const pkgStem = segments[0]
        const pkgFilename = pkgStem + '.var'
        const sidecarExt = extname(fullPath).toLowerCase()
        const contentRelPath = segments.slice(1).join('/')
        const internalPath = contentRelPath.slice(0, -sidecarExt.length)
        const key = pkgFilename + '/' + internalPath

        // fs.watch gives rename for both create and delete — stat to get current state
        let exists = false
        try {
          await stat(fullPath)
          exists = true
        } catch {}

        if (!prefsMap.has(key)) prefsMap.set(key, { hidden: false, favorite: false })
        const prefs = prefsMap.get(key)

        if (sidecarExt === '.hide') prefs.hidden = exists
        else if (sidecarExt === '.fav') prefs.favorite = exists
      } catch (err) {
        console.warn('Watcher: prefs event failed:', err.message)
      }
    }

    setPrefsMap(prefsMap)
    contentsChanged = true
  }

  // --- Local content events ---
  if (localContentChanged && vamDirPath) {
    try {
      const result = await runLocalScan(vamDirPath)
      if (result.added > 0 || result.removed > 0) contentsChanged = true
    } catch (err) {
      console.warn('Watcher: local scan failed:', err.message)
    }
  }

  // --- Local sibling sidecars ---
  if (localPrefsEvents.size > 0 && vamDirPath) {
    const prefsMap = getPrefsMap()
    for (const [fullPath] of localPrefsEvents) {
      try {
        const rel = relative(vamDirPath, fullPath).split(sep).join('/')
        const sidecarExt = extname(rel).toLowerCase()
        const internalPath = rel.slice(0, -sidecarExt.length)
        const key = LOCAL_PACKAGE_FILENAME + '/' + internalPath
        let exists = false
        try {
          await stat(fullPath)
          exists = true
        } catch {}
        if (!prefsMap.has(key)) prefsMap.set(key, { hidden: false, favorite: false })
        const prefs = prefsMap.get(key)
        if (sidecarExt === '.hide') prefs.hidden = exists
        else if (sidecarExt === '.fav') prefs.favorite = exists
      } catch (err) {
        console.warn('Watcher: local prefs event failed:', err.message)
      }
    }
    setPrefsMap(prefsMap)
    contentsChanged = true
  }

  if (localContentChanged) buildFromDb()

  // --- Notify renderer ---
  if (packagesChanged) notify('packages:updated')
  if (contentsChanged) notify('contents:updated')

  processing = false
}

/**
 * Probe every registered dir for the canonical filename. Aux dirs only accept the
 * suffix-less name (we normalize away `.disabled` in aux); main accepts both with
 * their respective enabled/disabled states. Returns the first match's location +
 * resolved storage_state.
 */
async function findElsewhere(canonical, dirs) {
  for (const { id, path: dirPath } of dirs) {
    if (!dirPath) continue
    const enabledPath = join(dirPath, canonical)
    try {
      await stat(enabledPath)
      return { libraryDirId: id, storageState: id == null ? 'enabled' : 'offloaded' }
    } catch {}
    if (id == null) {
      // Main dir: also probe the .disabled variant.
      try {
        await stat(enabledPath + '.disabled')
        return { libraryDirId: null, storageState: 'disabled' }
      } catch {}
    }
  }
  return null
}

async function scanSingleVar(fullPath, storageState, libraryDirId) {
  const filename = canonicalVarFilename(basename(fullPath))

  let s
  try {
    s = await stat(fullPath)
  } catch {
    return false
  }

  const mtime = s.mtimeMs / 1000
  const size = s.size

  const cached = getPackageCacheInfo(filename)
  if (cached && cached.file_mtime === mtime && cached.size_bytes === size) {
    if (cached.storage_state !== storageState || (cached.library_dir_id ?? null) !== (libraryDirId ?? null)) {
      setStorageState(filename, storageState, libraryDirId)
    }
    return false // no change
  }

  const result = await scanAndUpsert(fullPath, { storageState, libraryDirId, isDirect: 1 })
  return result != null
}
