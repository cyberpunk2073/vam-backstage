import { ipcMain } from 'electron'
import { probeScene, probePackage, runExtract, runExtractBatch } from '../scenes/extract.js'

export function registerExtractHandlers() {
  ipcMain.handle('extract:probe-scene', async (_, { packageFilename, internalPath }) => {
    return await probeScene({ packageFilename, internalPath })
  })

  ipcMain.handle('extract:probe-package', async (_, filename) => {
    return await probePackage(filename)
  })

  ipcMain.handle('extract:run', async (_, payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('invalid payload')
    const { kind } = payload
    if (kind !== 'appearance' && kind !== 'outfit') throw new Error('kind must be appearance|outfit')
    if (Array.isArray(payload.items)) {
      return await runExtractBatch({ items: payload.items, kind })
    }
    return await runExtract({
      packageFilename: payload.packageFilename,
      internalPath: payload.internalPath,
      atomIds: payload.atomIds,
      kind,
    })
  })
}
