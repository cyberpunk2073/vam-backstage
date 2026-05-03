import parcelWatcher from '@parcel/watcher'
import { join, extname, basename, relative, sep, dirname } from 'path'
import { stat, mkdir, rename, unlink } from 'fs/promises'
import { ADDON_PACKAGES_FILE_PREFS } from '@shared/paths.js'
import { LOCAL_PACKAGE_FILENAME, LOCAL_CONTENT_ROOTS } from '@shared/local-package.js'
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
import { awaitStable } from './var-stability.js'

const DEBOUNCE_MS = 500

/** @type {Array<{ sub: import('@parcel/watcher').AsyncSubscription, dirId: number|null, path: string }>} */
let packageSubs = []
/** @type {import('@parcel/watcher').AsyncSubscription | null} */
let prefsSub = null
/** @type {Array<import('@parcel/watcher').AsyncSubscription>} */
let localSubs = []
let prefsDirPath = null
let vamDirPath = null
/** Map<fullPath, { type, libraryDirId }> */
let pendingPackageEvents = new Map() // fullPath -> 'add'|'change'|'unlink'
let pendingPrefsEvents = new Map() // fullPath -> 'check'
let pendingLocalContent = false
let pendingLocalPrefs = new Map() // fullPath -> 'check'
let debounceTimer = null
let processing = false

/**
 * Bulk-window machinery: while a window is active, raw events are buffered
 * instead of dispatched, and any path the app touches (via `recordOwnedPath`)
 * is added to `ourPaths`. When the window closes, buffered events are drained
 * — those whose path is in `ourPaths` are dropped, the rest go through normal
 * routing.
 *
 * Rationale: chokidar required us to stop the watcher entirely during bulk
 * renames (its `awaitWriteFinish` poll on the libuv pool serialized our
 * renames to ~10x slowdown). With parcel there's no per-file polling, the
 * subscription stays live cheaply, so the bulk window can be a pure
 * userspace buffer-and-filter — no TTL, no restart race.
 *
 * @typedef {{ events: Array<import('@parcel/watcher').Event & { __source: 'package'|'prefs'|'local', __dirId?: number|null }>, ourPaths: Set<string> }} BulkWindow
 */
/** @type {BulkWindow | null} */
let bulkWindow = null
/** Refcount so concurrent (non-nested) callers keep the window alive until
 *  the *last* one exits. Without this, a short-lived caller's `finally` would
 *  drain mid-flight and a longer-lived peer's subsequent `recordOwnedPath`
 *  calls would silently no-op. We don't expect sustained overlap in practice
 *  (bulk ops are sub-second), so unbounded buffer growth isn't a real risk. */
let bulkDepth = 0

/**
 * Run `fn` inside a bulk window. While inside, any FS event observed by the
 * watchers is buffered; after the *last* concurrent caller's `fn` resolves,
 * buffered events whose path was registered via `recordOwnedPath` are
 * silently dropped, and the rest flow into the normal pending-event maps.
 *
 * Concurrent and nested callers share one window — `ourPaths` and the event
 * buffer are pooled. Returns the value of `fn`.
 */
export async function withBulkWindow(fn) {
  if (!bulkWindow) bulkWindow = { events: [], ourPaths: new Set() }
  const win = bulkWindow
  bulkDepth++
  try {
    return await fn(win.ourPaths)
  } finally {
    bulkDepth--
    if (bulkDepth === 0) {
      bulkWindow = null
      // Drain: external events route normally, app-owned events drop. Each
      // route* helper schedules its own batch (or, for package events, schedules
      // after its async stability check), so we don't have to here.
      for (const ev of win.events) {
        if (win.ourPaths.has(ev.path)) continue
        routeEvent(ev)
      }
    }
  }
}

/**
 * Mark a path as app-owned for the duration of the current bulk window. If
 * called outside a bulk window, this is a no-op — single non-bulk writes
 * accept the resulting watcher event because it's idempotent (scanSingleVar's
 * mtime+size cache check makes re-scans of unchanged files free).
 */
export function recordOwnedPath(p) {
  if (bulkWindow) bulkWindow.ourPaths.add(p)
}

