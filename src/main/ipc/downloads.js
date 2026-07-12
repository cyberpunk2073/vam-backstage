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
import { notifyPeers } from '../notify.js'

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

  ipcMain.handle('downloads:pause-all', (event) => {
    pauseAll()
    notifyPeers(event, 'downloads:pause-changed', true)
    return { ok: true }
  })

  ipcMain.handle('downloads:resume-all', (event) => {
    resumeAll()
    notifyPeers(event, 'downloads:pause-changed', false)
    return { ok: true }
  })

  ipcMain.handle('downloads:cancel-all', async (event) => {
    await cancelAll()
    notifyPeers(event, 'downloads:pause-changed', false)
    return { ok: true }
  })

  ipcMain.handle('downloads:network-online', () => {
    onNetworkOnline()
  })
}
