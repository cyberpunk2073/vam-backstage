import { ipcMain, app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { closeDatabase, deleteDatabaseFiles, getSetting } from '../db.js'
import { stopWatcher } from '../watcher.js'
import { syncBrowserAssistTags, browserAssistSettingsDirExists } from '../browser-assist.js'

export function registerDevHandlers() {
  ipcMain.handle('dev:is-dev', () => is.dev)

  ipcMain.handle('dev:browser-assist-dir-exists', () => {
    const vamDir = getSetting('vam_dir')
    return { exists: browserAssistSettingsDirExists(vamDir) }
  })

  ipcMain.handle('dev:sync-browser-assist', async () => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) return { ok: false, error: 'VaM directory not configured' }
    try {
      const result = await syncBrowserAssistTags(vamDir)
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('dev:nuke-database', async () => {
    const unlocked = getSetting('developer_options_unlocked') === '1'
    if (!is.dev && !unlocked) return { ok: false, error: 'forbidden' }
    try {
      stopWatcher()
      closeDatabase()
      deleteDatabaseFiles()
      app.quit()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
}
