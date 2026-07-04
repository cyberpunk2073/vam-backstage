import { ipcMain } from 'electron'

/**
 * Captures every `ipcMain.handle(channel, fn)` registration into a lookup map
 * so the remote server can dispatch the same handlers over the network without
 * touching any of the ~14 handler files.
 *
 * `installRegistry()` must run BEFORE `registerAllHandlers()`. It's installed
 * unconditionally (even in pure-local mode) so that hot-starting the server
 * later from the Settings tab still finds every handler — the patch just
 * records into a Map and delegates to Electron's real `handle`, so local
 * behaviour is unchanged.
 */

const handlers = new Map()
let installed = false

export function installRegistry() {
  if (installed) return
  installed = true
  const original = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => {
    handlers.set(channel, listener)
    return original(channel, listener)
  }
}

export function getHandler(channel) {
  return handlers.get(channel)
}
