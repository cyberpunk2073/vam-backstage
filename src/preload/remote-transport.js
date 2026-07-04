import { ipcRenderer } from 'electron'
import { encode, decode } from '@shared/net-codec.js'

/**
 * Client-side transport used when this instance runs as a pure head
 * (`--connect=<ws-url>`). Presents the same `{ invoke, on }` surface the preload
 * otherwise gets from `ipcRenderer`, but routes each channel one of three ways:
 *
 *   local  — handled by the client's own main process (app/version, dev flag,
 *            self-updater, opening external links on the *user's* machine, and
 *            the remote-control channels themselves).
 *   stub   — resolved locally without a round-trip, for things that are
 *            meaningless on a remote head (native file pickers, reveal-in-folder).
 *   remote — sent over the socket to the server's handler registry.
 *
 * Events are delivered from BOTH the socket (server-side `notify()`) and the
 * local ipcRenderer (client-side updater), so listeners see either source.
 */

const LOCAL_CHANNELS = new Set([
  'app:version',
  'dev:is-dev',
  'updater:install',
  'updater:check',
  'updater:getChannel',
  'updater:setChannel',
  'shell:openExternal',
])

// Channels resolved locally without hitting the server. A function value is
// invoked with the call args; anything else is returned as-is.
const STUBS = {
  'library-dirs:browse': { cancelled: true },
  'wizard:browse-vam-dir': { cancelled: true },
  'wizard:detect-vam-dir': { path: null, varCount: 0, source: null },
  'shell:showItemInFolder': undefined,
  'dev:nuke-database': { ok: false, error: 'not supported in remote mode' },
}

function rebuildError(info) {
  const err = new Error(info?.message || 'Remote error')
  if (info?.name) err.name = info.name
  if (info?.stack) err.stack = info.stack
  return err
}

export function createRemoteTransport(url) {
  let ws = null
  let ready = false // hello received + version gate passed
  let everConnected = false
  let fatal = null // version-mismatch message; blocks all remote invokes
  let reconnectTimer = null
  let backoff = 500

  let nextId = 1
  const pending = new Map() // id -> { resolve, reject }
  const queue = [] // frames waiting for `ready`

  const log = (...a) => console.info('[remote-client]', ...a)

  const eventSubs = new Map() // channel -> Set<cb>
  const statusSubs = new Set()

  let localVersion = null
  let localDev = false

  function emitStatus() {
    const status = { connected: ready, url, error: fatal }
    for (const cb of statusSubs) {
      try {
        cb(status)
      } catch {}
    }
  }

  function connect() {
    log('connecting to', url)
    try {
      ws = new WebSocket(url)
    } catch (err) {
      log('WebSocket ctor threw:', err?.message)
      scheduleReconnect()
      return
    }
    ws.onopen = () => {
      log('socket open')
      backoff = 500
    }
    ws.onmessage = (ev) => onFrame(ev.data)
    ws.onclose = (ev) => {
      log('socket closed', ev?.code ?? '', ev?.reason ?? '')
      ready = false
      ws = null
      emitStatus()
      if (!fatal) scheduleReconnect()
    }
    ws.onerror = () => {
      // `onclose` follows and handles reconnect.
    }
  }

  function scheduleReconnect() {
    if (fatal || reconnectTimer) return
    log('reconnect in', backoff, 'ms')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoff)
    backoff = Math.min(backoff * 2, 10000)
  }

  function onFrame(raw) {
    let msg
    try {
      msg = decode(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (msg.t === 'hello') {
      onHello(msg)
    } else if (msg.t === 'event') {
      dispatchEvent(msg.channel, msg.data)
    } else if (msg.t === 'ok' || msg.t === 'err') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.t === 'ok') p.resolve(msg.result)
      else p.reject(rebuildError(msg.error))
    }
  }

  function onHello(msg) {
    // Exact app-version match required, relaxed when either side is dev.
    const mismatch = localVersion && msg.version && localVersion !== msg.version
    if (mismatch && (localDev || msg.dev)) {
      log(`version mismatch (server ${msg.version}, client ${localVersion}) allowed — dev build on one side`)
    }
    if (mismatch && !localDev && !msg.dev) {
      fatal = `Version mismatch: server ${msg.version}, client ${localVersion}. Update both to the same version.`
      ready = false
      emitStatus()
      // Fail everything pending/queued — no point retrying a mismatched server.
      const err = new Error(fatal)
      queue.length = 0
      for (const [, p] of pending) p.reject(err)
      pending.clear()
      try {
        ws?.close()
      } catch {}
      return
    }

    ready = true
    emitStatus()
    log('hello ok — connected (server', msg.version + ')')

    // A reconnect after a prior session: renderer state is stale, so reload for
    // a clean re-fetch (dirty-v1 resync strategy).
    if (everConnected) {
      log('reconnected after prior session — reloading renderer')
      window.location.reload()
      return
    }
    everConnected = true

    for (const frame of queue.splice(0)) rawSend(frame)
  }

  function rawSend(frame) {
    try {
      ws.send(encode(frame))
    } catch (err) {
      const p = pending.get(frame.id)
      if (p) {
        pending.delete(frame.id)
        p.reject(err)
      }
    }
  }

  function dispatchEvent(channel, data) {
    const subs = eventSubs.get(channel)
    if (!subs) return
    for (const cb of subs) {
      try {
        cb(data)
      } catch {}
    }
  }

  function remoteInvoke(channel, args) {
    if (fatal) return Promise.reject(new Error(fatal))
    return new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      const frame = { t: 'rpc', id, channel, args }
      if (ready && ws && ws.readyState === WebSocket.OPEN) rawSend(frame)
      else queue.push(frame)
    })
  }

  function invoke(channel, ...args) {
    // All `remote:*` control channels are handled by the client's own main
    // process (server toggle is meaningless here; relaunch acts on this machine).
    if (channel.startsWith('remote:') || LOCAL_CHANNELS.has(channel)) return ipcRenderer.invoke(channel, ...args)
    if (channel in STUBS) {
      const v = STUBS[channel]
      return Promise.resolve(typeof v === 'function' ? v(...args) : v)
    }
    return remoteInvoke(channel, args)
  }

  function on(channel, callback) {
    // Remote (socket) subscription.
    let subs = eventSubs.get(channel)
    if (!subs) {
      subs = new Set()
      eventSubs.set(channel, subs)
    }
    subs.add(callback)
    // Local (client main) subscription — covers updater events emitted here.
    const localHandler = (_e, ...a) => callback(...a)
    ipcRenderer.on(channel, localHandler)
    return () => {
      subs.delete(callback)
      ipcRenderer.removeListener(channel, localHandler)
    }
  }

  // Resolve the client's own identity via its local handlers (no extra CLI
  // args) BEFORE opening the socket — otherwise a fast `hello` can beat the
  // fetch, leaving `localVersion` null and silently skipping the version gate.
  Promise.allSettled([
    ipcRenderer.invoke('app:version').then((v) => (localVersion = v)),
    ipcRenderer.invoke('dev:is-dev').then((v) => (localDev = !!v)),
  ]).finally(connect)

  return {
    invoke,
    on,
    remote: {
      isRemote: true,
      url,
      onStatus: (cb) => {
        statusSubs.add(cb)
        cb({ connected: ready, url, error: fatal })
        return () => statusSubs.delete(cb)
      },
    },
  }
}
