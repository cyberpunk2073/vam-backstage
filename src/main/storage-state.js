/**
 * applyStorageState — the single chokepoint for app-initiated changes to a
 * package's physical location and on-disk name.
 *
 * Every caller that wants to enable/disable/offload a package goes through
 * here. It keeps the content bytes at the bare `.var` name and expresses
 * "disabled" the VaM-native way — an empty `.var.disabled` marker beside the
 * bare file — so disabling never renames content and enabling just removes the
 * marker (no rename onto real content). Relocations (offload / restore-from-aux
 * / legacy suffix→bare enable) use `fs.rename` guarded against overwriting a
 * different file (aux dirs are guaranteed same-FS as main by the registration
 * probe in `ipc/library-dirs.js`). It then updates the DB row (`storage_state`,
 * `library_dir_id`), patches the in-memory store, and
 * registers touched paths as app-owned with the watcher (effective only when
 * the caller wraps the bulk in `withBulkWindow`; outside a bulk window, the
 * watcher event is harmless because the cache check in `scanSingleVar` /
 * marker reconciliation is idempotent).
 *
 * Current on-disk location is resolved from the *filesystem*, not the cached
 * row, so an external swap done while the app was off can't cause data loss —
 * ambiguous states throw instead of guessing. External (watcher-observed) state
 * changes are reconciled separately by `watcher.js`.
 */

import { rename, mkdir, stat, lstat, unlink, writeFile } from 'fs/promises'
import { join, dirname } from 'path'
import { getPackageIndex, patchStorageState } from './store.js'
import { setStorageState } from './db.js'
import { recordOwnedPath, recordOwnedDirChain } from './watcher.js'
import { notifyToast } from './notify.js'
import {
  getLibraryDirPath,
  classifyMainVarOnDisk,
  isBrowserAssistLibraryDir,
  isArchiveLibraryDir,
} from './library-dirs.js'
import { writeSidecar, readSidecarSubpath, removeSidecar } from './browser-assist-sidecar.js'
import { isLocalPackage } from '@shared/local-package.js'
import { STORAGE_STATES } from '@shared/storage-state-predicates.js'

const VALID_STORAGE_STATES = new Set(STORAGE_STATES)

/** States whose bytes live bare inside an aux library dir (require a libraryDirId). */
const AUX_STORAGE_STATES = new Set(['offloaded', 'archived'])

/** enabled > disabled > offloaded > archived — used by planResettle settle-down check. */
const ACTIVENESS = { enabled: 3, disabled: 2, offloaded: 1, archived: 0 }

/**
 * Rename `from`→`to`, refusing to clobber anything unexpected already at `to`.
 * `to` is always a bare `.var` content path (never a marker), so a file sitting
 * there is only safe to replace when it's a plain regular file that is either:
 *   - byte-identical in size to the source (a redundant copy of the same
 *     content-addressed, immutable `.var`), or
 *   - empty (a 0-byte stub/placeholder — a leftover from an interrupted write or
 *     an external `touch` — which carries no content worth preserving).
 * Anything else — a different-size file, or fs weirdness (symlink, junction,
 * directory, device) — is refused rather than destroyed. We `lstat` (not `stat`)
 * the destination so a symlink is caught as a symlink instead of being followed
 * to its target's size: a link could otherwise report size 0 while pointing at
 * real content. This guard applies to every relocating rename (enable-from-suffix,
 * offload, restore-from-aux). Records both paths as app-owned.
 */
async function guardedRename(from, to) {
  const [fromStat, toStat] = await Promise.all([stat(from).catch(() => null), lstat(to).catch(() => null)])
  if (!fromStat) throw new Error(`Source file missing: ${from}`)
  if (toStat) {
    const replaceable = toStat.isFile() && (toStat.size === fromStat.size || toStat.size === 0)
    if (!replaceable) {
      throw new Error(
        `Refusing to move ${from} → ${to}: a different file already exists at the destination ` +
          `(${toStat.size} bytes vs source ${fromStat.size} bytes)`,
      )
    }
  }
  recordOwnedPath(from)
  recordOwnedPath(to)
  const destDir = dirname(to)
  recordOwnedDirChain(destDir, await mkdir(destDir, { recursive: true }))
  await rename(from, to)
}

