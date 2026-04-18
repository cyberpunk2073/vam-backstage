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
}
