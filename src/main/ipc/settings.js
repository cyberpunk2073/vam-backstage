import { ipcMain } from 'electron'
import { getSetting, setSetting, getDatabasePath } from '../db.js'

export function registerSettingsHandlers() {
  ipcMain.handle('settings:getDatabasePath', () => getDatabasePath())

  ipcMain.handle('settings:get', (_, key) => {
    return getSetting(key)
  })

  ipcMain.handle('settings:set', (_, key, value) => {
    setSetting(key, value)
    return { ok: true }
  })
}