/**
 * Ensure an empty `.var.disabled` marker exists at `markerPath` (VaM-native
 * disable). Idempotent when a 0-byte marker is already there. Throws if a
 * *non-empty* file occupies the marker path — we never create content there, so
 * that would be an unexpected on-disk state we won't silently overwrite.
 * Returns whether a marker was newly created.
 */
async function ensureEmptyMarker(markerPath) {
  const s = await stat(markerPath).catch(() => null)
  if (s) {
    if (s.size === 0) return false
    throw new Error(`Refusing to mark disabled: unexpected non-empty file at ${markerPath} (${s.size} bytes)`)
  }
  recordOwnedPath(markerPath)
  await writeFile(markerPath, '')
  return true
}

/**
 * Remove a `.var.disabled` marker/leftover in main without ever destroying real
 * content. Deletes only when the file is empty (a marker) or byte-identical in
 * size to the surviving content at `contentPath` (a redundant copy of the same
 * content-addressed `.var`); anything else throws. No-op when absent. Returns
 * whether a file was removed.
 */
async function removeDisabledMarker(markerPath, contentPath) {
  const s = await stat(markerPath).catch(() => null)
  if (!s) return false
  if (s.size !== 0) {
    const c = await stat(contentPath).catch(() => null)
    if (!c || c.size !== s.size) {
      throw new Error(
        `Refusing to remove ${markerPath}: not an empty marker and not a byte-identical copy of ${contentPath}`,
      )
    }
  }
  recordOwnedPath(markerPath)
  await unlink(markerPath)
  return true
}

/**
 * Resolve where the package's content bytes currently live, reading the real
 * filesystem (not the cached row) so an external swap done while the app was off
 * can't mislead us: we act on reality and throw on an ambiguous/absent state.
 * Offloaded packages are always bare in their aux dir; main packages are
 * classified from bare + `.disabled` sizes.
 */
async function resolveCurrentContentPath(pkg, mainBare) {
  const subpath = pkg.subpath || ''
  if (AUX_STORAGE_STATES.has(pkg.storage_state)) {
    const auxDir = getLibraryDirPath(pkg.library_dir_id)
    if (!auxDir) {
      throw new Error(`Cannot resolve current path for ${pkg.filename} (library_dir_id=${pkg.library_dir_id})`)
    }
    return subpath ? join(auxDir, subpath, pkg.filename) : join(auxDir, pkg.filename)
  }
  const cls = await classifyMainVarOnDisk(mainBare)
  if (!cls.present) throw new Error(`Source file missing for ${pkg.filename} in main (${mainBare})`)
  return cls.contentPath
}

/**
 * @param {string} filename canonical .var filename (PK)
 * @param {{ storageState: 'enabled'|'disabled'|'offloaded'|'archived', libraryDirId: number|null }} target
 * @returns {Promise<{ ok: boolean, fromPath: string|null, toPath: string|null, changed: boolean }>}
 */
