import { broadcast } from './remote/server.js'

let _getMainWindow = null

export function initNotify(getWin) {
  _getMainWindow = getWin
}

export function getWindow() {
  const win = _getMainWindow?.()
  return win && !win.isDestroyed() ? win : null
}

export function notify(channel, data) {
  getWindow()?.webContents.send(channel, data)
  // Fan the same event out to any connected remote clients. No-op unless the
  // server is running with at least one client.
  broadcast(channel, data)
}
