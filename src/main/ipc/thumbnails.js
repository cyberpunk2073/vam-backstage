import { ipcMain } from 'electron'
import { getThumbnails } from '../thumbnails.js'

export function registerThumbnailHandlers() {
  ipcMain.handle('thumbnails:get', async (_, keys) => {
    return getThumbnails(keys || [])
  })
}
