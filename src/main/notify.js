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

/**
 * Push a user-facing toast to the renderer (and any remote clients) over the
 * generic `toast` channel, so a main-process site can surface a message without
 * inventing a bespoke IPC event for it. `type` matches the renderer toast API
 * ('error' | 'success' | 'info'); `message` is shown verbatim.
 */
export function notifyToast(message, type = 'error') {
  notify('toast', { message, type })
}

/**
 * Like `notify()`, but skips the caller that already applied the mutation.
 * Local IPC: `sourceEvent.sender` is the invoking webContents.
 * Remote RPC: `sourceEvent.remoteWs` is the invoking WebSocket (see server.js).
 * Use this when the actor already has optimistic / post-RPC state and should
 * not pay for an event-driven refetch.
 */
export function notifyPeers(sourceEvent, channel, data) {
  const win = getWindow()
  if (win) {
    const sourceWc = sourceEvent?.sender
    if (!sourceWc || sourceWc !== win.webContents) {
      try {
        win.webContents.send(channel, data)
      } catch {}
    }
  }
  broadcast(channel, data, { except: sourceEvent?.remoteWs ?? null })
}
