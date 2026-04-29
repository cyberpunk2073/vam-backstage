/**
 * IPC handlers for managing offload library directories.
 *
 * `library-dirs:list` returns main + offload entries for the Settings UI.
 * `library-dirs:add` registers a new offload dir, validates non-overlap with main
 * and other offload dirs, then triggers a rescan + watcher restart so packages
 * already inside it are immediately picked up.
 * `library-dirs:remove` deletes an offload dir row only when it is empty (the
 * `ON DELETE RESTRICT` FK on `packages.library_dir_id` enforces this at the DB
 * layer too); also resets the `disable_behavior` setting if it pointed at the
 * removed dir.
 * `library-dirs:browse` opens the OS folder picker.
 */

import { ipcMain, dialog } from 'electron'
import { rename, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  insertLibraryDir,
  deleteLibraryDir,
  getLibraryDirByPath,
  getLibraryDir,
  countPackagesInLibraryDir,
  getSetting,
  setSetting,
} from '../db.js'
import { getMainLibraryDirPath, getAuxLibraryDirs, validateNewAuxDirPath, refreshLibraryDirs } from '../library-dirs.js'
import { restartPackageWatcher } from '../watcher.js'
import { runScan } from '../scanner/index.js'
import { buildFromDb } from '../store.js'
import { notify, getWindow } from '../notify.js'
import { DISABLE_BEHAVIOR_SUFFIX, disableBehaviorMoveTo } from '../../shared/disable-behavior.js'

/**
 * Probe whether `auxPath` is on the same filesystem as `mainPath` by attempting
 * a `rename` of a tiny scratch file from main into aux. Returns null on success,
 * or an error message string on failure (cross-FS rejected, perms, etc.).
 *
 * Same-FS-only is a v1 invariant: `applyStorageState`, the watcher, and the
 * scanner all assume `fs.rename` between main and any aux dir is a microsecond
 * operation. Cross-FS aux dirs would require copy+verify+unlink fallback,
 * temp-file sweeping, and progress UI — deferred to v2.
 */
async function probeSameFs(mainPath, auxPath) {
  // Fixed name (rather than random) so a leaked scratch file from a previous failed
  // run gets reused/overwritten on the next probe instead of accumulating.
  const tag = '.backstage-fs-probe'
  const fromPath = join(mainPath, tag)
  const toPath = join(auxPath, tag)

  // Pre-clean both ends so a stale scratch from an earlier crash/AV-lock doesn't
  // wedge the rename (Windows rename refuses to overwrite an existing destination).
  await unlink(fromPath).catch(() => {})
  await unlink(toPath).catch(() => {})

  try {
    await writeFile(fromPath, '')
  } catch (err) {
    return `Could not write to main library directory to probe filesystem: ${err.message}`
  }
  try {
    await rename(fromPath, toPath)
  } catch (err) {
    await unlink(fromPath).catch(() => {})
    if (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'EACCES') {
      return `Offload directory must be on the same drive as the main library (${mainPath}). Cross-disk offload is not supported in this version.`
    }
    return `Filesystem probe failed: ${err.message}`
  }
  try {
    await unlink(toPath)
  } catch (err) {
    // Probe succeeded so we still register the dir, but the scratch file leaked.
    // It's a fixed name so the next probe will overwrite it; just warn so the
    // operator can clean up manually if desired.
    console.warn(`[library-dirs] Could not remove FS-probe scratch file at ${toPath}: ${err.message}`)
  }
  return null
}

export function registerLibraryDirHandlers() {
  ipcMain.handle('library-dirs:list', () => {
    refreshLibraryDirs()
    const main = getMainLibraryDirPath()
    const aux = getAuxLibraryDirs().map((d) => {
      const { n: packageCount, bytes } = countPackagesInLibraryDir(d.id)
      return { id: d.id, path: d.path, created_at: d.created_at, packageCount, sizeBytes: Number(bytes) || 0 }
    })
    return { main, aux }
  })

  ipcMain.handle('library-dirs:browse', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select offload VAR library directory',
    })
    if (result.canceled || !result.filePaths.length) return { cancelled: true }
    return { path: result.filePaths[0] }
  })

  ipcMain.handle('library-dirs:add', async (_, path) => {
    refreshLibraryDirs()
    const error = validateNewAuxDirPath(path)
    if (error) throw new Error(error)

    try {
      const s = await stat(path)
      if (!s.isDirectory()) throw new Error('Path is not a directory')
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`Directory does not exist: ${path}`)
      throw err
    }

    const existing = getLibraryDirByPath(path)
    if (existing) throw new Error('Directory already registered')

    const mainPath = getMainLibraryDirPath()
    if (!mainPath) throw new Error('Main library directory is not configured yet')
    const probeError = await probeSameFs(mainPath, path)
    if (probeError) throw new Error(probeError)

    const id = insertLibraryDir(path)
    refreshLibraryDirs()

    const vamDir = getSetting('vam_dir')
    if (vamDir) {
      await runScan(vamDir, (progress) => notify('scan:progress', progress))
      await restartPackageWatcher()
      notify('packages:updated')
      notify('contents:updated')
    }

    return { id, path }
  })

  ipcMain.handle('library-dirs:remove', async (_, id) => {
    const row = getLibraryDir(id)
    if (!row) throw new Error('Library directory not found')
    const { n: count } = countPackagesInLibraryDir(id)
    if (count > 0) {
      throw new Error(`Cannot remove: ${count} package(s) are still stored in this directory. Move them first.`)
    }

    deleteLibraryDir(id)

    if (getSetting('disable_behavior') === disableBehaviorMoveTo(id)) {
      setSetting('disable_behavior', DISABLE_BEHAVIOR_SUFFIX)
    }

    refreshLibraryDirs()
    await restartPackageWatcher()
    buildFromDb()
    notify('packages:updated')

    return { ok: true }
  })
}
