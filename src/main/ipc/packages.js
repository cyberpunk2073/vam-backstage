import { createWriteStream } from 'fs'
import { ipcMain, net } from 'electron'
import { access, rename, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  setPackageDirect,
  touchPackageFirstSeen,
  deletePackage,
  getSetting,
  setPackageTypeOverride,
  setPackageCorrupted,
  setHubResourceId,
  applyHubDetailToPackage,
} from '../db.js'
import { scanAndUpsert } from '../scanner/ingest.js'
import { runLocalScan } from '../scanner/local.js'
import { enrichNewPackages } from '../hub/scanner.js'
import { readVar, parseVarFilename } from '../scanner/var-reader.js'
import { verifyPackageFull } from '../scanner/integrity.js'
import {
  getFilteredPackages,
  getPackageDetail,
  getPackageIndex,
  getGroupIndex,
  getStats,
  getStatusCounts,
  getTypeCounts,
  getForwardDeps,
  getReverseDeps,
  getOrphanSet,
  getMissingDeps,
  setPrefsMap,
  buildFromDb,
  patchTypeOverride,
  getFilteredContents,
  getReplaceableSet,
  rebuildReplaceableSet,
  resolveHubDownloadUrl,
  findLocalByFilename,
  effectivePackageType,
  recomputeInactiveDeps,
  recomputeDemandAggregates,
  getTransitiveMissingRefs,
} from '../store.js'
import { isPackageActive, isPackageArchived } from '@shared/storage-state-predicates.js'
import { extractedDeletePaths, extractedHasSurvivor } from '../scenes/extracted-lifecycle.js'
import { reconcileExtractedLifecycleAndResync, extractedItemsFor } from '../scenes/extracted-reconcile.js'
import { hidePackageContent, unhidePackageContent, readAllPrefs } from '../vam-prefs.js'
import { computeAutoHidePathsForNewPackage } from '../scanner/index.js'
import {
  computeRemovableDeps,
  computeCascadeDisable,
  computeCascadeEnable,
  getTransitiveDeps,
} from '../scanner/graph.js'
import { LOCAL_PACKAGE_FILENAME } from '@shared/local-package.js'
import {
  applyStorageState,
  parseDisableBehavior,
  nextStorageStateForIntent,
  computeInstallTarget,
  planResettle,
} from '../storage-state.js'
import {
  pkgVarPath,
  resolveContentPath,
  getMainLibraryDirPath,
  isArchiveLibraryDir,
  getArchiveLibraryDirs,
} from '../library-dirs.js'
import {
  enqueueInstall,
  enqueueInstallMissing,
  enqueueInstallAllMissing,
  enqueueInstallRef,
  enqueueInstallBatch,
  ensureVarExt,
} from '../downloads/manager.js'
import {
  importLocalFromPath,
  importPrecheck,
  importChunk,
  importCommit,
  importAbort,
  cleanupOwner,
} from '../downloads/import.js'
import { onClientClose } from '../remote/server.js'
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
 * Record-as-owned + unlink everything belonging to a package: the bare `.var`
 * and its `.var.disabled` sibling at the package's own location (covers enabled,
 * marker-disabled, and legacy suffix-disabled layouts — nested subfolders too),
 * plus any stray root-level aliases (`<fn>` / `<fn>.disabled` in main) external
 * tools may have left around. Each path is unlinked at most once. Caller is
 * responsible for `deletePackage`. Effective only when caller wraps in
 * `withBulkWindow`; single non-bulk uninstalls accept the watcher event (idempotent).
 */
