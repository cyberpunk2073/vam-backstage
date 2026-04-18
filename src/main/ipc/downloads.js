import { ipcMain } from 'electron'
import {
  getDownloadList,
  cancelItem,
  retryItem,
  clearCompleted,
  clearFailed,
  removeFailedItem,
  isPaused,
  pauseAll,
  resumeAll,
  cancelAll,
  onNetworkOnline,
} from '../downloads/manager.js'

export function registerDownloadHandlers() {
  ipcMain.handle('downloads:list', () => {
    return getDownloadList()
  })

  ipcMain.handle('downloads:cancel', async (_, id) => {
    await cancelItem(id)
    return { ok: true }
  })

  ipcMain.handle('downloads:retry', (_, id) => {
    retryItem(id)
    return { ok: true }
  })

  ipcMain.handle('downloads:clear-completed', () => {
    clearCompleted()
    return { ok: true }
  })

  ipcMain.handle('downloads:clear-failed', () => {
    clearFailed()
    return { ok: true }
  })

  ipcMain.handle('downloads:remove-failed', (_, id) => {
    removeFailedItem(id)
    return { ok: true }
  })

  ipcMain.handle('downloads:is-paused', () => {
    return isPaused()
  })

  ipcMain.handle('downloads:pause-all', () => {
    pauseAll()
    return { ok: true }
  })

  ipcMain.handle('downloads:resume-all', () => {
    resumeAll()
    return { ok: true }
  })

  ipcMain.handle('downloads:cancel-all', async () => {
    await cancelAll()
    return { ok: true }
  })

  ipcMain.handle('downloads:network-online', () => {
    onNetworkOnline()
  })
}
