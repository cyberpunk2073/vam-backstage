import parcelWatcher from '@parcel/watcher'
import { join, extname, basename, relative, sep, dirname, isAbsolute } from 'path'
import { stat, mkdir, rename, unlink, readdir } from 'fs/promises'
import { ADDON_PACKAGES_FILE_PREFS } from '@shared/paths.js'
import { LOCAL_PACKAGE_FILENAME, LOCAL_CONTENT_DIRS } from '@shared/local-package.js'
import { isVarFilename, canonicalVarFilename, qvaroDisabledName } from './scanner/var-reader.js'
import { scanAndUpsert } from './scanner/ingest.js'
import { computeAutoHidePathsForNewPackage, runScan } from './scanner/index.js'
import { inheritFromOlderVersion } from './scanner/inherit.js'
import { refreshExtractedPresetsForUpdates } from './scenes/extract-refresh.js'
import { reconcileExtractedLifecycleAndResync } from './scenes/extracted-reconcile.js'
import { runLocalScan } from './scanner/local.js'
import { markPackageMissing, getPackageReconcileInfo, setStorageState } from './db.js'
import { buildFromDb, getPackageIndex, getPrefsMap, setPrefsMap } from './store.js'
import { notify, notifyToast } from './notify.js'
import { enrichNewPackages } from './hub/scanner.js'
import {
  getAllLibraryDirs,
  refreshLibraryDirs,
  getLibraryDirPath,
  libraryRelSubpath,
  classifyMainVarOnDisk,
  isArchiveLibraryDir,
} from './library-dirs.js'
import { awaitStable } from './var-stability.js'
import { hidePackageContent, readAllPrefs, stripDisabledSuffix } from './vam-prefs.js'
import { warmFileWatcherBackend } from './watcher-warm.js'
import { pLimit } from './p-limit.js'

const DEBOUNCE_MS = 500
// Synthetic per-file events dispatched in parallel when a dropped folder is
// expanded; what it really bounds is the `.var` stability checks they trigger.
// Matches the scanner's VAR_STAT_CONCURRENCY — 2× the default libuv pool.
// One shared limiter so simultaneous folder drops share the bound.
const folderExpandLimit = pLimit(8)
// Floor between two lost-event recoveries (resubscribe + full rescan). See `recoverLostEvents`.
const RECOVERY_COOLDOWN_MS = 30_000

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
/** Watcher scopes to resubscribe, and what to reconcile, after a backend error. See `onWatcherError`. */
let pendingWatcherRestarts = new Set()
let pendingFullResync = false
let pendingPrefsResync = false
/** Ordinary prefs-tree reloads (for folder deletes), intentionally outside the backend-error cooldown. */
let pendingPrefsReload = false
let lastRecoveryAt = 0
let watchersRunning = false

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
      // after its async stability check), so we don't have to here. `ourPaths` is
      // passed along so folder-create expansion can filter the app's own files out
      // of an unowned folder event too (see routeEvent).
      for (const ev of win.events) {
        if (win.ourPaths.has(ev.path)) continue
        void routeEvent(ev, win.ourPaths)
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

/**
 * Mark a directory chain the app just created as app-owned. `mkdir(dir, { recursive:
 * true })` returns the topmost directory it had to create (or undefined when the
 * path already existed), which bounds the chain: pass that as `firstCreated` and the
 * target as `leafDir`.
 *
 * Folder creates are expanded by the watcher (`routeEvent`), so without this a
 * bulk move into fresh subfolders would send it re-walking the very tree we just
 * wrote. The drain filters the expansion's synthetic events against owned paths,
 * so the walk finds nothing to dispatch — this just skips the wasted walk itself.
 */
export function recordOwnedDirChain(leafDir, firstCreated) {
  if (!bulkWindow || !firstCreated) return
  let p = leafDir
  while (p.startsWith(firstCreated)) {
    recordOwnedPath(p)
    if (p === firstCreated) break
    p = dirname(p)
  }
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
  if (dirs.length === 0) return true

  const t0 = Date.now()
  const newSubs = []
  for (const d of dirs) {
    try {
      const sub = await parcelWatcher.subscribe(
        d.path,
        (err, events) => {
          if (err) onWatcherError('package', err)
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
  return newSubs.length === dirs.length
}

export async function startWatcher(vamDir) {
  watchersRunning = true
  vamDirPath = vamDir

  // Ensure parcel's native backend is warmed (on a worker) before the first real subscribe,
  // so this never blocks the main thread for ~5s on Explorer launches. See watcher-warm.js.
  await warmFileWatcherBackend()

  await restartPackageWatcher()

  const prefsDir = join(vamDir, ADDON_PACKAGES_FILE_PREFS)
  // Ensure prefs dir exists before the prefs watcher attaches
  await mkdir(prefsDir, { recursive: true }).catch(() => {})
  await initPrefsWatcher(prefsDir)
  await initLocalWatcher(vamDir)
}

/**
 * Watch the monitored loose-content dirs (`LOCAL_CONTENT_DIRS` — `Saves/scene`,
 * `Saves/Person`, `Custom`) for both content changes and sibling `.hide`/`.fav`
 * sidecars. Content files trigger a debounced `runLocalScan()` to reconcile the
 * `__local__`-owned `contents` rows; sidecar files update the in-memory prefs
 * map directly so the UI flips without a full rescan.
 *
 * We deliberately subscribe to the specific content subtrees rather than the
 * bare `Saves/`/`Custom/` roots: this keeps the loose-content watcher entirely
 * out of offload (aux) territory — e.g. a `Saves/PluginData/.../OffloadedVARs`
 * offload dir is never under any monitored dir, so external churn there can't
 * wake this watcher (the package watcher owns it). It also avoids watching
 * plugin runtime scratch under `Saves/PluginData` that classifies to nothing.
 *
 * Each dir is `mkdir`'d first (parcel can't subscribe to a missing path) and
 * gets its own subscription tracked in `localSubs`. parcel's `subscribe`
 * watches one path; it does not follow symlinks, so a BrowserAssist symlink
 * farm inside a monitored dir won't be recursed into.
 */
async function initLocalWatcher(vamDir) {
  await Promise.all(localSubs.map((s) => s.unsubscribe().catch(() => {})))
  localSubs = []
  const t0 = Date.now()
  const dirs = LOCAL_CONTENT_DIRS.map((d) => join(vamDir, d))
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true }).catch(() => {})
    try {
      const sub = await parcelWatcher.subscribe(
        dir,
        (err, events) => {
          if (err) onWatcherError('local', err)
          for (const ev of events) onLocalRawEvent(ev)
        },
        {},
      )
      localSubs.push(sub)
    } catch (err) {
      console.warn(`[watcher] Failed to subscribe to local content dir ${dir}: ${err.message}`)
    }
  }
  console.info(`FS watcher 'localWatcher' ready in ${Date.now() - t0} ms (${localSubs.length}/${dirs.length} dir(s))`)
  return localSubs.length === dirs.length
}

function onLocalRawEvent(ev) {
  const tagged = { ...ev, __source: 'local' }
  if (bulkWindow) {
    bulkWindow.events.push(tagged)
    return
  }
  void routeEvent(tagged)
}

function routeLocal(ev) {
  if (isSidecarPath(ev.path)) {
    pendingLocalPrefs.set(ev.path, 'check')
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
        if (err) onWatcherError('prefs', err)
        for (const ev of events) onPrefsRawEvent(ev)
      },
      {},
    )
    return true
  } catch (err) {
    console.warn('Failed to start prefs watcher:', err.message)
    return false
  }
}