export async function applyStorageState(filename, target) {
  // `__local__` is a synthetic sentinel package owning loose Saves/Custom content.
  // It has no `.var` file on disk, so any op here would ENOENT. Treat as a no-op.
  // Filter at the chokepoint so neither toggle/set-enabled nor download paths can
  // ever attempt to "enable" or "offload" loose content as if it were a package.
  if (isLocalPackage(filename)) return { ok: true, fromPath: null, toPath: null, changed: false }
  if (!target || !VALID_STORAGE_STATES.has(target.storageState)) {
    throw new Error(`Invalid storageState: ${target?.storageState} (filename=${filename})`)
  }
  // Offloaded and archived both live bare in an aux dir; the difference is the
  // dir's *role* (offload vs archive), so validate the target dir's role matches
  // the requested state — "location implies state" must not be violated by an
  // app-driven move that puts an offloaded byte-copy into an archive dir.
  if (AUX_STORAGE_STATES.has(target.storageState) && target.libraryDirId == null) {
    throw new Error(`Illegal target: ${target.storageState} requires a libraryDirId (filename=${filename})`)
  }
  if (!AUX_STORAGE_STATES.has(target.storageState) && target.libraryDirId != null) {
    throw new Error(`Illegal target: ${target.storageState} must have libraryDirId=null (filename=${filename})`)
  }
  if (target.storageState === 'archived' && !isArchiveLibraryDir(target.libraryDirId)) {
    throw new Error(`Illegal target: archived requires an archive-role libraryDirId (filename=${filename})`)
  }
  if (target.storageState === 'offloaded' && isArchiveLibraryDir(target.libraryDirId)) {
    throw new Error(`Illegal target: offloaded requires an offload-role libraryDirId (filename=${filename})`)
  }

  const pkg = getPackageIndex().get(filename)
  if (!pkg) throw new Error(`Package not in store: ${filename}`)

  const mainDir = getLibraryDirPath(null)
  if (!mainDir) throw new Error('Main library directory not configured')
  const targetDir = getLibraryDirPath(target.libraryDirId)
  if (!targetDir) throw new Error(`Library directory not configured for libraryDirId=${target.libraryDirId}`)

  // BrowserAssist sidecar mode on the source/target aux dir. A BA-mode dir keeps a
  // `<pkg>.var.json` sidecar recording the package's home in `AddonPackages` (its
  // "original folder"), so restore doesn't depend on the physical layout — BA
  // flattens to the aux root, we keep the mirrored subfolder, either works.
  //
  // Both checks are deliberately `offloaded`-only, not `AUX_STORAGE_STATES`: a BA
  // dir converted to archive role still holds sidecars we didn't write and can't
  // reconstruct, so leaving the archive must not delete them. Converting the dir
  // back to offload then restores BA's own behavior intact — role flips stay
  // reversible, at the cost of a stale sidecar beside a package that left an
  // archive-role BA dir (harmless: BA restores to the root without one).
  const sourceIsBrowserAssist =
    pkg.storage_state === 'offloaded' && isBrowserAssistLibraryDir(pkg.library_dir_id ?? null)
  const targetIsBrowserAssist =
    target.storageState === 'offloaded' && isBrowserAssistLibraryDir(target.libraryDirId ?? null)

  // Where the file physically sits now (used to read the bytes) — its tracked
  // subpath within its current library dir.
  const sourceSubpath = pkg.subpath || ''
  const mainBareAtSource = join(sourceSubpath ? join(mainDir, sourceSubpath) : mainDir, filename)
  const fromPath = await resolveCurrentContentPath(pkg, mainBareAtSource)

  // The package's home folder relative to `AddonPackages` ("original folder"):
  // normally the tracked subpath, but when leaving a BrowserAssist dir the sidecar
  // beside the file is authoritative (BA may have flattened the bytes to the aux
  // root while recording a nested restore folder in the sidecar).
  let originalFolder = sourceSubpath
  if (sourceIsBrowserAssist) {
    const restoreSubpath = await readSidecarSubpath(fromPath)
    if (restoreSubpath != null) originalFolder = restoreSubpath
  }

  // Preserve the subfolder across the move: a `.var` organized under
  // `<lib>/<subpath>/` stays there when enabled/disabled in place, and is mirrored
  // into (or restored from) another library dir at the same relative folder — so
  // toggles never silently flatten a curated layout and a round-trip is lossless.
  const withOrig = (dir) => (originalFolder ? join(dir, originalFolder) : dir)
  const mainMarker = join(withOrig(mainDir), filename) + '.disabled'
  // Content always lands at the bare name in the target dir — we never rename to
  // the suffix. Disabling instead drops an empty marker beside the bare file, so
  // an app-driven disable is always the VaM-native marker layout.
  const toPath = join(withOrig(targetDir), filename)

  // 1. Move the bytes to the target's bare name if they aren't already there.
  let moved = false
  if (fromPath !== toPath) {
    await guardedRename(fromPath, toPath)
    moved = true
  }

  // 2. Reconcile the main-dir `.var.disabled` marker with the target state.
  let markerChanged = false
  if (target.storageState === 'disabled') {
    markerChanged = await ensureEmptyMarker(mainMarker)
  } else {
    // enabled/offloaded: no marker may remain in main. For offload, `toPath` is
    // the aux copy — a same-size main leftover is then an identical duplicate.
    markerChanged = await removeDisabledMarker(mainMarker, toPath)
  }

  // 3. Reconcile BrowserAssist sidecars: drop the one beside the old aux copy when
  // leaving a BA dir, write a fresh one beside the new aux copy when entering one
  // (root-level packages need none). Do the remove before the write so a BA→BA
  // move can't delete a sidecar we just created for the same file.
  let sidecarChanged = false
  if (sourceIsBrowserAssist) sidecarChanged = (await removeSidecar(fromPath)) || sidecarChanged
  if (targetIsBrowserAssist) {
    try {
      sidecarChanged = (await writeSidecar(toPath, originalFolder)) || sidecarChanged
    } catch (err) {
      // Best-effort: the bytes already landed, so a failed sidecar must not abort
      // an otherwise-complete transition. BA tolerates a missing sidecar for a
      // non-root package (it restores to the root), so we log + toast and carry on
      // rather than roll back a good move.
      console.warn(`BrowserAssist sidecar write failed for ${toPath}:`, err.message)
      notifyToast(`Couldn't write BrowserAssist sidecar for ${filename}: ${err.message}`)
    }
  }

  // Every app-driven transition lands content in the bare name, so there is no
  // on-disk-name to record — the physical path is re-derived from disk on demand.
  // `originalFolder` is the file's folder within its new library dir (main or aux):
  // mirrored on offload, and the sidecar-recovered home on a BA restore.
  setStorageState(filename, target.storageState, target.libraryDirId ?? null, originalFolder)
  // Patch in-memory `packageIndex` row so the next `packages:list` (and the next
  // applyStorageState) reads the new state without a full rebuild. Must include
  // `originalFolder`: a BA restore can change subpath (flat aux → nested main)
  // and a stale '' would make the next offload look under AddonPackages root.
  // Content rows reference the package via `c.package` on the renderer and pick
  // up the patched value on relink.
  patchStorageState([filename], target.storageState, target.libraryDirId ?? null, originalFolder)
  return { ok: true, fromPath, toPath, changed: moved || markerChanged || sidecarChanged }
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
 * Compute install target for a freshly downloaded package:
 * target = max(storage_state of installed dependents) under enabled > disabled > offloaded > archived.
 *
 * Returns `null` when the file should stay enabled in main (the default landing state after
 * `scanAndUpsert`, so no relocation is needed). Returns a target otherwise.
 *
 * For offloaded/archived targets, picks an aux dir from the dependents' homes — for offload
 * preferring the configured `disable_behavior` target if it matches one of those dirs.
 *
 * The archived tier sits below offloaded: a dep whose *only* remaining dependents are
 * archived settles into an archive dir (used by the re-settle pass to relocate a
 * local-only dep alongside the hoard, and by a fresh download that is only demanded by
 * archived packages so it lands quietly archived rather than active in main).
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
  const archiveDirs = new Set()
  for (const fn of dependents) {
    const dep = packageIndex.get(fn)
    if (!dep) continue
    if (dep.storage_state === 'enabled') hasEnabled = true
    else if (dep.storage_state === 'disabled') hasDisabled = true
    else if (dep.storage_state === 'offloaded' && dep.library_dir_id != null) offloadDirs.add(dep.library_dir_id)
    else if (dep.storage_state === 'archived' && dep.library_dir_id != null) archiveDirs.add(dep.library_dir_id)
  }
  if (hasEnabled) return null
  if (hasDisabled) return { storageState: 'disabled', libraryDirId: null }
  if (offloadDirs.size > 0) {
    const targetId =
      disableBehaviorTargetId != null && offloadDirs.has(disableBehaviorTargetId)
        ? disableBehaviorTargetId
        : offloadDirs.values().next().value
    return { storageState: 'offloaded', libraryDirId: targetId }
  }
  if (archiveDirs.size === 0) return null
  return { storageState: 'archived', libraryDirId: archiveDirs.values().next().value }
}

