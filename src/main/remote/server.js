import { WebSocketServer } from 'ws'
import { app } from 'electron'
import { encode, decode } from '@shared/net-codec.js'
import { DEFAULT_REMOTE_PORT } from '@shared/remote-config.js'
import { getHandler } from './registry.js'
import { getWindow } from '../notify.js'

/**
 * LAN WebSocket bridge that re-exposes the captured ipcMain handlers (see
 * registry.js) as RPC, and rebroadcasts `notify()` events to every connected
 * client. Single-user / trusted-LAN: no auth, binds 0.0.0.0.
 */

// Handlers destructure their first arg (`_`, the IpcMainInvokeEvent) and never
// use it, so a null-sender stub is enough for remote dispatch.
const stubEvent = { sender: null }

let wss = null
let currentPort = null
const clients = new Set()

export function getStatus() {
  return { running: !!wss, port: currentPort, clients: clients.size }
}

// Push the current status to the local renderer so the Settings tab reflects
// client connects/disconnects live (only the local window runs the server UI —
// no need to broadcast this to remote clients).
function emitStatus() {
  try {
    getWindow()?.webContents.send('remote:server-status', getStatus())
  } catch {}
}

export function startServer(port = DEFAULT_REMOTE_PORT) {
  return new Promise((resolve) => {
    if (wss) {
      resolve({ ok: true, port: currentPort })
      return
    }
    const server = new WebSocketServer({ host: '0.0.0.0', port })

    server.on('listening', () => {
      wss = server
      currentPort = port
      console.info(`[remote] serving on ws://0.0.0.0:${port}`)
      emitStatus()
      resolve({ ok: true, port })
    })

    server.on('error', (err) => {
      if (!wss) {
        console.warn(`[remote] failed to start on port ${port}: ${err.message}`)
        try {
          server.close()
        } catch {}
        resolve({ ok: false, error: err.message })
      }
    })

    server.on('connection', (ws) => {
      clients.add(ws)
      emitStatus()
      ws.on('close', () => {
        clients.delete(ws)
        emitStatus()
      })
      ws.on('error', () => {
        clients.delete(ws)
        emitStatus()
      })
      ws.on('message', (raw) => handleMessage(ws, raw))
      send(ws, { t: 'hello', version: app.getVersion(), dev: !app.isPackaged })
    })
  })
}

export async function stopServer() {
  if (!wss) return
  for (const ws of clients) {
    try {
      ws.close()
    } catch {}
  }
  clients.clear()
  await new Promise((resolve) => wss.close(() => resolve()))
  wss = null
  currentPort = null
  emitStatus()
}

// Events tied to handlers the client runs locally must not be fanned out from
// the server.
const CLIENT_LOCAL_EVENTS = new Set()

/** Fan a `notify()` event out to every connected client. */
export function broadcast(channel, data) {
  if (!wss || clients.size === 0 || CLIENT_LOCAL_EVENTS.has(channel)) return
  let frame
  try {
    frame = encode({ t: 'event', channel, data })
  } catch (err) {
    console.warn(`[remote] failed to encode event ${channel}: ${err.message}`)
    return
  }
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(frame)
      } catch {}
    }
  }
}

function send(ws, obj) {
  try {
    ws.send(encode(obj))
  } catch (err) {
    console.warn(`[remote] send failed: ${err.message}`)
  }
}

async function handleMessage(ws, raw) {
  let msg
  try {
    msg = decode(raw.toString())
  } catch {
    return
  }
  if (!msg || msg.t !== 'rpc') return

  const { id, channel, args } = msg
  const handler = getHandler(channel)
  if (!handler) {
    send(ws, { t: 'err', id, error: { name: 'Error', message: `No remote handler for "${channel}"` } })
    return
  }

  let result
  try {
    result = await handler(stubEvent, ...(args || []))
  } catch (err) {
    sendError(ws, id, err)
    return
  }

  // Encode the reply explicitly (not via `send`, which swallows throws): if the
  // handler returned something the codec can't serialize, the client's pending
  // promise would otherwise hang forever. Fail it loud with an error frame.
  let frame
  try {
    frame = encode({ t: 'ok', id, result })
  } catch (err) {
    console.warn(`[remote] failed to encode result for "${channel}": ${err.message}`)
    sendError(ws, id, err)
    return
  }
  try {
    ws.send(frame)
  } catch (err) {
    console.warn(`[remote] send failed: ${err.message}`)
  }
}

function sendError(ws, id, err) {
  send(ws, {
    t: 'err',
    id,
    error: {
      name: err?.name || 'Error',
      message: err?.message || String(err),
      stack: !app.isPackaged ? err?.stack : undefined,
    },
  })
}
