/**
 * applyStorageState — the single chokepoint for app-initiated changes to a
 * package's physical location and on-disk name.
 *
 * Every caller that wants to enable/disable/offload a package goes through
 * here. It performs an `fs.rename` (aux dirs are guaranteed same-FS as main
 * by the registration probe in `ipc/library-dirs.js`), updates the DB row
 * (`storage_state` + `library_dir_id`), patches the in-memory store, and
 * suppresses the watcher for both source and dest paths.
 *
 * External (watcher-observed) state changes are reconciled separately by
 * `watcher.js` and never go through this function.
 */

import { rename } from 'fs/promises'
import { join } from 'path'
import { getPackageIndex, patchStorageState } from './store.js'
import { setStorageState } from './db.js'
import { suppressPath } from './watcher.js'
import { getLibraryDirPath, pkgVarPath } from './library-dirs.js'
import { isLocalPackage } from '@shared/local-package.js'
import { STORAGE_STATES } from '@shared/storage-state-predicates.js'

const VALID_STORAGE_STATES = new Set(STORAGE_STATES)

/**
 * @param {string} filename canonical .var filename (PK)
 * @param {{ storageState: 'enabled'|'disabled'|'offloaded', libraryDirId: number|null }} target
 * @returns {Promise<{ ok: boolean, fromPath: string|null, toPath: string, changed: boolean }>}
 */
export async function applyStorageState(filename, target) {
  // `__local__` is a synthetic sentinel package owning loose Saves/Custom content.
  // It has no `.var` file on disk, so any rename here would ENOENT. Treat as a no-op.
  // Filter at the chokepoint so neither toggle/set-enabled nor download paths can
  // ever attempt to "enable" or "offload" loose content as if it were a package.
  if (isLocalPackage(filename)) return { ok: true, fromPath: null, toPath: null, changed: false }
  if (!target || !VALID_STORAGE_STATES.has(target.storageState)) {
    throw new Error(`Invalid storageState: ${target?.storageState} (filename=${filename})`)
  }
  if (target.storageState === 'offloaded' && target.libraryDirId == null) {
    throw new Error(`Illegal target: offloaded requires a libraryDirId (filename=${filename})`)
  }
  if (target.storageState !== 'offloaded' && target.libraryDirId != null) {
    throw new Error(`Illegal target: ${target.storageState} must have libraryDirId=null (filename=${filename})`)
  }

  const pkg = getPackageIndex().get(filename)
  if (!pkg) throw new Error(`Package not in store: ${filename}`)

  const fromPath = pkgVarPath(pkg)
  if (!fromPath) {
    // pkgVarPath returns null when the package's library_dir_id points at a dir
    // that's no longer registered. Refuse to operate — caller should treat this
    // as a stale row that needs a rescan.
    throw new Error(
      `Cannot resolve current path for ${filename} (library_dir_id=${pkg.library_dir_id}); aux dir missing?`,
    )
  }
  const targetDir = getLibraryDirPath(target.libraryDirId)
  if (!targetDir) throw new Error(`Library directory not configured for libraryDirId=${target.libraryDirId}`)

  // The on-disk suffix is implied by storage_state: `.disabled` only when storage_state
  // is 'disabled' (and only ever in main, since aux dirs are always suffix-less).
  const targetName = target.storageState === 'disabled' ? filename + '.disabled' : filename
  const toPath = join(targetDir, targetName)

  // Already at target — nothing to do. In practice callers (toggle-enabled,
  // postDownloadIntegrate) short-circuit no-ops upstream via nextStorageStateForIntent /
  // computeInstallTarget returning null, so this is mostly defensive. (If memory
  // disagrees with disk here it's a watcher-reconciliation responsibility, not ours.)
  if (fromPath === toPath) return { ok: true, fromPath, toPath, changed: false }

  suppressPath(fromPath)
  suppressPath(toPath)

  try {
    await rename(fromPath, toPath)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Source file missing for ${filename}: ${fromPath}`)
    }
    throw err
  }

  setStorageState(filename, target.storageState, target.libraryDirId ?? null)
  // Patch in-memory store: package row + `storageState` on every content row in
  // `contentByPackage`. Without this, ContentView (which reads `contentByPackage`)
  // goes stale until a rescan rebuilds the store.
  patchStorageState([filename], target.storageState, target.libraryDirId ?? null)
  return { ok: true, fromPath, toPath, changed: true }
}

/**
 * Map (currentState, intent, disableTarget) -> target. Pure helper for tests + handlers.
 *
 * `disableTarget` is the resolved target for a disable intent (caller parses
 * `disable_behavior` via `parseDisableBehavior` and packages the result), e.g.
 * `{ storageState: 'disabled', libraryDirId: null }` or
 * `{ storageState: 'offloaded', libraryDirId: <auxDirId> }`. Defaults to the
 * suffix-rename behavior when omitted.
 */
export function nextStorageStateForIntent({ current, intent, disableTarget }) {
  if (intent === 'enable') {
    return current === 'enabled' ? null : { storageState: 'enabled', libraryDirId: null }
  }
  if (intent === 'disable') {
    if (current !== 'enabled') return null
    return disableTarget ?? { storageState: 'disabled', libraryDirId: null }
  }
  return null
}

/**
 * Compute install target for a freshly downloaded package, per plan §"Dep install target":
 * target = max(storage_state of installed dependents) under enabled > disabled > offloaded.
 *
 * Returns `null` when the file should stay enabled in main (the default landing state after
 * `scanAndUpsert`, so no relocation is needed). Returns a target otherwise.
 *
 * For offloaded targets, picks an aux dir from the dependents' homes — preferring the
 * configured `disable_behavior` target if it matches one of those dirs.
 *
 * Aux dir validity: dependents reference live aux dirs because `library-dirs:remove`
 * refuses to delete a non-empty dir (and the FK is `ON DELETE RESTRICT`), so any
 * `library_dir_id` we see here must still exist.
 *
 * @param {{
 *   dependents: Set<string> | null,
 *   packageIndex: Map<string, { storage_state: string, library_dir_id: number|null }>,
 *   disableBehaviorTargetId?: number|null,
 * }} params
 */
export function computeInstallTarget({ dependents, packageIndex, disableBehaviorTargetId = null }) {
  if (!dependents || dependents.size === 0) return null
  let hasEnabled = false
  let hasDisabled = false
  const offloadDirs = new Set()
  for (const fn of dependents) {
    const dep = packageIndex.get(fn)
    if (!dep) continue
    if (dep.storage_state === 'enabled') hasEnabled = true
    else if (dep.storage_state === 'disabled') hasDisabled = true
    else if (dep.storage_state === 'offloaded' && dep.library_dir_id != null) {
      offloadDirs.add(dep.library_dir_id)
    }
  }
  if (hasEnabled) return null
  if (hasDisabled) return { storageState: 'disabled', libraryDirId: null }
  if (offloadDirs.size === 0) return null
  const targetId =
    disableBehaviorTargetId != null && offloadDirs.has(disableBehaviorTargetId)
      ? disableBehaviorTargetId
      : offloadDirs.values().next().value
  return { storageState: 'offloaded', libraryDirId: targetId }
}

// Re-exported for legacy import sites; canonical home is `src/shared/disable-behavior.js`.
export { parseDisableBehavior } from '@shared/disable-behavior.js'