/**
 * Pure planner for the re-settle pass (demand Rule 2). Given candidate
 * dep filenames and the current graph data, decide each *non-direct, non-archived*
 * candidate's fate as it settles to the max activeness of its remaining dependents:
 *   - target strictly less active than current → settle down (recorded in `decisions`)
 *   - target archived + redownloadable + `prune` → prune (recorded in `toPrune`)
 *   - target archived + local-only, or `prune` false → relocate into the archive
 *     (recorded in `decisions` with an archived target)
 *
 * Pruned candidates are treated as gone when computing later candidates' dependents,
 * and each decision feeds forward (via an internal overlay) so a dependency chain
 * settles consistently and the outcome is order-independent. No side effects — the
 * caller applies the plan (`applyStorageState` for decisions, delete for `toPrune`).
 *
 * Worklist, not a fixpoint sweep: a candidate only needs re-evaluating when one of
 * its own dependents moved, so a decision re-enqueues exactly the candidates that
 * watch it. Termination is by monotonicity — every re-evaluation that changes
 * anything moves a candidate strictly down a four-level ordering.
 *
 * `packageIndex` is any `{ get(fn) }` view: the live store index for execution, or a
 * simulated one (e.g. the archived batch overlaid) for a read-only dialog preview.
 *
 * @param {{
 *   candidates: Iterable<string>,
 *   packageIndex: { get(fn: string): any },
 *   reverseDeps: Map<string, Set<string>>,
 *   replaceableSet: Set<string>,
 *   disableBehaviorTargetId?: number|null,
 *   prune?: boolean,
 * }} params
 * @returns {{ toPrune: Set<string>, decisions: Map<string, { storageState: string, libraryDirId: number|null }> }}
 */
