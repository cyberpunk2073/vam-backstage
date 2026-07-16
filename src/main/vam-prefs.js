import { readdir, writeFile, unlink, mkdir, rename } from 'fs/promises'
import { join, dirname, extname } from 'path'
import { existsSync } from 'fs'
import { ADDON_PACKAGES_FILE_PREFS } from '@shared/paths.js'
import { LOCAL_PACKAGE_FILENAME, LOCAL_CONTENT_DIRS, isLocalPackage } from '@shared/local-package.js'
import { recordOwnedPath, withBulkWindow } from './watcher.js'
import { pLimit } from './p-limit.js'

/**
 * Drop a trailing `.disabled` marker, yielding the canonical (live) path. Loose
 * sidecars and content labels bind to this path, so a preset's favorite/hidden
 * flags survive the `.disabled` marker toggling on enable/disable. Exported for
 * the watcher and label IPC, which key the same loose-content prefs.
 */
export function stripDisabledSuffix(p) {
  return p.endsWith('.disabled') ? p.slice(0, -'.disabled'.length) : p
}

// Bounded concurrency for the per-package-stem sidecar walk. Each stem owns a
// disjoint key range in the prefs Map (`pkgFilename/...`) so writes don't
// race. Default libuv pool is 4 workers; 8 is 2× headroom for transient bursts
// of `readdir` calls without flooding the file-handle table.
const PREFS_STEM_CONCURRENCY = 8

/**
 * VaM stores content visibility preferences as sidecar files:
 *   {vamDir}/AddonPackagesFilePrefs/{packageStem}/{internalPath}.hide
 *   {vamDir}/AddonPackagesFilePrefs/{packageStem}/{internalPath}.fav
 *
 * For loose content (the `__local__` sentinel) VaM uses **sibling** sidecars
 * placed next to the source file, e.g. `{vamDir}/Saves/scene/Foo/Foo.json.hide`,
 * matching the on-disk convention that the game itself reads.
 *
 * These are empty files — existence alone is the flag.
 */

function prefsDir(vamDir) {
  return join(vamDir, ADDON_PACKAGES_FILE_PREFS)
}

function sidecarPath(vamDir, packageFilename, internalPath, ext) {
  if (isLocalPackage(packageFilename)) {
    // Loose sidecars sit next to the *live* file (`X.vap.fav`), never the
    // `.disabled` marker form — favorites/hidden bind to the canonical path so a
    // single sidecar serves both enabled and disabled states (and matches what
    // VaM itself reads when the preset is live).
    return join(vamDir, stripDisabledSuffix(internalPath) + ext)
  }
  const stem = packageFilename.replace(/\.var$/i, '')
  return join(prefsDir(vamDir), stem, internalPath + ext)
}

/**
 * Build prefs map by walking the AddonPackagesFilePrefs directory.
 * Returns Map<"filename.var/internalPath", { hidden: bool, favorite: bool }>
 */
export async function readAllPrefs(vamDir) {
  const prefs = new Map()
  const root = prefsDir(vamDir)
  if (!existsSync(root)) return prefs

  let packageDirs
  try {
    packageDirs = await readdir(root, { withFileTypes: true })
  } catch {
    return prefs
  }

  const limit = pLimit(PREFS_STEM_CONCURRENCY)
  await Promise.all(
    packageDirs
      .filter((d) => d.isDirectory())
      .map((dir) =>
        limit(() => {
          const pkgStem = dir.name
          const pkgFilename = pkgStem + '.var'
          return walkSidecarDir(join(root, pkgStem), '', pkgFilename, prefs, { requireSiblingTarget: false })
        }),
      ),
  )

  for (const localDir of LOCAL_CONTENT_DIRS) {
    await walkSidecarDir(join(vamDir, localDir), localDir, LOCAL_PACKAGE_FILENAME, prefs, {
      requireSiblingTarget: true,
    })
  }

  return prefs
}

