import { ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import { getSetting } from '../db.js'
import { probeScene, probePackage, runExtract, runExtractBatch } from '../scenes/extract.js'

function ensureAllowed() {
  const unlocked = getSetting('developer_options_unlocked') === '1'
  if (!is.dev && !unlocked) throw new Error('forbidden')
}

export function registerExtractHandlers() {
  ipcMain.handle('extract:probe-scene', async (_, { packageFilename, internalPath }) => {
    ensureAllowed()
    return await probeScene({ packageFilename, internalPath })
  })

  ipcMain.handle('extract:probe-package', async (_, filename) => {
    ensureAllowed()
    return await probePackage(filename)
  })

  ipcMain.handle('extract:run', async (_, payload) => {
    ensureAllowed()
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
