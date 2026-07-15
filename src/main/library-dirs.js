/**
 * Library directories registry and physical path resolution.
 *
 * Main directory (`{vamDir}/AddonPackages`) is always present and represented
 * by `library_dir_id IS NULL` — it is not a row in the `library_dirs` table.
 * Aux dirs are user-registered offload directories (rows in `library_dirs`).
 *
 * Two helpers answer "where does this package live?":
 *  - `pkgVarPath(pkg)` returns the *nominal* path — `<dir>/<subpath>/<filename>`,
 *    always the canonical bare `.var` name. That IS where the content bytes live
 *    for enabled and offloaded rows, and for a VaM-native marker-disabled row
 *    (bytes in the bare `.var` beside an empty `.var.disabled` marker). It is the
 *    right target for writers/deleters and for the companion `.jpg` dirname.
 *  - `resolveContentPath(pkg)` (async) returns where the bytes *physically* are,
 *    probing disk for disabled rows. It only differs from the nominal path for a
 *    legacy rename-disabled package whose content sits in `X.var.disabled`, or a
 *    Qvaro-disabled one whose content sits in `X.DISABLED`, with no bare sibling.
 *    Readers that open the archive route through it.
 *
 * We deliberately do NOT cache the physical basename in the DB: reads that need
 * the bytes are rare, one-off, and already hit the disk, so a couple of extra
 * `stat`s cost nothing and the disk stays the single source of truth (no
 * staleness). Aux dirs are always suffix-less; any stray `.var.disabled` there is
 * normalized to bare `.var` on scan/add.
 *
 * A `.var` may live in a subfolder of its library dir, not only at the root —
 * VaM loads packages from anywhere under `AddonPackages`. `pkg.subpath` records
 * that relative folder (POSIX-style, '' at the root); `pkgVarPath` joins it back
 * in so nested packages resolve correctly. `libraryRelSubpath` is the inverse,
 * deriving `subpath` from a discovered on-disk path during scan/watch.
 */

import { join, relative, dirname, sep, isAbsolute } from 'path'
import { realpath, stat } from 'fs/promises'
import { ADDON_PACKAGES, ADDON_PACKAGES_FILE_PREFS } from '@shared/paths.js'
import { LOCAL_CONTENT_DIRS } from '@shared/local-package.js'
import { classifyMainVar } from './disable-layout.js'
import { qvaroDisabledName } from './scanner/var-reader.js'
import { getSetting, listLibraryDirs as dbListLibraryDirs } from './db.js'

let auxDirsById = new Map() // id -> { id, path, created_at }
let auxDirsByPath = new Map() // path -> entry

/** Reload the in-memory registry from DB. Call after add/remove/migration. */
export function refreshLibraryDirs() {
  auxDirsById = new Map()
  auxDirsByPath = new Map()
  for (const row of dbListLibraryDirs()) {
    auxDirsById.set(row.id, row)
    auxDirsByPath.set(row.path, row)
  }
}

export function getMainLibraryDirPath() {
  const vamDir = getSetting('vam_dir')
  return vamDir ? join(vamDir, ADDON_PACKAGES) : null
}

/**
 * Resolve a library_dir_id to its absolute path on disk.
 * NULL → main `{vamDir}/AddonPackages`. Unknown id → null.
 */
export function getLibraryDirPath(libraryDirId) {
  if (libraryDirId == null) return getMainLibraryDirPath()
  return auxDirsById.get(libraryDirId)?.path ?? null
}

/** Return all library dirs as `[{id|null, path}]`, main first. */
export function getAllLibraryDirs() {
  const out = []
  const main = getMainLibraryDirPath()
  if (main) out.push({ id: null, path: main })
  for (const row of auxDirsById.values()) out.push({ id: row.id, path: row.path })
  return out
}

/** Aux dirs only — for Settings UI and management IPC. */
export function getAuxLibraryDirs() {
  return [...auxDirsById.values()]
}

/**
 * True when the given aux dir has JayJayWon BrowserAssist sidecar mode enabled.
 * Main (`null`) is never a BrowserAssist dir. Reflects the in-memory registry, so
 * callers must have `refreshLibraryDirs()`'d after a mode flip (the IPC handler does).
 */
export function isBrowserAssistLibraryDir(libraryDirId) {
  if (libraryDirId == null) return false
  return !!auxDirsById.get(libraryDirId)?.browser_assist
}

