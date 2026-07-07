import { join, dirname } from 'path'
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'fs'
import { normalizeConnectUrl } from '@shared/remote-config.js'

/**
 * Client auto-connect persistence. A client head has no SQLite DB, so this
 * lives in a tiny standalone JSON file: `{ "url": "ws://host:port" }`. Presence
 * of a valid URL = "start as a client pointed here on next launch".
 *
 * Critically, the file sits in the *base* userData dir — captured before the
 * `-client` userData swap in index.js — so both a normal/host instance and a
 * client head resolve the same path (`initAutostart` is called once at startup,
 * before the swap). That lets the client arm/disarm it and lets the escape hatch
 * clear it, all without a database.
 */

let filePath = null

/** Bind the base userData dir. Must be called before any read/write, and before
 *  the client `-client` userData swap so both instances agree on the path. */
export function initAutostart(baseUserDataDir) {
  filePath = join(baseUserDataDir, 'client-autostart.json')
}

/** The armed connect URL (normalized), or null if disarmed/absent/invalid. */
export function readAutostartUrl() {
  if (!filePath || !existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return normalizeConnectUrl(parsed?.url)
  } catch {
    return null
  }
}

/** Arm with `url` (any accepted address form; stored normalized), or disarm by
 *  passing a falsy/invalid value (removes the file). */
export function writeAutostartUrl(url) {
  if (!filePath) return
  const normalized = normalizeConnectUrl(url)
  try {
    if (normalized) {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, JSON.stringify({ url: normalized }), 'utf8')
    } else {
      rmSync(filePath, { force: true })
    }
  } catch (err) {
    console.warn('[remote] failed to persist client autostart:', err.message)
  }
}
