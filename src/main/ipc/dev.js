import { ipcMain, app } from 'electron'
import { is } from '@electron-toolkit/utils'
import {
  closeDatabase,
  deleteDatabaseFiles,
  getSetting,
  countMissingPackages,
  countOrphanContentLabels,
  forgetDeletedData,
} from '../db.js'
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

  ipcMain.handle('dev:count-deleted-data', () => {
    try {
      return { ok: true, packages: countMissingPackages(), contentLabels: countOrphanContentLabels() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // Reclaim retained identity-keyed memory: tombstoned packages (soft-deleted rows
  // whose .var left disk) plus orphaned content labels from in-place replacements.
  // Both are already invisible to the gallery, so no store rebuild / notify is
  // needed — this only reclaims the DB space they occupied.
  ipcMain.handle('dev:forget-deleted-data', () => {
    const unlocked = getSetting('developer_options_unlocked') === '1'
    if (!is.dev && !unlocked) return { ok: false, error: 'forbidden' }
    try {
      return { ok: true, ...forgetDeletedData() }
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