/**
 * Resolve the *nominal* absolute path for a package row — its library dir joined
 * with `subpath` and the canonical bare `filename`. Returns null if the library
 * dir is unknown (e.g. aux dir was removed from registry).
 *
 * This is where the bytes live for enabled/offloaded rows and for a VaM-native
 * marker-disabled row (bare `.var` beside an empty marker). It is the correct
 * target for writers/deleters (they always normalize to the bare name) and for
 * locating the companion `.jpg`. For a package whose bytes might sit in a
 * `.var.disabled` sibling (legacy rename), readers that open the archive must
 * use `resolveContentPath` instead.
 */
export function pkgVarPath(pkg) {
  if (!pkg) return null
  const dir = getLibraryDirPath(pkg.library_dir_id)
  if (!dir) return null
  const sub = pkg.subpath || ''
  return sub ? join(dir, sub, pkg.filename) : join(dir, pkg.filename)
}

/**
 * Resolve where a package's content bytes physically live, reading the disk for
 * disabled rows so a legacy rename-disabled package (bytes in `X.var.disabled`,
 * no bare sibling) resolves to the suffixed file. Enabled and offloaded rows —
 * and marker-disabled rows — always keep their bytes at the nominal bare `.var`,
 * so those short-circuit without touching the disk (an offloaded package on an
 * unmounted drive therefore never blocks on a stat here).
 *
 * Falls back to the nominal path when disk classification finds nothing (missing
 * file / unreachable); the caller's subsequent open then surfaces the ENOENT.
 * Returns null only when the library dir is unknown.
 */
export async function resolveContentPath(pkg) {
  const nominal = pkgVarPath(pkg)
  if (!nominal) return null

  if (pkg.storage_state === 'disabled') {
    // Main disabled: bytes may sit in the bare `.var` (VaM marker layout), a
    // `.var.disabled` sibling (legacy rename), or a Qvaro `.DISABLED` rename.
    // Re-derive from the siblings on disk.
    const cls = await classifyMainVarOnDisk(nominal)
    return cls.present ? cls.contentPath : nominal
  }

  // enabled: bytes are always at the bare nominal path — no disk probe.
  // offloaded: also nominal today (aux dirs are normalized to bare, offloaded ==
  // active). This branch is the single home for any future offload-specific
  // resolution — e.g. a per-aux-dir mode where bytes are stored flattened with a
  // sidecar (JayJayWon BrowserAssist), or any other scheme an aux dir might grow.
  // Such logic is a *different mechanism* than main's size-based `.disabled`
  // classification, so it belongs here (keyed on the aux dir's mode), not in
  // `classifyMainVar`. Keep the unmounted-drive invariant: probe only when the
  // resolved layout genuinely differs from nominal, and fall back to nominal so a
  // detached offload drive never blocks on a stat.
  return nominal
}

/**
 * Inspect a canonical `.var`'s bare + disabled-sibling files at an absolute bare
 * path in a MAIN library dir and report the on-disk truth. This is the single
 * fs-level classifier shared by the scanner, watcher, and `applyStorageState`,
 * so "look at the siblings and decide enabled / marker-disabled / suffix-disabled"
 * lives in exactly one place. `barePath` is `<dir>/<canonical>`.
 *
 * The disabled sibling has two possible spellings, tried in order: VaM's
 * `barePath + '.disabled'` (marker or legacy suffix) and the Qvaro rename that
 * swaps the trailing `.var` for `.DISABLED`. Only the spelling differs — the
 * size-based verdict is identical — so `classifyMainVar` stays name-agnostic.
 *
 * Returns the `classifyMainVar` verdict plus the resolved paths and the `stat`
 * of the file actually holding the content bytes (both null when not present):
 *   `{ present, storageState?, contentPath, contentStat }`
 * `contentPath` is the disabled sibling for a suffix/Qvaro layout, else the bare
 * `.var`. (Aux dirs never carry a disabled encoding — callers handle offloaded
 * bare files directly, not through here.)
 *
 * `disabledKnownAbsent`: callers that already enumerated the folder's dirents
 * (the scanner's walk) can assert no disabled sibling exists (neither spelling),
 * which skips both sibling stats — keeping the full-scan hot path at one syscall
 * per package while the verdict still comes from `classifyMainVar`.
 */
