import { join } from 'path'
import { existsSync, readFileSync, rmSync } from 'fs'
import { normalizeConnectUrl } from '@shared/remote-config.js'
import { deleteSetting, getSetting, setSetting } from './db.js'
import { installPrefs, instancePrefs } from './prefs.js'

/**
 * The one-time move of machine-scoped settings out of their legacy homes and into
 * the prefs files (see prefs.js for the scope split). Both halves live here, and
 * nowhere else, so retiring this is deleting one module plus its two call sites
 * rather than hunting legacy branches through live code.
 *
 * Two halves because they have different prerequisites:
 *
 *   `foldLegacyClientAutostart` — file to file, no DB. Cannot go through
 *      `runStartupMigrations`: it has to land before index.js resolves the connect
 *      URL at module scope, and it has to run on a *client head* too — which is
 *      the instance that owns an armed URL and has no database to migrate from.
 *      Self-limiting: it removes the file it reads, so after the first launch the
 *      cost is one `existsSync`.
 *   `migrateMachinePrefs` — DB to prefs, so it runs from `runStartupMigrations`
 *      once the DB is open, on the data-side instance only, guarded by a flag in
 *      the settings table like every other startup migration.
 *
 * Retirement: safe to delete once no install can still be coming from a build
 * that predates the prefs files.
 */

const LEGACY_AUTOSTART_FILE = 'client-autostart.json'
const FLAG_KEY = 'machine_prefs_migrated'

/** [settings key, store, pref key, coercion from the stringly-typed column]. */
const MOVED_KEYS = [
  ['update_channel', installPrefs, 'updateChannel', (v) => (v === 'dev' ? 'dev' : 'stable')],
  ['developer_options_unlocked', installPrefs, 'devUnlocked', (v) => v === '1'],
  ['remote_connect_url', installPrefs, 'connectUrl', (v) => v],
  ['remote_mode_enabled', installPrefs, 'remoteEnabled', (v) => v === '1'],
  ['remote_serve_on_launch', installPrefs, 'serveOnLaunch', (v) => v === '1'],
  ['remote_serve_port', installPrefs, 'servePort', (v) => v],
  ['main_window_state', instancePrefs, 'windowState', (v) => JSON.parse(v)],
]

/**
 * Fold the pre-prefs `client-autostart.json` — a standalone `{ url }` file whose
 * mere existence meant "armed" — into `connectUrl` + `autoconnect`. The file is
 * removed once its contents are safely in the prefs, so a downgrade/upgrade
 * round-trip can't resurrect a stale arm pointing at a host that's long gone.
 *
 * "Once safely in the prefs" is the load-bearing part: until this runs, that file
 * is the only copy of the address, and a client head that comes up local with
 * nothing on disk to explain why is the worst outcome available here. So every
 * step that can fail leaves the file alone for the next launch to retry.
 */
export function foldLegacyClientAutostart(baseUserDataDir) {
  const legacyPath = join(baseUserDataDir, LEGACY_AUTOSTART_FILE)
  if (!existsSync(legacyPath)) return

  let raw
  try {
    raw = readFileSync(legacyPath, 'utf8')
  } catch (err) {
    console.warn('[prefs] could not read legacy autostart file:', err.message)
    return
  }

  let url = null
  try {
    url = normalizeConnectUrl(JSON.parse(raw)?.url)
  } catch {}

  // An arm already in the prefs is newer than the legacy file by definition.
  if (url && !installPrefs.get('autoconnect')) {
    if (!installPrefs.patch({ connectUrl: url, autoconnect: true })) {
      console.warn('[prefs] legacy autostart kept, prefs write failed:', installPrefs.path())
      return
    }
    console.log('[prefs] folded legacy client autostart:', url)
  }

  try {
    rmSync(legacyPath, { force: true })
  } catch (err) {
    console.warn('[prefs] failed to remove legacy autostart file:', err.message)
  }
}

/**
 * Copy the machine-scoped `settings` rows into the prefs files and drop them.
 * Existing prefs win: a client head on this machine may already have written its
 * own value into the shared install file, and that choice is newer than whatever
 * the DB has been carrying.
 */
export function migrateMachinePrefs() {
  if (getSetting(FLAG_KEY) === '1') return

  for (const [settingKey, store, prefKey, coerce] of MOVED_KEYS) {
    const raw = getSetting(settingKey)
    if (raw != null && raw !== '' && !store.has(prefKey)) {
      try {
        store.set(prefKey, coerce(raw))
      } catch (err) {
        console.warn(`[prefs] could not migrate ${settingKey}:`, err.message)
      }
    }
    deleteSetting(settingKey)
  }

  setSetting(FLAG_KEY, '1')
}
