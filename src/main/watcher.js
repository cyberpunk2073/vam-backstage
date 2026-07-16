import parcelWatcher from '@parcel/watcher'
import { join, extname, basename, relative, sep, dirname } from 'path'
import { stat, mkdir, rename, unlink, readdir } from 'fs/promises'
import { ADDON_PACKAGES_FILE_PREFS } from '@shared/paths.js'
import { LOCAL_PACKAGE_FILENAME, LOCAL_CONTENT_DIRS } from '@shared/local-package.js'
import { isVarFilename, canonicalVarFilename, qvaroDisabledName } from './scanner/var-reader.js'
import { scanAndUpsert } from './scanner/ingest.js'
import { computeAutoHidePathsForNewPackage } from './scanner/index.js'
import { inheritFromOlderVersion } from './scanner/inherit.js'
import { refreshExtractedPresetsForUpdates } from './scenes/extract-refresh.js'
import { reconcileExtractedLifecycleAndResync } from './scenes/extracted-reconcile.js'
import { runLocalScan } from './scanner/local.js'
import { markPackageMissing, getPackageReconcileInfo, setStorageState } from './db.js'
import { buildFromDb, getPrefsMap, setPrefsMap } from './store.js'
import { notify } from './notify.js'
import { enrichNewPackages } from './hub/scanner.js'
import {
  getAllLibraryDirs,
  refreshLibraryDirs,
  getLibraryDirPath,
  libraryRelSubpath,
  classifyMainVarOnDisk,
} from './library-dirs.js'
import { awaitStable } from './var-stability.js'
import { hidePackageContent, readAllPrefs, stripDisabledSuffix } from './vam-prefs.js'
import { warmFileWatcherBackend } from './watcher-warm.js'

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
      console.warn(`[watcher] Failed to subscribe to local content dir ${dir}: ${err.message}`)
    }
  }
  console.info(`FS watcher 'localWatcher' ready in ${Date.now() - t0} ms (${localSubs.length}/${dirs.length} dir(s))`)
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
  const name = basename(ev.path)
  if (!isVarFilename(name)) return
  const type = parcelTypeToLegacy(ev.type)
  // A `.var.disabled` in main can be an empty marker (VaM-native disable), not a
  // readable zip — gating it on zip stability would silently drop the disable
  // event, so a 0-byte one passes straight through (its handling re-resolves the
  // canonical's footprint from disk anyway). Only an *empty* file qualifies: a
  // non-empty `.var.disabled` is legacy suffix content mid-copy or complete, and
  // must settle into a stable, valid archive like any bare `.var`.
  if (type !== 'unlink') {
    let isEmptyMainMarker = false
    if (libraryDirId == null && /\.disabled$/i.test(name)) {
      const s = await stat(ev.path).catch(() => null)
      if (!s) return // vanished before we could look — the unlink event follows
      isEmptyMainMarker = s.size === 0
    }
    if (!isEmptyMainMarker) {
      const ok = await awaitStable(ev.path)
      if (!ok) return // file vanished or never settled into a valid zip
    }
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

  // Wrap the whole pass in a bulk window so internal renames (normalizeAuxDisabled)
  // get filtered: each operation calls recordOwnedPath for its source/dest paths,
  // then the watcher's resulting events buffer here and drop on close. Without this,
  // every internal rename triggers a redundant follow-up batch that mtime+size
  // cache-hits but still costs a stat.
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
              // Aux adds were already normalized to bare; always offloaded.
              contentPath = adds[0].fullPath
              storageState = 'offloaded'
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
            notify('scan:unreadable', { filename: canonical })
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
      // Aux dirs are suffix-less in our model (offloaded == active).
      if (files.has(canonical)) {
        out.set(canonical, { libraryDirId, storageState: 'offloaded', subpath })
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