export async function classifyMainVarOnDisk(barePath, { disabledKnownAbsent = false } = {}) {
  const markerPath = barePath + '.disabled'
  const qvaroPath = qvaroDisabledName(barePath)
  const [bareStat, markerStat, qvaroStat] = await Promise.all([
    stat(barePath).catch(() => null),
    disabledKnownAbsent ? null : stat(markerPath).catch(() => null),
    disabledKnownAbsent ? null : stat(qvaroPath).catch(() => null),
  ])
  // Prefer VaM's `.var.disabled` spelling (whose *presence* — even empty — is the
  // marker). Fall back to a Qvaro `.DISABLED` rename only when it actually holds
  // content: Qvaro moves the package's bytes into that file rather than dropping
  // an empty sidecar, so an empty `.DISABLED` is not a disable signal.
  const useQvaro = !markerStat && qvaroStat && qvaroStat.size > 0
  const [disabledPath, disabledStat] = useQvaro ? [qvaroPath, qvaroStat] : [markerPath, markerStat]
  const cls = classifyMainVar({
    bareSize: bareStat ? bareStat.size : null,
    disabledSize: disabledStat ? disabledStat.size : null,
  })
  if (!cls.present) return { present: false, contentPath: null, contentStat: null }
  return {
    present: true,
    storageState: cls.storageState,
    contentPath: cls.contentInDisabled ? disabledPath : barePath,
    contentStat: cls.contentInDisabled ? disabledStat : bareStat,
  }
}

/**
 * Derive the subpath to store for a `.var` discovered at `fullPath` inside
 * `libraryDir`: the POSIX-normalized relative directory of the file's parent,
 * or '' when it sits at the library root. Returns '' defensively when the path
 * can't be expressed as a descendant of `libraryDir` (no dir, escaping `..`, or
 * a different drive) so a bad input never yields a traversal subpath.
 */
export function libraryRelSubpath(libraryDir, fullPath) {
  if (!libraryDir || !fullPath) return ''
  const rel = relative(libraryDir, dirname(fullPath))
  if (!rel || rel === '.') return ''
  if (rel.startsWith('..') || isAbsolute(rel)) return ''
  return rel.split(sep).join('/')
}

/** True when `child` is the same as or nested inside `parent`. */
function isPathInside(child, parent) {
  if (!child || !parent) return false
  const a = child.replace(/[\\/]+$/, '')
  const b = parent.replace(/[\\/]+$/, '')
  if (a === b) return true
  return a.startsWith(b + '/') || a.startsWith(b + '\\')
}

/** Resolve symlinks/normalization for comparison; fall back to the input on ENOENT. */
const resolvePath = (p) => realpath(p).catch(() => p)

/** Validation helper for `library-dirs:add`. Returns null on success, error string otherwise. */
export async function validateNewAuxDirPath(path) {
  if (!path || typeof path !== 'string') return 'Invalid path'
  const main = getMainLibraryDirPath()
  if (main) {
    if ((await resolvePath(path)) === (await resolvePath(main))) {
      return 'That folder is your main AddonPackages directory and is already part of your library.'
    }
    if (isPathInside(path, main) || isPathInside(main, path)) {
      return 'Offload directory cannot overlap the main AddonPackages directory'
    }
  }
  // Other VaM-managed roots the offload dir must stay clear of:
  //   • the prefs sidecar tree (where prefsWatcher fires), and
  //   • the monitored loose-content dirs (`LOCAL_CONTENT_DIRS` — where
  //     localWatcher / runLocalScan reign).
  // Overlap in EITHER direction is rejected: an offload dir nested inside one
  // would be double-walked/watched as loose content, and one that *contains* a
  // monitored dir would drag that actively-watched subtree under the package
  // watcher. Anything outside this set is fair game — which is what lets a
  // plugin's offload location (e.g. `Saves/PluginData/.../OffloadedVARs`,
  // outside `Saves/scene` and `Saves/Person`) be registered.
  const vamDir = getSetting('vam_dir')
  if (vamDir) {
    const forbiddenRoots = [join(vamDir, ADDON_PACKAGES_FILE_PREFS), ...LOCAL_CONTENT_DIRS.map((d) => join(vamDir, d))]
    for (const root of forbiddenRoots) {
      if (isPathInside(path, root) || isPathInside(root, path)) {
        return `Offload directory cannot overlap a VaM-managed directory: ${root}`
      }
    }
  }
  for (const aux of auxDirsById.values()) {
    if (isPathInside(path, aux.path) || isPathInside(aux.path, path)) {
      return `Offload directory overlaps an already-registered directory: ${aux.path}`
    }
  }
  return null
}
