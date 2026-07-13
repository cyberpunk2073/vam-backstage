/**
 * Remote WebSocket channel / event policy.
 *
 * Official clients already route machine-local work via LOCAL_CHANNELS / STUBS
 * in preload/remote-transport.js. This module is the server-side backstop so a
 * raw LAN peer cannot invoke those handlers (or shell.openExternal) either.
 */

const DENIED_PREFIXES = ['shell:', 'remote:', 'updater:', 'dev:']

const DENIED_CHANNELS = new Set([
  // Local-only fast path: reads a source path on the host machine. A remote
  // head has no such path and uses the chunked upload instead, so a raw peer
  // must not be able to make the server copy arbitrary local files.
  'packages:import-local-copy',
  'library-dirs:browse',
  'wizard:browse-vam-dir',
  'wizard:detect-vam-dir',
  'settings:getDatabasePath',
  'hub:isLoggedIn',
  'hub:resourceUserState',
  'hub:toggleFavorite',
  'hub:toggleBookmark',
  'hub:toggleRate',
  'hub:toggleLike',
  'wishlist:import-collect',
])

/** Events that stay on the host machine and must not cross the WS bridge. */
export const CLIENT_LOCAL_EVENTS = new Set([
  'hub:auth-changed',
  'updater:error',
  'updater:update-available',
  'updater:update-downloaded',
])

export function isRemoteChannelDenied(channel) {
  if (typeof channel !== 'string' || !channel) return true
  if (DENIED_CHANNELS.has(channel)) return true
  return DENIED_PREFIXES.some((prefix) => channel.startsWith(prefix))
}
