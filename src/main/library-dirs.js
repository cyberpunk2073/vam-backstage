/**
 * Library directories registry and physical path resolution.
 *
 * Main directory (`{vamDir}/AddonPackages`) is always present and represented
 * by `library_dir_id IS NULL` — it is not a row in the `library_dirs` table.
 * Aux dirs are user-registered offload directories (rows in `library_dirs`).
 *
 * The `pkgVarPath(pkg)` helper is the single source of truth for "where on
 * disk does this package live?" Every reader/writer/deleter that touches a
 * `.var` file must route through it. The on-disk suffix is implied by
 * `storage_state`: `.disabled` only when `storage_state === 'disabled'`
 * (which is only ever true in main). Aux dirs are always suffix-less; any
 * stray `.var.disabled` file there is normalized to bare `.var` on scan/add.
 */

import { join } from 'path'
import { ADDON_PACKAGES, ADDON_PACKAGES_FILE_PREFS } from '../shared/paths.js'
import { LOCAL_CONTENT_ROOTS } from '../shared/local-package.js'
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
 * Resolve the absolute physical .var path for a package row. Returns null if the
 * library dir is unknown (e.g. aux dir was removed from registry).
 */
export function pkgVarPath(pkg) {
  if (!pkg) return null
  const dir = getLibraryDirPath(pkg.library_dir_id)
  if (!dir) return null
  return join(dir, pkg.filename + (pkg.storage_state === 'disabled' ? '.disabled' : ''))
}

/** True when `child` is the same as or nested inside `parent`. */
function isPathInside(child, parent) {
  if (!child || !parent) return false
  const a = child.replace(/[\\/]+$/, '')
  const b = parent.replace(/[\\/]+$/, '')
  if (a === b) return true
  return a.startsWith(b + '/') || a.startsWith(b + '\\')
}

/** Validation helper for `library-dirs:add`. Returns null on success, error string otherwise. */
export function validateNewAuxDirPath(path) {
  if (!path || typeof path !== 'string') return 'Invalid path'
  const main = getMainLibraryDirPath()
  if (main && (isPathInside(path, main) || isPathInside(main, path))) {
    return 'Offload directory cannot overlap the main AddonPackages directory'
  }
  // Other VaM-managed roots: prefs sidecar tree (where prefsWatcher fires) and
  // the loose-content roots (where localWatcher / runLocalScan reign). Pointing
  // an aux library dir at any of these (or any nested subtree) would have the
  // package watcher and the loose-content watcher fight over the same files.
  const vamDir = getSetting('vam_dir')
  if (vamDir) {
    const forbiddenRoots = [join(vamDir, ADDON_PACKAGES_FILE_PREFS), ...LOCAL_CONTENT_ROOTS.map((r) => join(vamDir, r))]
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
