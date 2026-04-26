import { inspect } from 'util'

/**
 * Mirrors main-process console output into the renderer's DevTools console
 * (prefixed `[main]`) so support users who unlock DevTools (F12) can see
 * everything without attaching a debugger or terminal.
 *
 * Messages emitted before the renderer finishes loading are kept in a small
 * ring buffer and flushed on `did-finish-load`.
 *
 * Callers wrap `forwardLogToRenderer` in a try/catch (it runs from inside
 * a console.* override), so we don't bother catching internally — any throw
 * just gets swallowed at the call site.
 */

const RING_CAPACITY = 500
const ring = []
let getWindow = () => null

/**
 * Convert one console arg to an IPC-safe value. structured-clone (used by
 * webContents.send) chokes on Errors (loses stack), functions, symbols,
 * cyclic graphs, and DOM-ish things. Pass primitives through untouched so
 * DevTools can still format them with %s/%d/%o specifiers; stringify the rest.
 */
function serializeArg(arg) {
  if (arg === null || arg === undefined) return arg
  const t = typeof arg
  if (t === 'string' || t === 'number' || t === 'boolean') return arg
  if (t === 'bigint') return arg.toString() + 'n'
  if (t === 'function' || t === 'symbol') return String(arg)
  if (arg instanceof Error) {
    return { __mainLogError: true, name: arg.name, message: arg.message, stack: arg.stack }
  }
  try {
    return inspect(arg, { depth: 4, breakLength: 120, maxArrayLength: 50 })
  } catch (err) {
    return `[unserializable: ${err.message}]`
  }
}

function serializeArgs(args) {
  const out = new Array(args.length)
  for (let i = 0; i < args.length; i++) out[i] = serializeArg(args[i])
  return out
}

export function initLogForward(getMainWindow) {
  getWindow = getMainWindow
}

export function forwardLogToRenderer(level, args) {
  const payload = { level, args: serializeArgs(args), ts: Date.now() }
  const win = getWindow?.()
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (wc && !wc.isLoading() && !wc.isCrashed()) {
    wc.send('main:log', payload)
    return
  }
  if (ring.length >= RING_CAPACITY) ring.shift()
  ring.push(payload)
}

export function flushBufferedLogs() {
  if (ring.length === 0) return
  const win = getWindow?.()
  const wc = win && !win.isDestroyed() ? win.webContents : null
  if (!wc || wc.isCrashed()) return
  // Per-item catch: one bad payload (clone failure, etc.) shouldn't sink the
  // rest of the queue. Drain first so a throw can't desync the ring.
  const pending = ring.splice(0, ring.length)
  for (const payload of pending) {
    try {
      wc.send('main:log', payload)
    } catch {}
  }
}
