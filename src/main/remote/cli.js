import { DEFAULT_REMOTE_PORT, normalizeConnectUrl } from '@shared/remote-config.js'

/**
 * Resolves the two remote-mode switches. Packaged builds pass them as argv
 * flags; `electron-vite dev` swallows unknown `--flags` (cac throws), so in dev
 * the equivalent env vars are used instead:
 *
 *   --serve            | VAM_SERVE=<port>   enable the server (headless)
 *   --serve=<port>     |                    ...on a specific port
 *   --connect=<ws-url> | VAM_CONNECT=<url>  run as a pure client head
 *
 * Both the serve port and the connect scheme/port are optional and fall back to
 * defaults, so a bare `--serve` (or `--connect=<host>`) is valid.
 *
 * Prefix scans (not positional) so argv layout differences don't matter.
 */

function coercePort(raw) {
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_REMOTE_PORT
}

export function getServePort(argv = process.argv, env = process.env) {
  const arg = argv.find((a) => a === '--serve' || a.startsWith('--serve='))
  if (arg) {
    const eq = arg.indexOf('=')
    return eq === -1 ? DEFAULT_REMOTE_PORT : coercePort(arg.slice(eq + 1))
  }
  if (env.VAM_SERVE) return coercePort(env.VAM_SERVE)
  return null
}

export function getConnectUrl(argv = process.argv, env = process.env) {
  const arg = argv.find((a) => a.startsWith('--connect='))
  const raw = arg ? arg.slice('--connect='.length) : env.VAM_CONNECT
  return normalizeConnectUrl(raw)
}