/**
 * Walk a directory tree looking for `.hide`/`.fav` sidecars and merge them into
 * `prefs` keyed as `<keyPrefix>/<internalPath>`. Set `requireSiblingTarget` for
 * loose-content roots: VaM places sidecars next to the content file, so an
 * orphan sidecar (no sibling content) should be ignored. The packaged-content
 * `AddonPackagesFilePrefs/<stem>/...` layout has no such sibling, so the flag
 * is off there.
 */
async function walkSidecarDir(dirPath, relativePath, keyPrefix, prefs, { requireSiblingTarget }) {
  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return
  }

  // A sidecar is always canonical (`X.vap.fav`), but the content file it guards is
  // renamed to `X.vap.disabled` while the preset is disabled. Strip the marker off
  // the content filenames so a favorited-but-disabled preset's sidecar still finds
  // its sibling instead of looking orphaned.
  const siblingFiles = requireSiblingTarget
    ? new Set(entries.filter((e) => e.isFile()).map((e) => stripDisabledSuffix(e.name)))
    : null

  for (const entry of entries) {
    const relPath = relativePath ? relativePath + '/' + entry.name : entry.name
    if (entry.isDirectory()) {
      await walkSidecarDir(join(dirPath, entry.name), relPath, keyPrefix, prefs, { requireSiblingTarget })
      continue
    }
    // Belt-and-braces: skip symlinks (matches walkForVars / runLocalScan).
    if (entry.isSymbolicLink()) continue
    if (!entry.isFile()) continue

    const isHide = entry.name.endsWith('.hide')
    const isFav = entry.name.endsWith('.fav')
    if (!isHide && !isFav) continue

    const ext = isHide ? '.hide' : '.fav'
    const targetName = entry.name.slice(0, -ext.length)
    if (siblingFiles && !siblingFiles.has(stripDisabledSuffix(targetName))) continue // orphaned sidecar

    const contentPath = stripDisabledSuffix(relPath.slice(0, -ext.length))
    const key = keyPrefix + '/' + contentPath
    if (!prefs.has(key)) prefs.set(key, { hidden: false, favorite: false })
    const p = prefs.get(key)
    if (isHide) p.hidden = true
    if (isFav) p.favorite = true
  }
}

/**
 * Create (or delete) a sidecar marker — an empty file whose existence encodes the
 * flag. Sidecars bind to the canonical (live) path (see `sidecarPath`), so one
 * file serves a preset in both its enabled and disabled states. Legacy `.disabled`
 * sidecar forms are normalized away once at startup by `migrateLooseSidecarLayout`, so
 * there's nothing extra to clean up here.
 */
async function setSidecar(vamDir, packageFilename, internalPath, ext, on) {
  const p = sidecarPath(vamDir, packageFilename, internalPath, ext)
  recordOwnedPath(p)
  if (on) {
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, '')
  } else {
    try {
      await unlink(p)
    } catch {}
  }
}

/**
 * Set hidden state for a content item by creating/deleting the .hide sidecar.
 */
export async function setHidden(vamDir, packageFilename, internalPath, hidden) {
  return setSidecar(vamDir, packageFilename, internalPath, '.hide', hidden)
}

/**
 * Set favorite state for a content item by creating/deleting the .fav sidecar.
 */
export async function setFavorite(vamDir, packageFilename, internalPath, favorite) {
  return setSidecar(vamDir, packageFilename, internalPath, '.fav', favorite)
}

const BATCH_CONCURRENCY = 20

/**
 * Bulk-create .hide sidecars for all managed content items in a package.
 * Used when demoting a package to dependency. Wraps the bulk in a watcher
 * window so the resulting flood of sidecar create events is suppressed
 * (caller rebuilds prefs from disk after).
 */
export async function hidePackageContent(vamDir, packageFilename, contentPaths) {
  return withBulkWindow(async () => {
    for (let i = 0; i < contentPaths.length; i += BATCH_CONCURRENCY) {
      await Promise.all(
        contentPaths.slice(i, i + BATCH_CONCURRENCY).map((p) => setHidden(vamDir, packageFilename, p, true)),
      )
    }
  })
}

