/** Shared defaults + parsing for remote (client-server) mode. */

export const DEFAULT_REMOTE_PORT = 42069

/**
 * Normalize a user-supplied server address into a canonical `ws(s)://host:port`
 * origin. Both the scheme and the port are optional and fall back to defaults:
 *
 *   "192.168.1.5"            -> "ws://192.168.1.5:42069"
 *   "192.168.1.5:9000"       -> "ws://192.168.1.5:9000"
 *   "ws://host"              -> "ws://host:42069"
 *   "wss://host:443"         -> "wss://host:443"
 *
 * Returns null for empty/invalid input.
 */
export function normalizeConnectUrl(input, defaultPort = DEFAULT_REMOTE_PORT) {
  if (!input) return null
  let s = String(input).trim()
  if (!s) return null
  if (!/^wss?:\/\//i.test(s)) s = `ws://${s}`
  let u
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (!u.hostname) return null
  if (!u.port) u.port = String(defaultPort)
  // `origin` yields `ws://host:port` (ws/wss are special schemes) — drops any
  // path/query, which is what we want for a bare server address.
  return u.origin
}