function onPrefsRawEvent(ev) {
  const tagged = { ...ev, __source: 'prefs' }
  if (bulkWindow) {
    bulkWindow.events.push(tagged)
    return
  }
  void routeEvent(tagged)
}

function routePrefs(ev) {
  if (isSidecarPath(ev.path)) {
    routePrefsSidecar(ev.path)
    return
  }
  // Not a sidecar name, so this is a folder: a package's whole prefs folder copied
  // in or removed. A copy arrives pre-expanded (see `routeEvent`); a removal can't
  // be enumerated, and `prefsMap` has no reverse index by folder, so re-read the
  // tree instead. Rare enough that the walk beats the bookkeeping.
  if (parcelTypeToLegacy(ev.type) === 'unlink') {
    pendingPrefsReload = true
    scheduleBatch()
  }
}

function routePrefsSidecar(fullPath) {
  if (!prefsDirPath) return
  const rel = relative(prefsDirPath, fullPath)
  const segments = rel.split(sep)
  if (segments.length < 2) return
  pendingPrefsEvents.set(fullPath, 'check')
  scheduleBatch()
}

function isSidecarPath(fullPath) {
  const ext = extname(fullPath).toLowerCase()
  return ext === '.hide' || ext === '.fav'
}

export async function stopWatcher() {
  watchersRunning = false
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
  pendingWatcherRestarts = new Set()
  pendingFullResync = false
  pendingPrefsResync = false
  pendingPrefsReload = false
  lastRecoveryAt = 0
  vamDirPath = null
}

function onPackageRawEvent(ev, libraryDirId) {
  const tagged = { ...ev, __source: 'package', __dirId: libraryDirId }
  if (bulkWindow) {
    bulkWindow.events.push(tagged)
    return
  }
  // Fire-and-forget: folder expansion + stability check happen async.
  void routeEvent(tagged)
}

/**
 * Route one raw package event. Anything that isn't a `.var` is a folder: a create
 * arrives pre-expanded into its files (see `routeEvent`), so only the delete needs
 * handling here.
 *
 * A delete leaves nothing to probe for directory-ness, and the name can't decide it
 * either — a deleted `Creator.Thing.1.var` may have been an unzipped *folder* holding
 * indexed packages. So every unlink takes the vanished-folder pass: the store knows
 * which packages it placed under the path, and for a genuine file delete the pass
 * matches nothing (a file and a folder can't share a name in one directory).
 */
