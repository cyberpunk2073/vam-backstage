import { ipcMain, shell } from 'electron'
import { join } from 'path'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

function isAllowedExternalUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString.trim()) return false
  try {
    const u = new URL(urlString.trim())
    return ALLOWED_PROTOCOLS.has(u.protocol)
  } catch {
    return false
  }
}

export function registerShellHandlers() {
  ipcMain.handle('shell:openExternal', async (_, url) => {
    if (!isAllowedExternalUrl(url)) return { ok: false, error: 'invalid_url' }
    try {
      await shell.openExternal(url.trim())
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
