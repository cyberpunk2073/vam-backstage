import { readdir, writeFile, unlink, mkdir, rename } from 'fs/promises'
import { join, dirname, extname } from 'path'
import { existsSync } from 'fs'
import { ADDON_PACKAGES_FILE_PREFS } from '@shared/paths.js'
import { LOCAL_PACKAGE_FILENAME, LOCAL_CONTENT_ROOTS, isLocalPackage } from '@shared/local-package.js'
import { suppressPath } from './watcher.js'
import { pLimit } from './p-limit.js'

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
    return join(vamDir, internalPath + ext)
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

  for (const localRoot of LOCAL_CONTENT_ROOTS) {
    await walkSidecarDir(join(vamDir, localRoot), localRoot, LOCAL_PACKAGE_FILENAME, prefs, {
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

  const siblingFiles = requireSiblingTarget ? new Set(entries.filter((e) => e.isFile()).map((e) => e.name)) : null

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
    if (siblingFiles && !siblingFiles.has(targetName)) continue // orphaned sidecar

    const contentPath = relPath.slice(0, -ext.length)
    const key = keyPrefix + '/' + contentPath
    if (!prefs.has(key)) prefs.set(key, { hidden: false, favorite: false })
    const p = prefs.get(key)
    if (isHide) p.hidden = true
    if (isFav) p.favorite = true
  }
}

/**
 * Set hidden state for a content item by creating/deleting the .hide sidecar.
 */
export async function setHidden(vamDir, packageFilename, internalPath, hidden) {
  const p = sidecarPath(vamDir, packageFilename, internalPath, '.hide')
  suppressPath(p)
  if (hidden) {
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, '')
  } else {
    try {
      await unlink(p)
    } catch {}
  }
}

/**
 * Set favorite state for a content item by creating/deleting the .fav sidecar.
 */
export async function setFavorite(vamDir, packageFilename, internalPath, favorite) {
  const p = sidecarPath(vamDir, packageFilename, internalPath, '.fav')
  suppressPath(p)
  if (favorite) {
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, '')
  } else {
    try {
      await unlink(p)
    } catch {}
  }
}

const BATCH_CONCURRENCY = 20

/**
 * Bulk-create .hide sidecars for all managed content items in a package.
 * Used when demoting a package to dependency.
 */
export async function hidePackageContent(vamDir, packageFilename, contentPaths) {
  for (let i = 0; i < contentPaths.length; i += BATCH_CONCURRENCY) {
    await Promise.all(
      contentPaths.slice(i, i + BATCH_CONCURRENCY).map((p) => setHidden(vamDir, packageFilename, p, true)),
    )
  }
}

/**
 * Bulk-delete .hide sidecars for all managed content items in a package.
 * Used when promoting a dependency to direct.
 */
export async function unhidePackageContent(vamDir, packageFilename, contentPaths) {
  for (let i = 0; i < contentPaths.length; i += BATCH_CONCURRENCY) {
    await Promise.all(
      contentPaths.slice(i, i + BATCH_CONCURRENCY).map((p) => setHidden(vamDir, packageFilename, p, false)),
    )
  }
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
