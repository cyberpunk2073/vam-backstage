import { ipcMain, shell } from 'electron'
import { join } from 'path'
import { normalizeExternalUrl } from '@shared/external-url.js'

export function registerShellHandlers() {
  ipcMain.handle('shell:openExternal', async (_, url) => {
    const target = normalizeExternalUrl(url)
    if (!target) return { ok: false, error: 'invalid_url' }
    try {
      await shell.openExternal(target)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('shell:showItemInFolder', (_, pathOrSegments) => {
    const parts = (Array.isArray(pathOrSegments) ? pathOrSegments : [pathOrSegments]).filter(
      (s) => typeof s === 'string' && s.length > 0,
    )
    if (!parts.length) return
    shell.showItemInFolder(join(...parts))
  })
}
