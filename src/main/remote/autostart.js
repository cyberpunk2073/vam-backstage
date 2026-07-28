import { normalizeConnectUrl } from '@shared/remote-config.js'
import { installPrefs } from '../prefs.js'

/**
 * Client auto-connect, expressed over the installation prefs (see prefs.js):
 * `autoconnect` arms it and `connectUrl` holds the address as the user typed it.
 * Both sit in the base userData dir, so a client head arms the same value the
 * host's escape hatch (`remote:relaunch-disconnect`) can clear — neither side
 * needs a database for it.
 *
 * Disarming deliberately keeps `connectUrl`: the address stays in the Settings
 * field, ready to re-offer, and nothing else in the file is disturbed.
 */

/** The armed connect URL (normalized), or null when disarmed / unparseable. */
export function readAutostartUrl() {
  if (!installPrefs.get('autoconnect')) return null
  return normalizeConnectUrl(installPrefs.get('connectUrl'))
}

export function disarmAutostart() {
  installPrefs.set('autoconnect', false)
}