/**
 * Bulk-delete .hide sidecars for all managed content items in a package.
 * Used when promoting a dependency to direct. Wraps the bulk in a watcher
 * window — same reasoning as `hidePackageContent`.
 */
export async function unhidePackageContent(vamDir, packageFilename, contentPaths) {
  return withBulkWindow(async () => {
    for (let i = 0; i < contentPaths.length; i += BATCH_CONCURRENCY) {
      await Promise.all(
        contentPaths.slice(i, i + BATCH_CONCURRENCY).map((p) => setHidden(vamDir, packageFilename, p, false)),
      )
    }
  })
}

/**
 * Copy `.hide`/`.fav` sidecars from one package's stem dir to another's, restricted
 * to the `internalPaths` that exist in the new package. Used by the inheritance flow
 * when a new version of a package is installed: the per-stem sidecar tree is keyed
 * on packageStem (which includes version), so the new install needs its own sidecars
 * placed even if the bytes-level content paths happen to match the old stem.
 *
 * Loose-content sidecars (`__local__`) live next to the source file and aren't keyed
 * by stem, so they aren't part of this copy. Wrapped in a bulk window so the watcher
 * drops the resulting `.hide`/`.fav` create events.
 */
export async function copySidecarsToNewVersion(vamDir, fromFilename, toFilename, internalPaths) {
  if (!internalPaths.length) return
  if (isLocalPackage(fromFilename) || isLocalPackage(toFilename)) return
  const fromStem = fromFilename.replace(/\.var$/i, '')
  const fromDir = join(prefsDir(vamDir), fromStem)
  if (!existsSync(fromDir)) return
  return withBulkWindow(async () => {
    for (const ip of internalPaths) {
      for (const ext of ['.hide', '.fav']) {
        const fromPath = join(fromDir, ip + ext)
        if (!existsSync(fromPath)) continue
        const toPath = sidecarPath(vamDir, toFilename, ip, ext)
        recordOwnedPath(toPath)
        try {
          await mkdir(dirname(toPath), { recursive: true })
          await writeFile(toPath, '')
        } catch {}
      }
    }
  })
}

const OLD_EXTS = new Set(['.vab', '.vaj'])

/**
 * Migrate .hide/.fav sidecars from old .vab/.vaj paths to .vam.
 * Called once after the V12 DB migration re-classifies content with .vam preference.
 */
export async function migratePrefsExtensions(vamDir) {
  const prefs = await readAllPrefs(vamDir)
  let migrated = 0

  for (const [key, { hidden, favorite }] of prefs) {
    // key = "pkg.var/Custom/Clothing/Author/Dress.vab"
    const slashIdx = key.indexOf('/')
    if (slashIdx === -1) continue
    const packageFilename = key.slice(0, slashIdx)
    const internalPath = key.slice(slashIdx + 1)
    const contentExt = extname(internalPath).toLowerCase()
    if (!OLD_EXTS.has(contentExt)) continue

    const newInternalPath = internalPath.slice(0, -contentExt.length) + '.vam'
    const newKey = packageFilename + '/' + newInternalPath
    // Only migrate if the new key doesn't already have a sidecar
    if (prefs.has(newKey)) continue

    for (const sidecarExt of ['.hide', '.fav']) {
      const shouldExist = sidecarExt === '.hide' ? hidden : favorite
      if (!shouldExist) continue

      const oldPath = sidecarPath(vamDir, packageFilename, internalPath, sidecarExt)
      const newPath = sidecarPath(vamDir, packageFilename, newInternalPath, sidecarExt)
      try {
        await mkdir(dirname(newPath), { recursive: true })
        await rename(oldPath, newPath)
        migrated++
      } catch {}
    }
  }

  if (migrated > 0) console.log(`Migrated ${migrated} sidecar file(s) from .vab/.vaj to .vam`)
}
