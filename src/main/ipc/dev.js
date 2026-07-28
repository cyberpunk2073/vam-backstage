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
import { stopWatcher, withBulkWindow } from '../watcher.js'
import { deleteOrphanedExtractedPresetsAndResync } from '../scenes/extracted-reconcile.js'
import { notify } from '../notify.js'
import { installPrefs } from '../prefs.js'

export function registerDevHandlers() {
  ipcMain.handle('dev:is-dev', () => is.dev)

  // The unlock is machine-scoped (see prefs.js): it reveals dev UI on *this*
  // machine and relaxes *this* host's version gate, so a client head unlocking
  // itself must not flip the host's flag — which is what routing it through
  // `settings:*` used to do.
  ipcMain.handle('dev:get-unlocked', () => installPrefs.get('devUnlocked'))

  ipcMain.handle('dev:set-unlocked', (_e, unlocked) => {
    installPrefs.set('devUnlocked', unlocked === true)
    return { ok: true, unlocked: installPrefs.get('devUnlocked') }
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
  // The DB rows are already invisible to the gallery, so forgetting them needs no
  // rebuild. But this is also the permanent-removal moment for extracted presets
  // that external tooling left orphaned — the disable-on-tombstone reconcile only
  // hid them (removal is reversible until forgotten), so here we finally delete the
  // ones no present package still claims, then rescan + notify if any went.
  ipcMain.handle('dev:forget-deleted-data', async () => {
    if (!is.dev && !installPrefs.get('devUnlocked')) return { ok: false, error: 'forbidden' }
    try {
      const result = forgetDeletedData()
      const vamDir = getSetting('vam_dir')
      let orphanedPresets = 0
      if (vamDir) {
        // Bulk window so the unlinks are app-owned and the watcher stays quiet.
        const { removed } = await withBulkWindow(() => deleteOrphanedExtractedPresetsAndResync({ vamDir }))
        orphanedPresets = removed
        if (orphanedPresets > 0) notify('contents:updated')
      }
      return { ok: true, ...result, orphanedPresets }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('dev:nuke-database', async () => {
    if (!is.dev && !installPrefs.get('devUnlocked')) return { ok: false, error: 'forbidden' }
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