async function unlinkPackagePhysicalAndAliases(pkg, filename) {
  const physical = pkg ? pkgVarPath(pkg) : null
  const mainDir = getMainLibraryDirPath()
  const targets = []
  if (physical) targets.push(physical, physical + '.disabled')
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
 * After promote/demote, align `.hide` sidecars with active auto-hide rules for
 * both in-var content and extracted presets owned by the package. Extracted
 * presets are shared across versions, so the deps rule uses "any candidate
 * still direct" rather than only the package that just flipped.
 */
async function syncAutoHideAfterDirectChange(vamDir, filename, isDirect) {
  const pkg = getPackageIndex().get(filename)
  if (!pkg) return
  const effectiveType = effectivePackageType(pkg)

  const contents = getFilteredContents({ packageFilename: filename })
  const pkgItems = contents.map((c) => ({ internalPath: c.internalPath, type: c.type }))
  const hidePkg = new Set(computeAutoHidePathsForNewPackage(filename, effectiveType, isDirect, pkgItems))
  const pkgPaths = contents.map((c) => c.internalPath)
  const pkgHide = pkgPaths.filter((p) => hidePkg.has(p))
  const pkgUnhide = pkgPaths.filter((p) => !hidePkg.has(p))
  if (pkgHide.length) await hidePackageContent(vamDir, filename, pkgHide)
  if (pkgUnhide.length) await unhidePackageContent(vamDir, filename, pkgUnhide)

  const pkgIndex = getPackageIndex()
  const candidateIsDirect = (cf) => (cf === filename ? isDirect : !!pkgIndex.get(cf)?.is_direct)
  const toHide = []
  const toUnhide = []
  for (const item of extractedItemsFor([filename])) {
    const anyDirect = extractedHasSurvivor(item.extractedCandidates, candidateIsDirect)
    const hide = computeAutoHidePathsForNewPackage(filename, effectiveType, anyDirect, [
      { internalPath: item.internal_path, type: item.type },
    ])
    if (hide.length > 0) toHide.push(item.internal_path)
    else toUnhide.push(item.internal_path)
  }
  if (toHide.length) await hidePackageContent(vamDir, LOCAL_PACKAGE_FILENAME, toHide)
  if (toUnhide.length) await unhidePackageContent(vamDir, LOCAL_PACKAGE_FILENAME, toUnhide)
}

/**
 * When packages are removed, delete the extracted presets they exclusively
 * owned — but only when no other installed version still claims them (`.latest`
 * refs keep the preset working otherwise). Returns whether any file was removed.
 * Call before `deletePackage` so `packageIndex` still resolves the candidates.
 */
async function cleanupExtractedPresetsForRemoval(removedFilenames) {
  const vamDir = getSetting('vam_dir')
  if (!vamDir) return false
  const removedSet = removedFilenames instanceof Set ? removedFilenames : new Set(removedFilenames)
  const pkgIndex = getPackageIndex()
  const survives = (cf) => !removedSet.has(cf) && pkgIndex.has(cf)
  let removedAny = false
  for (const item of extractedItemsFor(removedSet)) {
    if (extractedHasSurvivor(item.extractedCandidates, survives)) continue
    for (const rel of extractedDeletePaths(item.internal_path)) {
      const p = join(vamDir, rel)
      recordOwnedPath(p)
      try {
        await unlink(p)
      } catch {}
    }
    removedAny = true
  }
  return removedAny
}

/**
 * Cascade a storage-state change onto extracted presets owned by `filenames`
 * (rename `.vap` <-> `.vap.disabled` to match their owners' activeness) and
 * commit the moved loose-content rows. Renames are app-owned, so the watcher
 * stays quiet. Every path that changes whether a package is active must run
 * this — the enable/disable toggle, archiving, and the re-settle pass alike.
 * Best-effort: a failure here never aborts the operation that caused it.
 */
async function syncExtractedPresets(filenames) {
  const list = [...filenames]
  if (list.length === 0) return
  try {
    const { changed } = await reconcileExtractedLifecycleAndResync({ vamDir: getSetting('vam_dir'), filenames: list })
    if (changed > 0) notify('contents:updated')
  } catch (err) {
    console.warn('Extracted-preset lifecycle reconcile failed:', err.message)
  }
}

/**
 * Re-settle pass (demand Rule 2). After an operation changes some deps'
 * dependent sets (uninstall / archive / remove-orphans), each surviving *non-direct*
 * dep should sit at the max activeness of its remaining dependents (enabled >
 * disabled > offloaded > archived). A dep more active than that settles down; a
 * Hub-redownloadable dep whose remaining dependents are all archived is pruned
 * (deleted — a later install re-downloads it); a local-only dep in that situation
 * relocates into a dependent's archive dir (soft demand made physical). Direct
 * packages are never touched, and archived deps (already at the bottom) are left be.
 *
 * The pure plan (settle-down / relocate / prune decisions) comes from `planResettle`;
 * this executor applies it: `applyStorageState` for each settle/relocate decision,
 * then the uninstall deletion path for the pruned set. `prune` false (Archive "store"
 * mode) turns every would-be prune into a relocate-into-archive instead.
 *
 * Must run inside the caller's `withBulkWindow`; the caller rebuilds the graph
 * (`buildFromDb`) afterwards. Returns `{ pruned, relocatedToArchive, settledDown }`.
 */
async function resettleDeps(candidates, { vamDir, prune = true }) {
  const parsed = parseDisableBehavior(getSetting('disable_behavior'))
  const disableBehaviorTargetId = parsed.kind === 'move-to' ? parsed.auxDirId : null
  const { toPrune, decisions } = planResettle({
    candidates,
    packageIndex: getPackageIndex(),
    reverseDeps: getReverseDeps(),
    replaceableSet: getReplaceableSet(),
    disableBehaviorTargetId,
    prune,
  })

  let relocatedToArchive = 0
  let settledDown = 0
  for (const [fn, target] of decisions) {
    try {
      await applyStorageState(fn, target)
      if (target.storageState === 'archived') relocatedToArchive++
      else settledDown++
    } catch (err) {
      console.warn(`Re-settle failed for ${fn}:`, err.message)
    }
  }
  // A dep settling enabled → offloaded/disabled/archived deactivates it, so its
  // extracted presets must follow (the toggle chokepoint does the same).
  await syncExtractedPresets(decisions.keys())

  let pruned = 0
  if (toPrune.size > 0) {
    const toDelete = [...toPrune]
    const removedExtracted = await cleanupExtractedPresetsForRemoval(toDelete)
    for (const fn of toDelete) {
      await unlinkPackagePhysicalAndAliases(getPackageIndex().get(fn), fn)
      deletePackage(fn)
    }
    pruned = toDelete.length
    if (removedExtracted && vamDir) await runLocalScan(vamDir)
  }
  return { pruned, relocatedToArchive, settledDown }
}

/**
 * Shared worker for `packages:toggle-enabled` and `packages:set-enabled`. The
 * caller supplies `intentFn(pkg)` returning `'enable' | 'disable'`; for each
 * filename we resolve the resulting storage_state target via the
 * `nextStorageStateForIntent` matrix (which encodes "no-op when already at
 * the target end of the spectrum"), apply it via `applyStorageState`, and
 * cascade through `computeCascadeEnable / computeCascadeDisable` according
 * to the same intent. The `disable_behavior` setting decides whether disable
 * means a VaM-native `.var.disabled` marker in main or move-to-aux.
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
    const affectedForExtracted = new Set()
    // Enabling out of `archived` changes Rule 1 pinning (orphan/removable) —
    // track so we recomputeDemandAggregates instead of the cheap inactive-only path.
    let clearedArchive = false
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

      if (isPackageArchived(pkg.storage_state)) clearedArchive = true
      try {
        await applyStorageState(filename, target)
        affectedForExtracted.add(filename)
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
            if (isPackageArchived(depPkg.storage_state)) clearedArchive = true
            try {
              await applyStorageState(depFilename, depTarget)
              affectedForExtracted.add(depFilename)
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

    // Targeted by the flipped filenames — they're still present, so reachable
    // via the store.
    await syncExtractedPresets(affectedForExtracted)

    // Toggles patch packageIndex in place without a full rebuild. Leaving archive
    // changes Rule 1 pinning → orphan/removable; otherwise only inactive/stats.
    if (clearedArchive) recomputeDemandAggregates()
    else recomputeInactiveDeps()

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

  ipcMain.handle('packages:graph', () => {
    const packageIndex = getPackageIndex()
    const forwardDeps = getForwardDeps()
    const nodes = []
    // Only enabled (actively installed) packages — disabled/offloaded ones aren't
    // live in VaM, so they'd only add noise to the force field.
    const enabled = new Set()
    for (const [filename, pkg] of packageIndex) {
      if (!isPackageActive(pkg.storage_state)) continue
      enabled.add(filename)
      nodes.push({
        id: filename,
        creator: pkg.creator,
        packageName: pkg.package_name,
        isDirect: !!pkg.is_direct,
        type: effectivePackageType(pkg),
      })
    }
    const links = []
    for (const [filename, deps] of forwardDeps) {
      if (!enabled.has(filename)) continue
      for (const d of deps) {
        if (!d.resolved || !enabled.has(d.resolved)) continue
        links.push({ source: filename, target: d.resolved })
      }
    }
    return { nodes, links }
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

  ipcMain.handle(
    'packages:install',
    async (_, { resourceId, hubDetail, autoQueueDeps, packageName, asDependency, targetFilename }) => {
      return await enqueueInstall({
        resourceId,
        hubDetail,
        autoQueueDeps: autoQueueDeps !== false,
        packageName,
        asDependency: !!asDependency,
        targetFilename: targetFilename || null,
      })
    },
  )

  ipcMain.handle('packages:install-missing', async (_, { filename, autoQueueDeps }) => {
    return await enqueueInstallMissing(filename, autoQueueDeps !== false)
  })

  ipcMain.handle('packages:promote', async (_, filenameOrFilenames, hubResourceId) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')

    const filenames = normalizeFilenameArgs(filenameOrFilenames)
    // Promoting implies the user wants the package usable — enable disabled/offloaded
    // targets first (cascade-enables inactive deps, same path as packages:set-enabled).
    const toEnable = filenames.filter((fn) => {
      const pkg = getPackageIndex().get(fn)
      return pkg && !isPackageActive(pkg.storage_state)
    })
    if (toEnable.length > 0) {
      await applyStorageStateChange(toEnable, () => 'enable')
    }

    for (const filename of filenames) {
      setPackageDirect(filename, true)
      touchPackageFirstSeen(filename)
      await syncAutoHideAfterDirectChange(vamDir, filename, true)
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
      const resettleCandidates = new Set()
      for (const filename of filenames) {
        const pkg = getPackageIndex().get(filename)
        if (!pkg) throw new Error(`Package not found: ${filename}`)

        const replaceableSet = getReplaceableSet()
        const dependents = getReverseDeps().get(filename) || new Set()
        // Demote gate follows Rule 1: only *non-archived* dependents keep a package
        // alive-as-dep. Archived dependents make no redownloadable demand, so a
        // package needed only by the hoard is not stranded in the Dependencies facet.
        const nonArchivedDeps = [...dependents].filter((d) => {
          const dp = getPackageIndex().get(d)
          return dp && !isPackageArchived(dp.storage_state)
        })

        if (nonArchivedDeps.length > 0) {
          setPackageDirect(filename, false)
          await syncAutoHideAfterDirectChange(vamDir, filename, false)
          const prefs = await readAllPrefs(vamDir)
          setPrefsMap(prefs)
          buildFromDb({ skipGraph: true })
          // The demoted package itself may now settle down to its remaining
          // (offloaded/disabled) dependents' tier — hand it to the re-settle pass.
          resettleCandidates.add(filename)
          results.push({ ok: true, demoted: true })
          continue
        }

        // Needed only by archived packages (non-empty dependents, all archived):
        // a local-only target is relocated into the archive rather than deleted;
        // a replaceable one falls through to deletion as the user requested.
        if (dependents.size > 0 && !replaceableSet.has(filename)) {
          const target = computeInstallTarget({ dependents, packageIndex: getPackageIndex() })
          if (target && target.storageState === 'archived') {
            try {
              // Capture deps before the move: once this package is archived it stops
              // demanding its redownloadable deps (Rule 1), so they must re-settle too
              // — otherwise the outcome depends on which end of the chain moved first.
              const transitive = getTransitiveDeps(filename, getForwardDeps())
              await applyStorageState(filename, target)
              await syncExtractedPresets([filename])
              buildFromDb()
              for (const dep of transitive) resettleCandidates.add(dep)
              results.push({ ok: true, relocatedToArchive: true })
              continue
            } catch (err) {
              console.warn(`Relocate-to-archive on uninstall failed for ${filename}:`, err.message)
            }
          }
        }

        const { removableFilenames } = computeRemovableDeps(
          filename,
          getPackageIndex(),
          getForwardDeps(),
          getReverseDeps(),
          replaceableSet,
        )
        // Capture surviving transitive deps *before* deletion so the re-settle pass
        // can settle down any that this package no longer demands.
        const transitive = getTransitiveDeps(filename, getForwardDeps())
        // Belt-and-suspenders with Rule 1 in computeRemovableDeps: that pass already
        // keeps archive-soft-pinned local-only deps out of `removableFilenames`. This
        // filter still drops any remaining non-replaceable members (unknown catalog,
        // or removable only because *this* uninstall target was their last pin) so
        // we never delete bytes we can't verifiably restore — they survive for
        // orphan cleanup / re-settle instead.
        const filteredRemovable = [...removableFilenames].filter((fn) => replaceableSet.has(fn))
        const toDelete = [filename, ...filteredRemovable]
        const toDeleteSet = new Set(toDelete)
        // Remove extracted presets no surviving version still owns (before the
        // rows/index are torn down so candidates still resolve).
        const removedExtracted = await cleanupExtractedPresetsForRemoval(toDelete)
        for (const fn of toDelete) {
          await unlinkPackagePhysicalAndAliases(getPackageIndex().get(fn), fn)
          deletePackage(fn)
        }
        // Reconcile the loose-content rows for any extracted presets we deleted
        // (their `__local__` rows would otherwise linger until the next scan).
        if (removedExtracted) await runLocalScan(vamDir)
        for (const dep of transitive) if (!toDeleteSet.has(dep)) resettleCandidates.add(dep)
        buildFromDb()
        results.push({ ok: true, deleted: toDelete.length })
      }

      // Settle surviving deps to their remaining dependents' tier (Rule 2), incl.
      // relocating local-only deps into the archive and pruning redownloadable ones.
      // Reported alongside the per-package results so the toast can mention deps
      // that were deleted or moved beyond the ones the confirm dialog listed.
      let resettled = null
      if (resettleCandidates.size > 0) {
        const res = await resettleDeps(resettleCandidates, { vamDir })
        if (res.pruned || res.relocatedToArchive || res.settledDown) {
          buildFromDb()
          resettled = { prunedDeps: res.pruned, depsMovedToArchive: res.relocatedToArchive }
        }
      }

      notify('packages:updated')
      notify('contents:updated')
      if (filenames.length === 1) return { ...results[0], ...resettled }
      return { ok: true, results, ...resettled }
    })
  })

  /**
   * Best-effort Hub refresh for archive prune replaceability. Updates caches only:
   *   1. packages.json if stale (exact-filename presence)
   *   2. findPackages on currently-replaceable deps in the batch's closure
   *      (downloadable flags → hub_resources.find_json)
   *   3. rebuildReplaceableSet from those caches
   * On any failure the existing local cache stays authoritative. Preview/execute
   * just re-read getReplaceableSet() — no second Hub pass on Archive confirm.
   */
  ipcMain.handle('packages:refresh-archive-replaceability', async (_, filenameOrFilenames) => {
    const filenames = normalizeFilenameArgs(filenameOrFilenames)
    let catalogRefreshed = false
    let findChecked = 0

    const STALE_MS = 1 * 60 * 60 * 1000 // 1 hour
    if (!getPackagesIndex() || getPackagesIndexAge() > STALE_MS) {
      try {
        await fetchPackagesJson()
        catalogRefreshed = true
        // Full rebuild so orphan/removable + replaceable all see the new index.
        buildFromDb()
      } catch (err) {
        console.warn('[archive] packages.json refresh failed:', err.message)
      }
    }

    const pkgIndex = getPackageIndex()
    const replaceable = getReplaceableSet()
    const stems = new Set()
    for (const fn of filenames) {
      const pkg = pkgIndex.get(fn)
      if (!pkg || isPackageArchived(pkg.storage_state)) continue
      for (const dep of getTransitiveDeps(fn, getForwardDeps())) {
        if (dep === LOCAL_PACKAGE_FILENAME) continue
        if (!replaceable.has(dep)) continue // already keep — Hub can't promote to prune
        stems.add(dep.replace(/\.var$/i, ''))
      }
    }

    if (stems.size > 0) {
      try {
        await findPackages([...stems])
        findChecked = stems.size
        // findPackages upserts hub_resources.find_json; rebuild deletion-grade set.
        rebuildReplaceableSet()
      } catch (err) {
        console.warn('[archive] findPackages refresh failed:', err.message)
      }
    }

    return { ok: true, catalogRefreshed, findChecked }
  })

  // Read-only preview for the Archive confirm dialog: per dep-mode, how many deps
  // / how many bytes would be deleted vs moved into the archive. Both modes are
  // returned because the dialog shows both radio options side by side — the user
  // is choosing between these numbers. Uses the same `planResettle` core as
  // execution against a batch-archived simulated index, so the numbers match what
  // the action actually does. No network — Hub freshness is
  // `packages:refresh-archive-replaceability` (dialog-owned).
  ipcMain.handle('packages:archive-preview', async (_, { filenames: fnArg, archiveDirId } = {}) => {
    const archiveDirs = getArchiveLibraryDirs()
    const dirId = archiveDirId != null ? Number(archiveDirId) : (archiveDirs[0]?.id ?? null)
    const filenames = normalizeFilenameArgs(fnArg)
    // Same source replaceability reads from — a group-level index without the
    // filename index would let the dialog claim a bill it can't actually verify.
    const catalogUnavailable = !getPackagesFilenameIndex()

    const pkgIndex = getPackageIndex()
    const batchSet = new Set()
    for (const fn of filenames) {
      const p = pkgIndex.get(fn)
      if (p && !isPackageArchived(p.storage_state)) batchSet.add(fn)
    }
    // Overlay the batch as archived-in-target-dir so Rule 1 (archived demand) applies.
    const overlay = new Map()
    for (const fn of batchSet) {
      const p = pkgIndex.get(fn)
      if (p) overlay.set(fn, { ...p, storage_state: 'archived', library_dir_id: dirId })
    }
    const simIndex = { get: (fn) => overlay.get(fn) ?? pkgIndex.get(fn) }
    const closure = new Set()
    for (const fn of batchSet) for (const dep of getTransitiveDeps(fn, getForwardDeps())) closure.add(dep)

    const parsed = parseDisableBehavior(getSetting('disable_behavior'))
    const disableBehaviorTargetId = parsed.kind === 'move-to' ? parsed.auxDirId : null
    const summarize = (prune) => {
      const { toPrune, decisions } = planResettle({
        candidates: closure,
        packageIndex: simIndex,
        reverseDeps: getReverseDeps(),
        replaceableSet: getReplaceableSet(),
        disableBehaviorTargetId,
        prune,
      })
      const totals = { deleteCount: 0, deleteBytes: 0, storeCount: 0, storeBytes: 0 }
      for (const fn of toPrune) {
        const p = pkgIndex.get(fn)
        if (!p) continue
        totals.deleteCount++
        totals.deleteBytes += p.size_bytes || 0
      }
      for (const [fn, target] of decisions) {
        if (target.storageState !== 'archived') continue // settle-down (disabled/offloaded), not moved into archive
        const p = pkgIndex.get(fn)
        if (!p) continue
        totals.storeCount++
        totals.storeBytes += p.size_bytes || 0
      }
      return totals
    }
    // Prune mode still stores the local-only deps it refuses to delete, so its
    // `storeBytes` is the "kept, never deleted" figure rather than the whole closure.
    return { archiveCount: batchSet.size, prune: summarize(true), store: summarize(false), catalogUnavailable }
  })

  // Archive the selected packages into an archive dir, then handle their now-unneeded
  // dep closure per `depMode`: 'prune' deletes redownloadable deps (relocating local-only
  // into the archive), 'store' moves the whole unneeded closure into the archive.
  // Sticky `is_direct`; already-archived filenames are a no-op (no archive→archive moves).
  // No Hub refresh here — the confirm dialog already ran refresh-archive-replaceability;
  // unlikely the catalog moved between preview and click.
  ipcMain.handle('packages:archive', async (_, { filenames: fnArg, archiveDirId, depMode } = {}) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    const archiveDirs = getArchiveLibraryDirs()
    if (archiveDirs.length === 0) throw new Error('No archive directory configured')
    const dirId = archiveDirId != null ? Number(archiveDirId) : archiveDirs[0].id
    if (!isArchiveLibraryDir(dirId)) throw new Error(`Not an archive directory: ${archiveDirId}`)
    const mode = depMode === 'store' ? 'store' : 'prune'
    const filenames = normalizeFilenameArgs(fnArg)

    return withBulkWindow(async () => {
      // 1. Move the selected packages into the archive (skip already-archived).
      const archived = []
      for (const filename of filenames) {
        const pkg = getPackageIndex().get(filename)
        if (!pkg) throw new Error(`Package not found: ${filename}`)
        if (isPackageArchived(pkg.storage_state)) continue
        try {
          await applyStorageState(filename, { storageState: 'archived', libraryDirId: dirId })
          archived.push(filename)
        } catch (err) {
          console.warn(`Archive move failed for ${filename}:`, err.message)
        }
      }
      // 2. Rebuild so the batch's redownloadable demand lifts (Rule 1) and the
      //    replaceable set reflects the fresh catalog.
      buildFromDb()
      // 3. The batch just went inactive, so its extracted presets follow it down.
      await syncExtractedPresets(archived)
      // 4. Re-settle the batch's dep closure: prune redownloadable / relocate local-only
      //    (prune) or move the whole unneeded closure into the archive (store). Deps still
      //    needed by non-archived packages settle down naturally instead of moving.
      const closure = new Set()
      for (const fn of archived) for (const dep of getTransitiveDeps(fn, getForwardDeps())) closure.add(dep)
      let res = { pruned: 0, relocatedToArchive: 0, settledDown: 0 }
      if (closure.size > 0) {
        res = await resettleDeps(closure, { vamDir, prune: mode === 'prune' })
        buildFromDb()
      }
      notify('packages:updated')
      notify('contents:updated')
      return {
        ok: true,
        archived: archived.length,
        pruned: res.pruned,
        storedToArchive: res.relocatedToArchive,
        settledDown: res.settledDown,
      }
    })
  })

  // Install from archive: activate the explicitly selected archived packages and
  // download their (transitively) missing dependencies. Thin composition of existing
  // machinery — enable (cascade-enables inactive deps, incl. pulling archived deps out
  // of the archive keeping their sticky is_direct), promote only the selected filenames
  // to direct, then enqueue transitive missing downloads per selected package.
  ipcMain.handle('packages:install-from-archive', async (_, filenameOrFilenames) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    const filenames = normalizeFilenameArgs(filenameOrFilenames).filter((fn) => {
      const pkg = getPackageIndex().get(fn)
      return pkg && isPackageArchived(pkg.storage_state)
    })
    if (filenames.length === 0) return { ok: true, count: 0 }

    // 1. Enable (moves to main enabled + cascade-enables inactive deps from disk).
    await applyStorageStateChange(filenames, () => 'enable')

    // 2. Promote only the explicitly selected packages to direct (explicit selection
    //    is user intent); cascade-activated deps keep their sticky is_direct.
    for (const filename of filenames) {
      setPackageDirect(filename, true)
      touchPackageFirstSeen(filename)
      await syncAutoHideAfterDirectChange(vamDir, filename, true)
    }
    const prefs = await readAllPrefs(vamDir)
    setPrefsMap(prefs)
    buildFromDb({ skipGraph: true })

    // 3. Queue the transitively-missing deps of each activated package from the Hub
    //    (covers missing refs of the just-activated deps too).
    let queued = 0
    for (const filename of filenames) {
      try {
        const res = await enqueueInstallMissing(filename, true)
        if (res && typeof res.queued === 'number') queued += res.queued
      } catch (err) {
        console.warn(`Install-from-archive dep enqueue failed for ${filename}:`, err.message)
      }
    }

    notify('packages:updated')
    notify('contents:updated')
    return { ok: true, count: filenames.length, queued }
  })

  // Local-only preview for the Install-from-archive dialog: the same transitive
  // missing refs `enqueueInstallMissing` will try to fetch. Renderer enriches
  // these via `packages:enrich-from-hub` without blocking dialog open.
  ipcMain.handle('packages:install-from-archive-preview', async (_, filenameOrFilenames) => {
    const filenames = normalizeFilenameArgs(filenameOrFilenames)
    const refs = new Set()
    for (const fn of filenames) {
      const pkg = getPackageIndex().get(fn)
      if (!pkg || !isPackageArchived(pkg.storage_state)) continue
      for (const ref of getTransitiveMissingRefs(fn, { includeFallbacks: true })) refs.add(ref)
    }
    return { refs: [...refs] }
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

  // Enable all currently-inactive (disabled/offloaded) transitive dependencies of
  // the given package(s), without touching the package itself. Backs the "enable
  // them all" action surfaced when an active package has inactive deps.
  ipcMain.handle('packages:enable-deps', async (_, filenameOrFilenames) => {
    const toEnable = new Set()
    for (const filename of normalizeFilenameArgs(filenameOrFilenames)) {
      for (const dep of computeCascadeEnable(filename, getPackageIndex(), getForwardDeps())) toEnable.add(dep)
    }
    if (toEnable.size === 0) return { ok: true, count: 0 }
    const res = await applyStorageStateChange([...toEnable], () => 'enable')
    return { ok: true, count: toEnable.size, result: res }
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

  // Resolve what the Hub would *actually* serve for each requested `.var` stem.
  //
  // `findPackages` does not fail on a version it doesn't have — it silently falls
  // back to the nearest one it does (asking for `Creator.Pkg.9999` returns
  // `Creator.Pkg.6.var`, with a working URL for v6). So the requested stem says
  // nothing about what a download would produce, and callers must reconcile
  // against the *returned* filename instead: hence `filename` / `version` /
  // `installedLocally` alongside the URL. Comparing those is the whole of the
  // caller-side policy — an update is only an update if the resolved version
  // beats the installed one, and a missing dep is only installable if the
  // resolved file isn't already on disk.
  //
  // Every requested stem is seeded so callers can distinguish "not on Hub / no
  // URL" (null) from "enrichment hasn't returned yet" (undefined). Without this,
  // a stem missing from `results` would leave downloadUrl undefined on the caller
  // side, causing the UI to offer Install for something the Hub can't actually
  // serve, and the install IPC then fails with "No download URL".
  ipcMain.handle('packages:enrich-from-hub', async (_, packageStems) => {
    if (!packageStems?.length) return {}
    const results = await findPackages(packageStems)
    const enriched = {}
    const isReal = (v) => v && v !== 'null'
    for (const stem of packageStems) {
      enriched[stem] = { fileSize: null, downloadUrl: null, filename: null, version: null, installedLocally: false }
    }
    for (const [stem, hubFile] of Object.entries(results)) {
      const filename = isReal(hubFile.filename) ? ensureVarExt(hubFile.filename) : null
      const parsed = filename ? parseVarFilename(filename) : null
      enriched[stem] = {
        fileSize: isReal(hubFile.file_size) ? parseInt(hubFile.file_size, 10) || null : null,
        downloadUrl: filename ? resolveHubDownloadUrl(hubFile) : null,
        filename,
        version: parsed ? Number(parsed.version) : null,
        installedLocally: !!(filename && findLocalByFilename(filename)),
      }
    }
    return enriched
  })

  ipcMain.handle('packages:remove-orphans', async () => {
    const orphans = getOrphanSet()
    if (orphans.size === 0) return { ok: true, count: 0, freedBytes: 0 }

    return withBulkWindow(async () => {
      let freedBytes = 0
      // Surviving deps of the removed orphans may need to settle down now that an
      // orphan no longer demands them (captured before deletion).
      const resettleCandidates = new Set()
      for (const fn of orphans) {
        for (const dep of getTransitiveDeps(fn, getForwardDeps())) {
          if (!orphans.has(dep)) resettleCandidates.add(dep)
        }
      }
      for (const fn of orphans) {
        const pkg = getPackageIndex().get(fn)
        if (pkg) freedBytes += pkg.size_bytes
        await unlinkPackagePhysicalAndAliases(pkg, fn)
        deletePackage(fn)
      }

      buildFromDb()
      let movedToArchive = 0
      if (resettleCandidates.size > 0) {
        const res = await resettleDeps(resettleCandidates, { vamDir: getSetting('vam_dir') })
        movedToArchive = res.relocatedToArchive
        if (res.pruned || res.relocatedToArchive || res.settledDown) buildFromDb()
      }
      notify('packages:updated')
      notify('contents:updated')
      return { ok: true, count: orphans.size, freedBytes, movedToArchive }
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

  // Import a .var supplied as raw bytes (drag-and-drop add). Works locally and
  // over the remote bridge — a client head ships the file buffer here and the
  // server writes it into its own AddonPackages.
  // Local fast path: main copies the dropped file straight from its source path
  // (reflink where supported), skipping the renderer/IPC byte streaming. Only
  // valid when main can see the file — i.e. not a remote head. Joins the
  // owner's import batch so the graph rebuild waits for commit.
  ipcMain.handle('packages:import-local-copy', async (event, { filename, sourcePath, move }) => {
    return await importLocalFromPath({ filename, sourcePath, move: !!move }, event.remoteWs || 'local')
  })

  // Batch import protocol: precheck → chunk* → commit (or abort). Chunks are
  // windowed on the client; the server integrates completed files on a serial
  // queue and runs one graph rebuild at commit. See docs/Implementation.md.
  ipcMain.handle('packages:import-local-precheck', async (_, { filenames }) => {
    return importPrecheck({ filenames })
  })

  ipcMain.handle('packages:import-local-chunk', async (event, { uploadId, filename, bytes, first, last }) => {
    return await importChunk({ uploadId, filename, bytes, first, last }, event.remoteWs || 'local')
  })

  ipcMain.handle('packages:import-local-commit', async (event) => {
    return await importCommit(event.remoteWs || 'local')
  })

  ipcMain.handle('packages:import-local-abort', async (event, { uploadId } = {}) => {
    return await importAbort({ uploadId }, event.remoteWs || 'local')
  })

  // Remote client disconnect: destroy open upload streams and finish the graph
  // phase for anything already integrated so the library isn't left stale.
  onClientClose((ws) => {
    void cleanupOwner(ws)
  })

  ipcMain.handle('packages:file-list', async (_, filename) => {
    const pkg = getPackageIndex().get(filename)
    if (!pkg) throw new Error(`Package not found: ${filename}`)
    const varPath = await resolveContentPath(pkg)
    if (!varPath) throw new Error('Library directory not configured')
    await access(varPath)
    const { fileList } = await readVar(varPath)
    return { fileList, varPath }
  })

  // Returns `null` — not `{}` — when the CDN index is unreachable and nothing is
  // cached. An empty object is an authoritative "nothing to update", which the
  // Library facet would render as a confident `0`; `null` lets it stay unknown.
  ipcMain.handle('packages:check-updates', async (_, { forceRefresh } = {}) => {
    // Fetch or refresh the CDN packages index
    const STALE_MS = 5 * 60 * 1000
    if (!getPackagesIndex() || forceRefresh || getPackagesIndexAge() > STALE_MS) {
      try {
        await fetchPackagesJson({ force: !!forceRefresh })
      } catch (err) {
        console.warn('[check-updates] Failed to fetch packages.json:', err.message)
        if (!getPackagesIndex()) return null
      }
    }

    return checkUpdatesFromIndex(getPackageIndex(), getGroupIndex(), getForwardDeps())
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
      const res = await net.fetch(downloadUrl, {
        headers: { Cookie: 'vamhubconsent=yes' },
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
        // `finalPath` is always the bare `.var`, so the fresh content lands there.
        // If the package was disabled, recreate the empty `.var.disabled` marker
        // beside it (VaM-native marker layout) — otherwise the redownload would
        // silently re-enable a package the user had disabled. This also normalizes
        // a legacy suffix-disabled package to the marker layout on redownload.
        if (pkg.storage_state === 'disabled') {
          const markerPath = finalPath + '.disabled'
          recordOwnedPath(markerPath)
          await writeFile(markerPath, '')
        }
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
      // Bytes replaced in place; Hub link is usually already set. enrich is a
      // no-op for linked rows and respects hub_name_checked_at for unlinked ones.
      enrichNewPackages([filename])
      return { ok: true }
    } catch (err) {
      try {
        await unlink(tempPath)
      } catch {}
      throw err
    }
  })
}
