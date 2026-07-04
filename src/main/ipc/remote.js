import { ipcMain, app } from 'electron'
import { startServer, stopServer, getStatus } from '../remote/server.js'

/**
 * Local-mode control surface for the Settings tab. Server start/stop is a true
 * hot toggle; switching a running instance into (or out of) client mode is done
 * by relaunching with the appropriate argv, which sidesteps tearing down an
 * already-initialised backend / renderer.
 */

function relaunchWithArgs(extra) {
  // Drop our own switches from the current argv, then append the new ones.
  const base = process.argv
    .slice(1)
    .filter((a) => a !== '--serve' && !a.startsWith('--serve=') && !a.startsWith('--connect='))
  app.relaunch({ args: [...base, ...extra] })
  app.exit(0)
}

export function registerRemoteHandlers() {
  ipcMain.handle('remote:status', () => getStatus())

  ipcMain.handle('remote:start', async (_e, port) => {
    return await startServer(port || undefined)
  })

  ipcMain.handle('remote:stop', async () => {
    await stopServer()
    return { ok: true }
  })

  ipcMain.handle('remote:relaunch-connect', (_e, url) => {
    if (!url || typeof url !== 'string') return { ok: false, error: 'invalid url' }
    relaunchWithArgs([`--connect=${url}`])
    return { ok: true }
  })

  ipcMain.handle('remote:relaunch-disconnect', () => {
    relaunchWithArgs([])
    return { ok: true }
  })
}
