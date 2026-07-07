import { ipcMain } from 'electron'
import {
  probeScene,
  probePackage,
  resolveExtractedSource,
  runExtract,
  runExtractBatch,
  runExtractForPackageFilenames,
} from '../scenes/extract.js'
import { runLocalScan } from '../scanner/local.js'
import { buildFromDb } from '../store.js'
import { getSetting } from '../db.js'
import { notify } from '../notify.js'

/**
 * After a user-initiated extract writes at least one preset, eagerly reconcile
 * the local content rows + rebuild in-memory state + fire `packages:updated` so
 * the library view's "no preset" checkmark flips immediately. The watcher
 * pipeline would eventually catch up via `contents:updated`, but it's debounced
 * 500ms and library cards listen to `packages:updated` only.
 */
async function refreshAfterExtract() {
  const vamDir = getSetting('vam_dir')
  if (!vamDir) return
  try {
    await runLocalScan(vamDir)
    buildFromDb()
    notify('packages:updated')
  } catch (err) {
    console.warn('Post-extract refresh failed:', err.message)
  }
}

export function registerExtractHandlers() {
  ipcMain.handle('extract:probe-scene', async (_, { packageFilename, internalPath }) => {
    return await probeScene({ packageFilename, internalPath })
  })

  ipcMain.handle('extract:probe-package', async (_, filename) => {
    return await probePackage(filename)
  })

  ipcMain.handle('extract:resolve-source', (_, { packageFilename, presetInternalPath }) => {
    return resolveExtractedSource({ packageFilename, presetInternalPath })
  })

  ipcMain.handle('extract:run', async (_, payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('invalid payload')
    const { kind } = payload
    if (kind !== 'appearance' && kind !== 'outfit') throw new Error('kind must be appearance|outfit')
    const mode = payload.mode === 'overwrite' || payload.mode === 'refresh' ? payload.mode : 'create'
    const result = Array.isArray(payload.items)
      ? await runExtractBatch({ items: payload.items, kind, mode })
      : await runExtract({
          packageFilename: payload.packageFilename,
          internalPath: payload.internalPath,
          atomIds: payload.atomIds,
          kind,
          mode,
        })
    if (result.written.length > 0) await refreshAfterExtract()
    return result
  })

  ipcMain.handle('extract:run-for-packages', async (_, { filenames, kind, sourceTypes }) => {
    if (!Array.isArray(filenames) || !filenames.length) throw new Error('filenames required')
    if (kind !== 'appearance' && kind !== 'outfit') throw new Error('kind must be appearance|outfit')
    if (!Array.isArray(sourceTypes) || !sourceTypes.length) throw new Error('sourceTypes required')
    const result = await runExtractForPackageFilenames({ filenames, kind, sourceTypes })
    if (result.written.length > 0) await refreshAfterExtract()
    return result
  })
}
