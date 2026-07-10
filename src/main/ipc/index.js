import { ipcMain, app } from 'electron'
import { getAvatarBuffers } from '../avatar-cache.js'
import { getThumbnails } from '../thumbnails.js'
import { getSetting, setSetting, getDatabasePath } from '../db.js'
import { registerPackageHandlers } from './packages.js'
import { registerContentHandlers } from './contents.js'
import { registerScanHandlers } from './scanner.js'
import { registerHubHandlers } from './hub.js'
import { registerWishlistHandlers } from './wishlist.js'
import { registerDownloadHandlers } from './downloads.js'
import { registerDevHandlers } from './dev.js'
import { registerShellHandlers } from './shell.js'
import { registerExtractHandlers } from './extract.js'
import { registerLabelHandlers } from './labels.js'
import { registerLibraryDirHandlers } from './library-dirs.js'
import { registerRemoteHandlers } from './remote.js'

// Small, unrelated IPC surfaces that are pure delegations to their backing
// modules live here rather than each getting its own file.
function registerMiscHandlers() {
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('avatars:get', async (_, userIds) => getAvatarBuffers(userIds || []))

  ipcMain.handle('thumbnails:get', async (_, keys) => getThumbnails(keys || []))

  ipcMain.handle('settings:getDatabasePath', () => getDatabasePath())
  ipcMain.handle('settings:get', (_, key) => getSetting(key))
  ipcMain.handle('settings:set', (_, key, value) => {
    setSetting(key, value)
    return { ok: true }
  })
}

export function registerAllHandlers() {
  registerMiscHandlers()
  registerShellHandlers()
  registerPackageHandlers()
  registerContentHandlers()
  registerScanHandlers()
  registerHubHandlers()
  registerWishlistHandlers()
  registerDownloadHandlers()
  registerDevHandlers()
  registerExtractHandlers()
  registerLabelHandlers()
  registerLibraryDirHandlers()
  registerRemoteHandlers()
}
