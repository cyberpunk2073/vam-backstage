import { ipcMain } from 'electron'
import { getAvatarBuffers } from '../avatar-cache.js'

export function registerAvatarHandlers() {
  ipcMain.handle('avatars:get', async (_, userIds) => {
    return getAvatarBuffers(userIds || [])
  })
}