function routePackage(ev, libraryDirId) {
  const type = parcelTypeToLegacy(ev.type)
  if (type === 'unlink') queueVanishedFolder(ev.path, libraryDirId)
  if (isVarFilename(basename(ev.path))) return routePackageFile(ev.path, type, libraryDirId)
}

/**
 * Queue an unlink for every package the store still places inside `folderPath`, so
 * the batch's normal relocate-or-tombstone pass reconciles each one against disk —
 * a folder dragged to another library dir survives as a move, a folder genuinely
 * deleted tombstones its packages. A delete of something that never held packages
 * (a stray sidecar, say) simply matches nothing.
 */
function queueVanishedFolder(folderPath, libraryDirId) {
  const root = getLibraryDirPath(libraryDirId)
  if (!root) return
  const rel = relative(root, folderPath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
  const prefix = rel.split(sep).join('/')
  let queued = false
  for (const pkg of getPackageIndex().values()) {
    if ((pkg.library_dir_id ?? null) !== (libraryDirId ?? null)) continue
    const subpath = pkg.subpath ?? ''
    if (subpath !== prefix && !subpath.startsWith(prefix + '/')) continue
    pendingPackageEvents.set(join(root, ...subpath.split('/'), pkg.filename), { type: 'unlink', libraryDirId })
    queued = true
  }
  if (queued) scheduleBatch()
}

async function routePackageFile(fullPath, type, libraryDirId) {
  const name = basename(fullPath)
  // A `.var.disabled` in main can be an empty marker (VaM-native disable), not a
  // readable zip — gating it on zip stability would silently drop the disable
  // event, so a 0-byte one passes straight through (its handling re-resolves the
  // canonical's footprint from disk anyway). Only an *empty* file qualifies: a
  // non-empty `.var.disabled` is legacy suffix content mid-copy or complete, and
  // must settle into a stable, valid archive like any bare `.var`.
  if (type !== 'unlink') {
    let isEmptyMainMarker = false
    if (libraryDirId == null && /\.disabled$/i.test(name)) {
      const s = await stat(fullPath).catch(() => null)
      if (!s) return // vanished before we could look — the unlink event follows
      isEmptyMainMarker = s.size === 0
    }
    if (!isEmptyMainMarker) {
      const ok = await awaitStable(fullPath)
      if (!ok) return // file vanished or never settled into a valid zip
    }
  }
  pendingPackageEvents.set(fullPath, { type, libraryDirId })
  scheduleBatch()
}

/**
 * A backend error means *events were lost*, not that one file failed: FSEvents
 * raises "must re-scan" when the kernel or the client drops its queue, and
 * ReadDirectoryChangesW raises it on buffer overflow. Queue a recovery (see
 * `recoverLostEvents`) on the normal debounce, so a burst of errors coalesces.
 */
function onWatcherError(scope, err) {
  console.warn(`[watcher] ${scope} watcher error — resyncing from disk:`, err.message)
  pendingWatcherRestarts.add(scope)
  if (scope === 'prefs') pendingPrefsResync = true
  else pendingFullResync = true
  scheduleBatch()
}

/**
 * Recover from a backend error: resubscribe the affected scopes, then reconcile
 * against disk.
 *
 * Resubscribing is not optional. `Backend::handleWatcherError` removes the
 * subscription from the backend before reporting the error callback, so on Windows a single
 * `ERROR_NOTIFY_ENUM_DIR` (buffer overflow — what a bulk copy into a library dir
 * provokes) permanently kills the watcher; without this the app is blind until it
 * restarts. macOS keeps the subscription alive across a "must re-scan" error, so
 * there the resubscribe is redundant but cheap (~1ms), and the gap it opens is
 * covered by the reconcile that follows it.
 *
 * Rate-limited, because the fault may be ongoing (a flaky network drive, a copy
 * big enough to keep overflowing the event buffer) and every 500ms batch would
 * otherwise kick off another full scan. Requests inside the cooldown are re-armed
 * for when it expires rather than dropped, so the last error still gets reconciled.
 *
 * @returns {Promise<{ resynced: boolean, prefsRefreshed: boolean }>} `resynced`
 *   means the whole library was rebuilt (packages, contents and prefs alike).
 */
async function recoverLostEvents({ restarts, fullResync, prefsResync }) {
  const sinceLast = Date.now() - lastRecoveryAt
  if (sinceLast < RECOVERY_COOLDOWN_MS) {
    requeueRecovery({ restarts, fullResync, prefsResync }, RECOVERY_COOLDOWN_MS - sinceLast)
    return { resynced: false, prefsRefreshed: false }
  }
  lastRecoveryAt = Date.now()

  // Resubscribe before reconciling so changes made during the scan still register.
  // `watchersRunning` prevents a recovery already snapshotted by processBatch from
  // reviving a deliberately stopped watcher. Failed scopes are retried after the
  // cooldown even when their subscription arrays are now empty.
  const failedRestarts = new Set()
  if (watchersRunning) {
    const attempts = [
      ['package', () => restartPackageWatcher()],
      ['prefs', () => initPrefsWatcher(prefsDirPath)],
      ['local', () => initLocalWatcher(vamDirPath)],
    ]
    for (const [scope, restart] of attempts) {
      if (!restarts.has(scope)) continue
      try {
        if (!(await restart())) failedRestarts.add(scope)
      } catch (err) {
        console.warn(`Watcher: ${scope} resubscribe after error failed:`, err.message)
        failedRestarts.add(scope)
      }
    }
  }

  let resynced = false
  let prefsRefreshed = false
  let fullResyncFailed = false
  let prefsResyncFailed = false
  if (vamDirPath && fullResync) {
    try {
      // A full scan subsumes prefs and loose content, and rebuilds the store.
      await runScan(vamDirPath, (progress) => notify('scan:progress', progress))
      resynced = true
    } catch (err) {
      console.warn('Watcher: full resync after error failed:', err.message)
      fullResyncFailed = true
    }
  } else if (vamDirPath && prefsResync) {
    try {
      setPrefsMap(await readAllPrefs(vamDirPath))
      prefsRefreshed = true
    } catch (err) {
      console.warn('Watcher: prefs resync after error failed:', err.message)
      prefsResyncFailed = true
    }
  }

  // A failed resubscribe needs another reconcile too: changes made in the blind
  // gap after this pass would otherwise remain invisible when the retry succeeds.
  const retryFullResync = fullResyncFailed || failedRestarts.has('package') || failedRestarts.has('local')
  const retryPrefsResync = prefsResyncFailed || failedRestarts.has('prefs')
  if (retryFullResync || retryPrefsResync) {
    requeueRecovery(
      { restarts: failedRestarts, fullResync: retryFullResync, prefsResync: retryPrefsResync },
      RECOVERY_COOLDOWN_MS,
    )
  }
  return { resynced, prefsRefreshed }
}

function requeueRecovery({ restarts, fullResync, prefsResync }, delayMs) {
  for (const scope of restarts) pendingWatcherRestarts.add(scope)
  pendingFullResync = pendingFullResync || fullResync
  pendingPrefsResync = pendingPrefsResync || prefsResync
  // Never clobber an already-armed (sooner) timer: ordinary events pending
  // alongside would wait out the whole cooldown. The flags are set, so the sooner
  // batch re-attempts recovery and, still inside the cooldown, requeues itself.
  if (!debounceTimer) scheduleBatch(delayMs)
}

function parcelTypeToLegacy(t) {
  if (t === 'delete') return 'unlink'
  return t === 'create' ? 'add' : 'change'
}

/**
 * Dispatch one raw event to the routers — but when it's the create of a *folder*,
 * dispatch a synthetic create per file inside it instead.
 *
 * A folder moved or copied into a watched tree surfaces as a single create for the
 * directory: FSEvents, ReadDirectoryChangesW and inotify all report it and say
 * nothing about the files already inside. Synthesizing the events the OS withheld
 * keeps the routers ignorant of folders — each only ever handles one file — and
 * without it everything the folder holds stays invisible until the next startup
 * scan.
 *
 * Directory-ness is decided by the walk, never by the name, because the two
 * disagree: unzipping a package commonly leaves a `Creator.Thing.1.var/` *folder*,
 * which a name check hands to the stability gate to stat-poll for two seconds
 * before rejecting it as a non-zip. `collectFilesInTree` returning null (`readdir`
 * rejected, typically ENOTDIR) is the probe, so an ordinary file event pays one
 * failed syscall and routes as itself.
 *
 * Only creates are expanded. A folder emits an update whenever its contents change
 * and those changes carry their own per-file events; a delete leaves nothing to
 * walk, so each router reconciles that its own way (`queueVanishedFolder`,
 * `pendingPrefsReload`, the loose-content rescan).
 *
 * `ownedPaths` (from a bulk-window drain) filters app-owned files out of the
 * expansion: the drain only drops events whose own path is owned, but an *unowned*
 * folder create (a dir the app made without `recordOwnedDirChain` — sidecar dirs,
 * import subfolders) would otherwise re-dispatch the app's own writes inside it.
 */
async function routeEvent(ev, ownedPaths) {
  if (parcelTypeToLegacy(ev.type) === 'add') {
    const nested = await collectFilesInTree(ev.path)
    if (nested) {
      const files = ownedPaths ? nested.filter((p) => !ownedPaths.has(p)) : nested
      await Promise.all(files.map((p) => folderExpandLimit(() => dispatchEvent({ ...ev, path: p }))))
      return
    }
  }
  await dispatchEvent(ev)
}

/** Async so every route path returns a promise: only the package router awaits
 *  anything (the stability gate), but `pLimit` above needs one from all of them. */
async function dispatchEvent(ev) {
  if (ev.__source === 'package') return routePackage(ev, ev.__dirId)
  if (ev.__source === 'prefs') return routePrefs(ev)
  if (ev.__source === 'local') return routeLocal(ev)
}

/**
 * Recursively collect every file under `dirPath`, skipping symlinks (which neither
 * parcel nor our scanners follow). Returns `null` when the path isn't a readable
 * directory, which is what makes it usable as the folder probe above.
 */
async function collectFilesInTree(dirPath, out = []) {
  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(dirPath, entry.name)
    if (entry.isDirectory()) await collectFilesInTree(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** `delayMs` above the default is only used to defer a rate-limited recovery; any
 *  real event arriving meanwhile re-arms the normal debounce and runs on time. */
function scheduleBatch(delayMs = DEBOUNCE_MS) {
  if (debounceTimer) clearTimeout(debounceTimer)
  // Null on fire so "is a batch armed?" (see requeueRecovery) can be answered by
  // the handle alone — a fired timer must not read as pending.
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    processBatch()
  }, delayMs)
}

/**
 * Normalize a stray `.var.disabled` or Qvaro `.DISABLED` in an aux dir to bare
 * `.var`. Aux dirs only ever hold suffix-less files in our model (offloaded ==
 * active) — anything `.disabled`/`.DISABLED` there came from external tooling (a
 * renamed content file or a VaM-native empty marker). The canonical bare name is
 * derived by `canonicalVarFilename` (which understands both rename forms). Records
 * both source and dest paths via `recordOwnedPath`; effective when
 * called from inside a bulk window (i.e. `processBatch`, which always wraps), no-op
 * from the standalone scanner pass (during which the watcher isn't yet running).
 *
 * Returns the bare path on successful rename, or `null` if:
 *   - a bare sibling already exists (we drop the duplicate — empty marker or a
 *     byte-identical copy — or refuse a differently-sized one, leaving both),
 *   - the source is an empty marker with no bare sibling (unlinked as meaningless),
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
      // Empty marker, or byte-identical copy of the bare content → drop it.
      if (disabledStat.size === 0 || disabledStat.size === bareStat.size) {
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
  // No bare sibling: an empty marker on its own carries no content — drop it
  // rather than rename an empty file into a bogus offloaded package.
  try {
    const disabledStat = await stat(fullPath)
    if (disabledStat.size === 0) {
      try {
        await unlink(fullPath)
      } catch {}
      return null
    }
  } catch {
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
 * string used by the local-content branch. Recovery timing/running state can
 * be overridden with `lastRecoveryAt` / `watchersRunning`.
 */
export function __setProcessBatchStateForTests(state = {}) {
  pendingPackageEvents = new Map(state.packageEvents ?? [])
  pendingPrefsEvents = new Map(state.prefsEvents ?? [])
  pendingLocalPrefs = new Map(state.localPrefs ?? [])
  pendingLocalContent = !!state.localContent
  lastRecoveryAt = state.lastRecoveryAt ?? 0 // default: don't leak cooldown state between cases
  if (state.vamDir !== undefined) vamDirPath = state.vamDir
  if (state.prefsDir !== undefined) prefsDirPath = state.prefsDir
  if (state.watchersRunning !== undefined) watchersRunning = state.watchersRunning
}

export { processBatch as __processBatchForTests }

/**
 * Test seam — push raw parcel-shaped events (`{ path, type }`) through the same
 * routing the live subscriptions use (folder expansion, stability gate,
 * folder-removal reconciliation), then run the batch without the debounce wait.
 * `errors` injects backend failures by scope ('package' | 'prefs' | 'local').
 *
 * `packageEvents` entries are `[event, libraryDirId]`.
 */
export async function __routeEventsForTests({
  packageEvents = [],
  prefsEvents = [],
  localEvents = [],
  errors = [],
} = {}) {
  for (const scope of errors) onWatcherError(scope, new Error('events were dropped'))
  for (const [ev, libraryDirId = null] of packageEvents) {
    await routeEvent({ ...ev, __source: 'package', __dirId: libraryDirId })
  }
  for (const ev of prefsEvents) await routeEvent({ ...ev, __source: 'prefs' })
  for (const ev of localEvents) await routeEvent({ ...ev, __source: 'local' })
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  await processBatch()
}

async function processBatch() {
  if (processing) {
    scheduleBatch() // reschedule if already processing
    return
  }
  processing = true

  // Wrap the whole pass in a bulk window so internal renames (normalizeAuxDisabled)
  // get filtered: each operation calls recordOwnedPath for its source/dest paths,
  // then the watcher's resulting events buffer here and drop on close. Without this,
  // every internal rename triggers a redundant follow-up batch that mtime+size
  // cache-hits but still costs a stat.
  //
  // The `finally` is load-bearing: anything escaping the window would otherwise
  // leave `processing` stuck true and silently wedge every later batch.
  try {
    await runBatch()
  } finally {
    processing = false
  }
}

async function runBatch() {
  await withBulkWindow(async () => {
    const pkgEvents = new Map(pendingPackageEvents)
    const prefsEvents = new Map(pendingPrefsEvents)
    const localPrefsEvents = new Map(pendingLocalPrefs)
    const localContentChanged = pendingLocalContent
    const restarts = pendingWatcherRestarts
    const fullResync = pendingFullResync
    const prefsResync = pendingPrefsResync
    const prefsReload = pendingPrefsReload
    pendingPackageEvents.clear()
    pendingPrefsEvents.clear()
    pendingLocalPrefs.clear()
    pendingLocalContent = false
    pendingWatcherRestarts = new Set()
    pendingFullResync = false
    pendingPrefsResync = false
    pendingPrefsReload = false

    let packagesChanged = false
    let contentsChanged = false
    let resynced = false
    let prefsRefreshed = false
    // Enabled filenames freshly added/changed on disk — fed to Hub enrichment only.
    // We deliberately do NOT cascade-enable their deps: a watcher event is an
    // *external* change (VaM, a sync tool, another app), and silently enabling
    // other packages in response would (a) race a peer app that may have its own
    // dep changes queued, (b) enable content the user may not want, and (c) be a
    // surprising side effect of an unattended change. Missing deps just surface as
    // "broken" in the dependency graph, same as any other unsatisfied package.
    const newlyScannedEnabled = []
    /** @type {Array<{ filename: string, pkgType: string|null, contentItems: Array<any>, packageName: string, isNewInstall: boolean }>} */
    const autoHideCandidates = [] // freshly-scanned packages eligible for auto-hide rule application

    // --- Lost-event recovery (see onWatcherError) ---
    if (restarts.size > 0 || fullResync || prefsResync) {
      const recovery = await recoverLostEvents({ restarts, fullResync, prefsResync })
      resynced = recovery.resynced
      prefsRefreshed = recovery.prefsRefreshed
      if (prefsRefreshed) contentsChanged = true
    }

    // Folder deletion is an ordinary filesystem event, not a lost-event recovery:
    // refresh immediately even if an unrelated backend error is in cooldown.
    if (prefsReload && !resynced && !prefsRefreshed && vamDirPath) {
      try {
        setPrefsMap(await readAllPrefs(vamDirPath))
        contentsChanged = true
      } catch (err) {
        console.warn('Watcher: prefs reload after folder deletion failed:', err.message)
      }
    }

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
        byCanonical.get(canonical).push({ fullPath, type, libraryDirId })
      }

      const allDirs = getAllLibraryDirs()

      // Unlinks: before deleting any row, find the canonical's current home on disk —
      // it may have moved (cross-dir, or into/out of a subfolder) rather than been
      // removed. Resolve every unlinked canonical in a single recursive walk per
      // library dir (`locateVars`) instead of one walk per file. A surviving copy
      // anywhere under a library root keeps the row (and its label/setting FKs) alive
      // via setStorageState; only a truly-gone file is deleted. When the batch also has
      // the matching add (move within one batch), the add is then a no-op because
      // scanSingleVar's cache check matches mtime+size against the now-current row.
      // No in-mem patch needed here — the trailing buildFromDb() reloads packageIndex
      // from DB whenever packagesChanged is set.
      const unlinkedCanonicals = new Set()
      for (const [canonical, events] of byCanonical) {
        if (events.some((e) => e.type === 'unlink')) unlinkedCanonicals.add(canonical)
      }
      const relocated = unlinkedCanonicals.size > 0 ? await locateVars(allDirs, unlinkedCanonicals) : new Map()

      for (const [canonical, events] of byCanonical) {
        const adds = events.filter((e) => e.type !== 'unlink')
        const unlinks = events.filter((e) => e.type === 'unlink')

        if (unlinks.length > 0) {
          const altLocation = relocated.get(canonical)
          if (altLocation) {
            setStorageState(canonical, altLocation.storageState, altLocation.libraryDirId, altLocation.subpath)
            packagesChanged = true
          } else {
            // Soft-delete rather than DELETE: the file is gone from disk *right now*,
            // but this is often transient — BrowserAssist's disable/offload renames the
            // `.var` away and back within the same debounce window, and users relocate or
            // unplug packages. Tombstoning hides the row from the gallery immediately
            // while preserving its identity (hub link, labels, type override, content
            // visibility) so a reappearance (see scanSingleVar's cache-hit branch)
            // restores everything. A genuine delete just leaves a permanent tombstone,
            // cleared only by the dev "Forget deleted packages" button.
            if (markPackageMissing(canonical)) {
              packagesChanged = true
              contentsChanged = true
            }
          }
        }

        // Adds/changes: resolve the canonical's on-disk footprint, then (re)scan or
        // reconcile state via scanSingleVar. For main we classify bare + `.disabled`
        // sizes so a marker add flips state without re-reading the archive, and a
        // legacy suffix file is read from its `.disabled` path. Multiple add events
        // for one canonical (bare + its marker) collapse to a single resolution.
        if (adds.length > 0) {
          const { libraryDirId } = adds[0]
          try {
            let contentPath, storageState
            if (libraryDirId != null) {
              // Aux adds were already normalized to bare. Location implies state:
              // an archive-role dir yields `archived`, else `offloaded`.
              contentPath = adds[0].fullPath
              storageState = isArchiveLibraryDir(libraryDirId) ? 'archived' : 'offloaded'
            } else {
              const cls = await classifyMainVarOnDisk(join(dirname(adds[0].fullPath), canonical))
              if (!cls.present) contentPath = null
              else {
                contentPath = cls.contentPath
                storageState = cls.storageState
              }
            }
            if (contentPath) {
              const result = await scanSingleVar(contentPath, storageState, libraryDirId)
              if (result) {
                packagesChanged = true
                if (storageState === 'enabled') newlyScannedEnabled.push(canonical)
                // A cache-hit state flip (e.g. marker toggled) reconciles storage
                // only — no content change, no auto-hide pass.
                if (!result.reconciledOnly) {
                  contentsChanged = true
                  autoHideCandidates.push({
                    filename: canonical,
                    pkgType: result.pkgType,
                    contentItems: result.contentItems,
                    packageName: result.packageName,
                    isNewInstall: result.isNewInstall,
                  })
                }
              }
            }
          } catch (err) {
            console.warn(`Watcher: package event failed for`, canonical, err.message)
            notifyToast(`Corrupted package skipped: ${canonical}`)
          }
        }
      }

      if (packagesChanged) buildFromDb()

      // For each freshly-scanned package: if it's a brand-new install (no DB
      // row pre-scan) AND a previous version exists, inherit user-set settings
      // (labels, content visibility sidecars, custom category) from the donor
      // and skip auto-hide entirely — the donor's per-item state overrides the
      // default rules. Otherwise apply the active auto-hide rules; for content
      // rescans of an existing package this is the only branch we hit.
      //
      // Same flow as `postDownloadIntegrate`, just for `.var`s that arrived
      // via the FS (manual drop, sync tool, another VaM-app instance) rather
      // than the download manager. isDirect=true mirrors scanSingleVar's
      // upsert; the `deps` rule won't claim a direct package, so this only
      // fires the foreign_* rules for hand-dropped files. The inherit helper
      // and `hidePackageContent` both wrap themselves in `withBulkWindow`
      // (nested with the outer one — depth-counted) and `recordOwnedPath`
      // their writes, so the resulting sidecar events get filtered out.
      const extractRefreshAdditions = []
      if (autoHideCandidates.length > 0 && vamDirPath) {
        let sidecarsTouched = false
        for (const { filename, pkgType, contentItems, packageName, isNewInstall } of autoHideCandidates) {
          if (isNewInstall) {
            try {
              const inherited = await inheritFromOlderVersion({
                filename,
                packageName,
                contentItems,
                vamDir: vamDirPath,
              })
              if (inherited) {
                sidecarsTouched = true
                if (inherited.donor) {
                  extractRefreshAdditions.push({ filename, donorFilename: inherited.donor, contentItems })
                }
                continue
              }
            } catch (err) {
              console.warn(`Watcher: inherit failed for ${filename}:`, err.message)
            }
          }
          const paths = computeAutoHidePathsForNewPackage(filename, pkgType, true, contentItems)
          if (paths.length === 0) continue
          try {
            await hidePackageContent(vamDirPath, filename, paths)
            sidecarsTouched = true
          } catch (err) {
            console.warn(`Watcher: auto-hide failed for ${filename}:`, err.message)
          }
        }
        if (sidecarsTouched) setPrefsMap(await readAllPrefs(vamDirPath))
        // buildFromDb already ran above (packagesChanged), so the new .var is
        // resolvable; regenerate extracted presets for strictly-newer versions.
        await refreshExtractedPresetsForUpdates(extractRefreshAdditions, vamDirPath)
      }

      // Hub-enrich freshly-scanned enabled packages. Note: we intentionally do
      // NOT cascade-enable their deps here — external FS changes never trigger
      // state side effects on other packages (see `newlyScannedEnabled` above).
      if (newlyScannedEnabled.length > 0) {
        enrichNewPackages(newlyScannedEnabled)
      }

      // Reconcile extracted-preset enable/disable state against the (externally)
      // changed package activeness — the same bookkeeping the app-driven toggle
      // does, now also for VaM / sync-tool / other-instance changes. Unlike
      // cascading deps, extracted presets are our own derived artifacts, so
      // keeping them in sync isn't a surprising side effect. Full sweep: an
      // external removal tombstones the owning package out of the store, so a
      // targeted-by-filename pass couldn't reach a preset whose last owner just
      // vanished (it's disabled, not deleted — removal is reversible). Renames
      // are app-owned, so they buffer + drop in this batch's bulk window.
      //
      // PERF: runs a full sweep over every extracted preset on *any* package-
      // changing batch, even ones that can't affect presets. It's an in-memory
      // pass (no fs/DB unless something's actually out of sync), so cheap today.
      // If extracted-preset counts ever grow enough to matter, gate this on an
      // actual state-flip/removal and/or pass a targeted `filenames` set (with a
      // separate orphan pass to cover tombstoned owners).
      if (packagesChanged && vamDirPath) {
        try {
          const { changed } = await reconcileExtractedLifecycleAndResync({ vamDir: vamDirPath })
          if (changed > 0) contentsChanged = true
        } catch (err) {
          console.warn('Watcher: extracted-preset reconcile failed:', err.message)
        }
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
          // Bind to the canonical (live) path so the flag tracks the preset
          // across the `.disabled` marker toggling.
          const internalPath = stripDisabledSuffix(rel.slice(0, -sidecarExt.length))
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
    if (packagesChanged || resynced) notify('packages:updated')
    if (contentsChanged || resynced) notify('contents:updated')
  })
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
 * Locate the current on-disk home of each wanted canonical `.var` across every
 * registered library dir, supporting nested placement (a `.var` may live in any
 * subfolder under a library root). One recursive walk per dir, short-circuiting
 * as soon as every wanted canonical is found.
 *
 * Dir precedence follows `dirs` order (main first), and within the tree a
 * shallower / earlier match wins. Aux dirs accept only the suffix-less name (we
 * normalize away the disabled spelling in aux); main classifies bare + disabled-
 * sibling sizes (`classifyMainVar`) to distinguish enabled / marker-disabled /
 * suffix-disabled (the sibling may be a VaM `.var.disabled` or a Qvaro `.DISABLED`
 * rename), and treats a lone empty marker as "not found".
 *
 * @returns {Promise<Map<string, { libraryDirId: number|null, storageState: string, subpath: string }>>}
 */
async function locateVars(dirs, wanted) {
  const out = new Map()
  const remaining = new Set(wanted)
  for (const { id, path: dirPath } of dirs) {
    if (remaining.size === 0) break
    if (!dirPath) continue
    await locateWalk(dirPath, dirPath, id, remaining, out)
  }
  return out
}

async function locateWalk(root, dir, libraryDirId, remaining, out) {
  if (remaining.size === 0) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // unreadable subdir — skip, mirrors the scanner's silent-skip
  }
  const subdirs = []
  const files = new Set()
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue // never follow symlinks (matches the scanner/parcel)
    if (entry.isDirectory()) subdirs.push(entry.name)
    else if (entry.isFile()) files.add(entry.name)
  }
  const rel = relative(root, dir) // dir's own subpath relative to the library root ('' at root)
  const subpath = rel ? rel.split(sep).join('/') : ''
  for (const canonical of [...remaining]) {
    if (libraryDirId != null) {
      // Aux dirs are suffix-less in our model (offloaded/archived == bare). Location
      // implies state: an archive-role dir yields `archived`, else `offloaded`.
      if (files.has(canonical)) {
        const storageState = isArchiveLibraryDir(libraryDirId) ? 'archived' : 'offloaded'
        out.set(canonical, { libraryDirId, storageState, subpath })
        remaining.delete(canonical)
      }
      continue
    }
    // Gate on the dirent set first so we only stat canonicals actually present
    // in this folder, then classify their bare/`.var.disabled`/Qvaro `.DISABLED`
    // footprint on disk.
    if (!files.has(canonical) && !files.has(canonical + '.disabled') && !files.has(qvaroDisabledName(canonical)))
      continue
    const cls = await classifyMainVarOnDisk(join(dir, canonical))
    if (!cls.present) continue // e.g. only an empty marker — no content here
    out.set(canonical, {
      libraryDirId,
      storageState: cls.storageState,
      subpath,
    })
    remaining.delete(canonical)
  }
  for (const name of subdirs) {
    if (remaining.size === 0) return
    await locateWalk(root, join(dir, name), libraryDirId, remaining, out)
  }
}

