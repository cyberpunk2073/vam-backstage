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
 * `library-dirs:set-browser-assist` toggles JayJayWon BrowserAssist sidecar mode on
 * an offload dir. It only affects *future* offloads/restores into that dir — the
 * flag is never retroactively applied, so toggling it never writes or deletes any
 * `.var.json` on disk (a no-op the user expects). Users can regenerate sidecars for
 * existing packages by enabling the mode and re-cycling enable/offload on them.
 */

import { ipcMain, dialog } from 'electron'
import { rename, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  insertLibraryDir,
  deleteLibraryDir,
  removeLibraryDirTombstoningPackages,
  getLibraryDirByPath,
  getLibraryDir,
  countPackagesInLibraryDir,
  setLibraryDirBrowserAssist,
  getSetting,
  setSetting,
} from '../db.js'
import { getMainLibraryDirPath, getAuxLibraryDirs, validateNewAuxDirPath, refreshLibraryDirs } from '../library-dirs.js'
import { detectOffloadSuggestions, matchOffloadToolId } from '../offload-suggestions.js'
import { restartPackageWatcher } from '../watcher.js'
import { runScan } from '../scanner/index.js'
import { buildFromDb } from '../store.js'
import { notify, getWindow } from '../notify.js'
import { DISABLE_BEHAVIOR_SUFFIX, disableBehaviorMoveTo } from '@shared/disable-behavior.js'

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

/**
 * Validate → stat → dedupe → same-FS probe → insert a new offload dir row.
 * Returns `{ id, path, browserAssist }`. Does NOT scan or restart the watcher —
 * callers decide (Settings rescans immediately; the first-run wizard defers to its
 * single scan). BrowserAssist's default offload folder is auto-detected and gets
 * sidecar mode enabled so future offloads into it write sidecars and existing BA
 * sidecars are honored on restore.
 */
async function registerAuxDir(path) {
  refreshLibraryDirs()
  const error = await validateNewAuxDirPath(path)
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
  const browserAssist = matchOffloadToolId(path, getSetting('vam_dir')) === 'browser-assist'
  if (browserAssist) setLibraryDirBrowserAssist(id, true)
  refreshLibraryDirs()
  return { id, path, browserAssist }
}

export function registerLibraryDirHandlers() {
  ipcMain.handle('library-dirs:list', () => {
    refreshLibraryDirs()
    const main = getMainLibraryDirPath()
    const aux = getAuxLibraryDirs().map((d) => {
      const { n: packageCount, bytes } = countPackagesInLibraryDir(d.id)
      return {
        id: d.id,
        path: d.path,
        created_at: d.created_at,
        packageCount,
        sizeBytes: Number(bytes) || 0,
        browserAssist: !!d.browser_assist,
      }
    })
    return { main, aux }
  })

  // Toggle JayJayWon BrowserAssist sidecar mode on an offload dir. This only flips
  // the flag: it governs whether *future* offloads into this dir write a sidecar and
  // whether restores from it read one. Existing on-disk files are intentionally left
  // untouched — enabling doesn't back-fill sidecars (avoids littering the dir with
  // now-stale JSON) and disabling doesn't delete any (avoids destroying the only
  // record of a restore folder for packages BrowserAssist itself flattened to root).
  // The `.var` bytes never move, so no rescan is needed.
  ipcMain.handle('library-dirs:set-browser-assist', async (_, id, enabled) => {
    const row = getLibraryDir(id)
    if (!row) throw new Error('Library directory not found')
    const on = !!enabled
    setLibraryDirBrowserAssist(id, on)
    refreshLibraryDirs()
    return { ok: true, browserAssist: on }
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
    const result = await registerAuxDir(path)

    const vamDir = getSetting('vam_dir')
    if (vamDir) {
      await runScan(vamDir, (progress) => notify('scan:progress', progress))
      await restartPackageWatcher()
      notify('packages:updated')
      notify('contents:updated')
    }

    return result
  })

  // Register an offload dir WITHOUT scanning — the first-run wizard registers
  // detected dirs before its single library scan, which then indexes them and
  // the watcher subscribes to them (both enumerate the library_dirs registry).
  ipcMain.handle('library-dirs:register', async (_, path) => {
    return await registerAuxDir(path)
  })

  // Detected default offload folders from known third-party tools (BrowserAssist,
  // var_browser) that exist on disk and aren't registered yet.
  ipcMain.handle('library-dirs:suggest', async () => {
    refreshLibraryDirs()
    return await detectOffloadSuggestions(getSetting('vam_dir'))
  })

  // `opts.force` un-registers a non-empty offload dir: its package rows are
  // tombstoned (and detached from the dir so the FK RESTRICT lifts) rather than
  // deleted. The on-disk `.var` files are left untouched, so re-adding + rescanning
  // resurrects each row with its user-set metadata (labels, category overrides,
  // content visibility) intact — the removal is recoverable.
  ipcMain.handle('library-dirs:remove', async (_, id, opts) => {
    const row = getLibraryDir(id)
    if (!row) throw new Error('Library directory not found')
    const { n: count } = countPackagesInLibraryDir(id)
    // If this was a known tool's default offload folder, tell the renderer so it
    // can dismiss the re-suggestion — the folder still exists on disk after removal.
    const matchedToolId = matchOffloadToolId(row.path, getSetting('vam_dir'))

    let forgotten = 0
    if (count > 0) {
      if (!opts?.force) {
        throw new Error(`Cannot remove: ${count} package(s) are still stored in this directory. Move them first.`)
      }
      forgotten = removeLibraryDirTombstoningPackages(id)
    } else {
      deleteLibraryDir(id)
    }

    if (getSetting('disable_behavior') === disableBehaviorMoveTo(id)) {
      setSetting('disable_behavior', DISABLE_BEHAVIOR_SUFFIX)
    }

    refreshLibraryDirs()
    await restartPackageWatcher()
    buildFromDb()
    notify('packages:updated')
    notify('contents:updated')

    return { ok: true, forgotten, matchedToolId }
  })
}
