/**
 * Reconcile the loose extracted-preset lifecycle (enable/disable) against the
 * current package state. This is the single applier shared by every path that
 * can change whether an extracted preset's owning package is active:
 *
 *   - the interactive toggle (`ipc/packages.js`) — targeted by the filenames it
 *     just flipped,
 *   - the file watcher (`watcher.js`) — full sweep, because an *external*
 *     enable/disable/remove can affect any preset and a removed package leaves
 *     the store entirely (tombstoned), so it can't be reached by filename,
 *   - the startup scan (`scanner/index.js`) — full sweep, to heal drift that
 *     happened while the app was closed.
 *
 * A preset is disabled (`X.vap.disabled`) when no candidate version is active,
 * and enabled otherwise. Only the `.vap` (marker) is renamed; every user setting
 * (labels, `.fav`/`.hide` prefs) binds to the canonical live path, so nothing
 * has to be migrated on a toggle. Renames go through `recordOwnedPath` so the
 * watcher treats them as app-owned. Nothing here touches the DB/store — callers
 * run their own `runLocalScan`/`buildFromDb`/notify once we report a change.
 */

import { join } from 'path'
import { rename, unlink } from 'fs/promises'
import { recordOwnedPath } from '../watcher.js'
import { getExtractedByPackage, getAllExtractedLocalItems, getPackageIndex, buildFromDb } from '../store.js'
import { runLocalScan } from '../scanner/local.js'
import { isPackageActive } from '@shared/storage-state-predicates.js'
import { extractedRenamePlan, extractedShouldDisable, extractedDeletePaths } from './extracted-lifecycle.js'

/**
 * Rename a loose file (relative to vamDir) and record both paths as app-owned so
 * the watcher doesn't treat the rename as an external change. `optional` swallows
 * ENOENT (e.g. a missing sidecar). Returns whether the rename succeeded.
 */
async function renameLoose(vamDir, fromRel, toRel, { optional = false } = {}) {
  const from = join(vamDir, fromRel)
  const to = join(vamDir, toRel)
  recordOwnedPath(from)
  recordOwnedPath(to)
  try {
    await rename(from, to)
    return true
  } catch (err) {
    if (!optional) console.warn(`Extracted preset rename failed (${fromRel} -> ${toRel}):`, err.message)
    return false
  }
}

/** Apply the disable/enable rename plan for one loose preset (see extractedRenamePlan). */
async function setExtractedPresetDisabled(vamDir, internalPath, disable) {
  const [main] = extractedRenamePlan(internalPath, disable)
  return renameLoose(vamDir, main.from, main.to)
}

/** Iterate deduped extracted items claimed by any of `filenames`. */
export function* extractedItemsFor(filenames) {
  const byPkg = getExtractedByPackage()
  const seen = new Set()
  for (const fn of filenames) {
    for (const item of byPkg.get(fn) || []) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      yield item
    }
  }
}

/**
 * Bring extracted presets into line with their owners: disable (`X.vap.disabled`)
 * when no candidate version is active, re-enable when one is. Idempotent —
 * renames only on a mismatch.
 *
 * `filenames`:
 *   - a Set/array -> targeted: only presets claimed by those packages (fast path
 *     for the interactive toggle, where the flipped packages are still present).
 *   - null (default) -> full sweep over every local extracted preset, including
 *     orphaned ones whose owning versions were all removed (empty candidate set
 *     reads as "no active candidate" -> disabled, never deleted). Removal is
 *     reversible via tombstones, so the preset re-enables if the package returns.
 *
 * Returns `{ changed }` (count of presets renamed). Callers reconcile the store.
 */
export async function reconcileExtractedLifecycle({ vamDir, filenames = null } = {}) {
  if (!vamDir) return { changed: 0 }
  const items = filenames == null ? getAllExtractedLocalItems() : [...extractedItemsFor(filenames)]
  if (items.length === 0) return { changed: 0 }
  const pkgIndex = getPackageIndex()
  const isActive = (cf) => {
    const p = pkgIndex.get(cf)
    return !!p && isPackageActive(p.storage_state)
  }
  let changed = 0
  for (const item of items) {
    const shouldDisable = extractedShouldDisable(item.extractedCandidates, isActive)
    const currentlyDisabled = item.internal_path.endsWith('.disabled')
    if (shouldDisable === currentlyDisabled) continue
    if (await setExtractedPresetDisabled(vamDir, item.internal_path, shouldDisable)) changed++
  }
  return { changed }
}

/**
 * Commit an extracted-preset filesystem mutation (rename or unlink) to the store:
 * the change leaves the `__local__` content rows pointing at the stale path, so
 * when `count > 0` we rescan the loose dirs (updates `internal_path`) and rebuild
 * the store (`skipGraph` — preset moves never touch the package graph). Prefs and
 * labels bind to the canonical live path, so they need no migration here — the
 * rebuild re-merges them onto the renamed row. Announcing is left to the caller,
 * whose notify strategy differs (immediate `contents:updated`, a batched flag, or
 * none mid-scan).
 */
async function resyncLooseIfChanged(vamDir, count) {
  if (count > 0) {
    await runLocalScan(vamDir)
    buildFromDb({ skipGraph: true })
  }
}

/** `reconcileExtractedLifecycle` + the shared store resync. Returns `{ changed }`. */
export async function reconcileExtractedLifecycleAndResync({ vamDir, filenames = null } = {}) {
  const { changed } = await reconcileExtractedLifecycle({ vamDir, filenames })
  await resyncLooseIfChanged(vamDir, changed)
  return { changed }
}

/**
 * Permanently delete extracted presets no present package still claims (empty
 * candidate set). This is the delete counterpart to the disable-on-removal
 * reconcile above, invoked from the "Forget deleted packages" maintenance action
 * once the tombstoned owners become permanent deletions. Best-effort unlink of
 * every sibling form (see `extractedDeletePaths`). Should run inside a bulk
 * window so the resulting watcher events are filtered. Returns `{ removed }`.
 */
export async function deleteOrphanedExtractedPresets({ vamDir }) {
  if (!vamDir) return { removed: 0 }
  let removed = 0
  for (const item of getAllExtractedLocalItems()) {
    if (item.extractedCandidates.length > 0) continue
    for (const rel of extractedDeletePaths(item.internal_path)) {
      const p = join(vamDir, rel)
      recordOwnedPath(p)
      try {
        await unlink(p)
      } catch {}
    }
    removed++
  }
  return { removed }
}

/** `deleteOrphanedExtractedPresets` + the shared store resync. Caller supplies the
 *  bulk window (so the unlinks are app-owned) and decides how to notify. Returns
 *  `{ removed }`. */
export async function deleteOrphanedExtractedPresetsAndResync({ vamDir }) {
  const { removed } = await deleteOrphanedExtractedPresets({ vamDir })
  await resyncLooseIfChanged(vamDir, removed)
  return { removed }
}