export function planResettle({
  candidates,
  packageIndex,
  reverseDeps,
  replaceableSet,
  disableBehaviorTargetId = null,
  prune = true,
}) {
  const overlay = new Map()
  const get = (fn) => overlay.get(fn) ?? packageIndex.get(fn)
  const simIndex = { get }
  const toPrune = new Set()
  const decisions = new Map()

  const queue = [...new Set(candidates)]
  // dependent filename → candidates whose target depends on that dependent's state.
  const watchers = new Map()
  for (const fn of queue) {
    for (const d of reverseDeps.get(fn) || []) {
      const list = watchers.get(d)
      if (list) list.push(fn)
      else watchers.set(d, [fn])
    }
  }
  const queued = new Set(queue)
  const enqueueWatchers = (fn) => {
    for (const w of watchers.get(fn) || []) {
      if (queued.has(w)) continue
      queued.add(w)
      queue.push(w)
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const fn = queue[head]
    queued.delete(fn)
    if (toPrune.has(fn)) continue
    const pkg = get(fn)
    if (!pkg || pkg.is_direct || pkg.storage_state === 'archived') continue
    const allDependents = reverseDeps.get(fn)
    const dependents = allDependents ? new Set([...allDependents].filter((d) => !toPrune.has(d))) : null
    const target = computeInstallTarget({ dependents, packageIndex: simIndex, disableBehaviorTargetId })
    // null ⇒ an enabled dependent remains (stay put) or no dependents at all (leave
    // to orphan cleanup — never pruned here). A prior decision reaching this on
    // re-evaluation means every dependent that drove it has since been pruned —
    // revert it and let the watchers reconsider.
    if (!target) {
      if (decisions.delete(fn)) {
        overlay.delete(fn)
        enqueueWatchers(fn)
      }
      continue
    }
    if ((ACTIVENESS[target.storageState] ?? -1) >= (ACTIVENESS[pkg.storage_state] ?? -1)) continue
    if (target.storageState === 'archived' && prune && replaceableSet.has(fn)) {
      toPrune.add(fn)
      // A settle-down decision recorded on an earlier pass (before this candidate's
      // own dependents moved) is superseded by the prune.
      decisions.delete(fn)
      overlay.delete(fn)
    } else {
      decisions.set(fn, { storageState: target.storageState, libraryDirId: target.libraryDirId })
      overlay.set(fn, { ...pkg, storage_state: target.storageState, library_dir_id: target.libraryDirId })
    }
    enqueueWatchers(fn)
  }
  return { toPrune, decisions }
}

// Re-exported for legacy import sites; canonical home is `src/shared/disable-behavior.js`.
export { parseDisableBehavior } from '@shared/disable-behavior.js'