/** Restart the package watcher with the current library_dirs registry. Idempotent.
 * Aux dirs that aren't currently reachable (unmounted drive, etc.) are skipped so
 * parcel doesn't fail; they'll be picked up on the next restart after the
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
  await Promise.all(packageSubs.map((s) => s.sub.unsubscribe().catch(() => {})))
  packageSubs = []
  if (dirs.length === 0) return

  const t0 = Date.now()
  const newSubs = []
  for (const d of dirs) {
    try {
      const sub = await parcelWatcher.subscribe(
        d.path,
        (err, events) => {
          if (err) {
            console.warn('Package watcher error:', err.message)
            return
          }
          for (const ev of events) onPackageRawEvent(ev, d.id)
        },
        // ignore: nothing — but parcel does NOT follow symlinks recursively, so the
        // BrowserAssist symlink-farm problem chokidar had with `followSymlinks: true`
        // doesn't apply here.
        {},
      )
      newSubs.push({ sub, dirId: d.id, path: d.path })
    } catch (err) {
      console.warn(`[watcher] Failed to subscribe to ${d.path}: ${err.message}`)
    }
  }
  packageSubs = newSubs
  console.info(
    `FS watcher 'packageWatcher' ready in ${Date.now() - t0} ms (${newSubs.length}/${dirs.length} library root(s))`,
  )
}

export async function startWatcher(vamDir) {
  vamDirPath = vamDir

  await restartPackageWatcher()

  const prefsDir = join(vamDir, ADDON_PACKAGES_FILE_PREFS)
  // Ensure prefs dir exists before the prefs watcher attaches
  await mkdir(prefsDir, { recursive: true }).catch(() => {})
  await initPrefsWatcher(prefsDir)
  await initLocalWatcher(vamDir)
}

/**
 * Watch loose-content roots (`Saves/`, `Custom/`) for both content changes and
 * sibling `.hide`/`.fav` sidecars. Content files trigger a debounced
 * `runLocalScan()` to reconcile the `__local__`-owned `contents` rows; sidecar
 * files update the in-memory prefs map directly so the UI flips without a
 * full rescan.
 *
 * Implementation note: parcel's `subscribe` watches one root, so we wrap each
 * `LOCAL_CONTENT_ROOT` (Saves/, Custom/) in its own subscription tracked in
 * `localSubs` (declared at the top of the module with the other state).
 */
async function initLocalWatcher(vamDir) {
  await Promise.all(localSubs.map((s) => s.unsubscribe().catch(() => {})))
  localSubs = []
  const t0 = Date.now()
  const roots = LOCAL_CONTENT_ROOTS.map((r) => join(vamDir, r))
  for (const root of roots) {
    try {
      const sub = await parcelWatcher.subscribe(
        root,
        (err, events) => {
          if (err) {
            console.warn('Local watcher error:', err.message)
            return
          }
          for (const ev of events) onLocalRawEvent(ev)
        },
        {},
      )
      localSubs.push(sub)
    } catch (err) {
      console.warn(`[watcher] Failed to subscribe to local root ${root}: ${err.message}`)
    }
  }
  console.info(`FS watcher 'localWatcher' ready in ${Date.now() - t0} ms (${localSubs.length}/${roots.length} root(s))`)
}

function onLocalRawEvent(ev) {
  if (bulkWindow) {
    bulkWindow.events.push({ ...ev, __source: 'local' })
    return
  }
  routeLocal(ev.path)
}

function routeLocal(fullPath) {
  const ext = extname(fullPath).toLowerCase()
  if (ext === '.hide' || ext === '.fav') {
    pendingLocalPrefs.set(fullPath, 'check')
    scheduleBatch()
    return
  }
  pendingLocalContent = true
  scheduleBatch()
}

async function initPrefsWatcher(prefsDir) {
  if (prefsSub) {
    await prefsSub.unsubscribe().catch(() => {})
    prefsSub = null
  }
  prefsDirPath = prefsDir
  try {
    prefsSub = await parcelWatcher.subscribe(
      prefsDir,
      (err, events) => {
        if (err) {
          console.warn('Prefs watcher error:', err.message)
          return
        }
        for (const ev of events) onPrefsRawEvent(ev)
      },
      {},
    )
  } catch (err) {
    console.warn('Failed to start prefs watcher:', err.message)
  }
}

function onPrefsRawEvent(ev) {
  if (bulkWindow) {
    bulkWindow.events.push({ ...ev, __source: 'prefs' })
    return
  }
  routePrefs(ev.path)
}

function routePrefs(fullPath) {
  const ext = extname(fullPath).toLowerCase()
  if (ext !== '.hide' && ext !== '.fav') return
  if (!prefsDirPath) return
  const rel = relative(prefsDirPath, fullPath)
  const segments = rel.split(sep)
  if (segments.length < 2) return
  pendingPrefsEvents.set(fullPath, 'check')
  scheduleBatch()
}