async function scanSingleVar(fullPath, storageState, libraryDirId) {
  const filename = canonicalVarFilename(basename(fullPath))
  const subpath = libraryRelSubpath(getLibraryDirPath(libraryDirId), fullPath)

  let s
  try {
    s = await stat(fullPath)
  } catch {
    return null
  }

  const mtime = s.mtimeMs / 1000
  const size = s.size

  const cached = getPackageReconcileInfo(filename)
  if (cached && cached.file_mtime === mtime && cached.size_bytes === size) {
    // Content bytes unchanged. Reconcile location/state cheaply (no archive read).
    // This is the path a marker add/remove takes: the bare `.var` is untouched,
    // so we cache-hit here and only flip storage_state.
    //
    // A set `missing_since` means this file was tombstoned (an earlier unlink in
    // this or a prior batch) and has now reappeared byte-identical — the classic
    // BrowserAssist rename-away-and-back. setStorageState clears the tombstone, so
    // we must force the reconcile path even when state/location already match.
    if (
      cached.storage_state !== storageState ||
      (cached.library_dir_id ?? null) !== (libraryDirId ?? null) ||
      (cached.subpath ?? '') !== subpath ||
      cached.missing_since != null
    ) {
      setStorageState(filename, storageState, libraryDirId, subpath)
      return { reconciledOnly: true }
    }
    return null // no change
  }

  // Returns null if the filename is unparseable, otherwise { contentItems, pkgType, ... }.
  // `isNewInstall` flags a row that didn't exist before this scan — caller uses
  // it to decide between inheriting from an older version vs applying default
  // auto-hide rules. Stale-cache rescans (row exists, content changed) are not
  // new installs.
  const result = await scanAndUpsert(fullPath, { storageState, libraryDirId, subpath, isDirect: 1 })
  return result ? { ...result, isNewInstall: !cached } : null
}