export async function stopWatcher() {
  await Promise.all(packageSubs.map((s) => s.sub.unsubscribe().catch(() => {})))
  packageSubs = []
  if (prefsSub) {
    await prefsSub.unsubscribe().catch(() => {})
    prefsSub = null
  }
  await Promise.all(localSubs.map((s) => s.unsubscribe().catch(() => {})))
  localSubs = []
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

function onPackageRawEvent(ev, libraryDirId) {
  if (bulkWindow) {
    bulkWindow.events.push({ ...ev, __source: 'package', __dirId: libraryDirId })
    return
  }
  // Fire-and-forget: stability check + push happens async.
  void routePackage(ev, libraryDirId)
}

async function routePackage(ev, libraryDirId) {
  if (!isVarFilename(basename(ev.path))) return
  const type = parcelTypeToLegacy(ev.type)
  if (type !== 'unlink') {
    const ok = await awaitStable(ev.path)
    if (!ok) return // file vanished or never settled into a valid zip
  }
  pendingPackageEvents.set(ev.path, { type, libraryDirId })
  scheduleBatch()
}

function parcelTypeToLegacy(t) {
  if (t === 'delete') return 'unlink'
  return t === 'create' ? 'add' : 'change'
}

/** Drain a single buffered event into the appropriate pending-events map. */
function routeEvent(ev) {
  if (ev.__source === 'package') {
    if (!isVarFilename(basename(ev.path))) return
    void routePackage(ev, ev.__dirId)
    return
  }
  if (ev.__source === 'prefs') return routePrefs(ev.path)
  if (ev.__source === 'local') return routeLocal(ev.path)
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
 * tooling. Records both source and dest paths via `recordOwnedPath`; effective when
 * called from inside a bulk window (i.e. `processBatch`, which always wraps), no-op
 * from the standalone scanner pass (during which the watcher isn't yet running).
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
  recordOwnedPath(fullPath)
  recordOwnedPath(bare)
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

/**
 * Test-only seam. Lets unit tests populate the module-level pending-event
 * maps (and `vamDirPath`) without driving real parcel timing, then call
 * `processBatch` directly. Production callers never touch this — events
 * arrive through the parcel callbacks, which are wired up by
 * `restartPackageWatcher` / `initPrefsWatcher` / `initLocalWatcher`.
 *
 * `state.packageEvents` / `prefsEvents` / `localPrefs`: arrays of
 * `[fullPath, payload]`. `state.localContent`: boolean. `state.vamDir`:
 * string used by the local-content branch.
 */
export function __setProcessBatchStateForTests(state = {}) {
  pendingPackageEvents = new Map(state.packageEvents ?? [])
  pendingPrefsEvents = new Map(state.prefsEvents ?? [])
  pendingLocalPrefs = new Map(state.localPrefs ?? [])
  pendingLocalContent = !!state.localContent
  if (state.vamDir !== undefined) vamDirPath = state.vamDir
  if (state.prefsDir !== undefined) prefsDirPath = state.prefsDir
}

export { processBatch as __processBatchForTests }

async function processBatch() {
  if (processing) {
    scheduleBatch() // reschedule if already processing
    return
  }
  processing = true

  // Wrap the whole pass in a bulk window so internal renames (normalizeAuxDisabled,
  // cascade-enable through applyStorageState) get filtered: each operation calls
  // recordOwnedPath for its source/dest paths, then the watcher's resulting events
  // buffer here and drop on close. Without this, every internal rename triggers a
  // redundant follow-up batch that mtime+size cache-hits but still costs a stat.
  await withBulkWindow(async () => {
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
      // The rename inside normalizeAuxDisabled records its own paths in the bulk window
      // above so the resulting watcher events get dropped on drain.
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

          // parcel emits create/update/delete; stat to get current state
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
  })
  processing = false
}

/**
 * Test seams — run prefs / local sidecar handling through `processBatch` without
 * waiting on the 500ms debounce timer. `prefsDirPath` / `vamDirPath` must be
 * set first (call `__setProcessBatchStateForTests`, or initialize via `startWatcher`).
 */
export async function __prefsEventSyncForTests(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/')
  const ext = extname(normalized).toLowerCase()
  if (ext !== '.hide' && ext !== '.fav') return
  const segments = normalized.split('/')
  if (segments.length < 2) return
  const fullPath = join(prefsDirPath, relativePath)
  pendingPrefsEvents.set(fullPath, 'check')
  await processBatch()
}

export async function __localPrefsEventSyncForTests(fullPath) {
  const ext = extname(fullPath).toLowerCase()
  if (ext !== '.hide' && ext !== '.fav') return
  pendingLocalPrefs.set(fullPath, 'check')
  await processBatch()
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
