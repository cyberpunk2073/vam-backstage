import { ipcMain, app } from 'electron'
import { networkInterfaces } from 'os'
import { createSocket } from 'dgram'
import { normalizeConnectUrl } from '@shared/remote-config.js'
import { startServer, stopServer, getStatus } from '../remote/server.js'
import { disarmAutostart, readAutostartUrl } from '../remote/autostart.js'
import { installPrefs } from '../prefs.js'

/**
 * Local-mode control surface for the Settings tab. Server start/stop is a true
 * hot toggle; switching a running instance into (or out of) client mode is done
 * by relaunching with the appropriate argv, which sidesteps tearing down an
 * already-initialised backend / renderer.
 *
 * The config handlers are also the renderer's only door to the remote prefs,
 * which are machine-scoped (see prefs.js). Going through `settings:*` would
 * route a client's reads and writes to the *host's* database — the client would
 * show the host's remembered address and overwrite it on connect. The `remote:`
 * prefix is client-local in the preload transport and denied at the server, so
 * that routing is correct by construction.
 */

function relaunchWithArgs(extra) {
  // Drop our own switches from the current argv, then append the new ones.
  const base = process.argv
    .slice(1)
    .filter((a) => a !== '--serve' && !a.startsWith('--serve=') && !a.startsWith('--connect='))
  app.relaunch({ args: [...base, ...extra] })
  app.exit(0)
}

/**
 * List this machine's non-internal IPv4 addresses (address + adapter name).
 * With VPNs, Docker/VM bridges, and multiple NICs there's no single "correct"
 * LAN IP, so we return them all and let the caller present the choices.
 */
function listLocalIps() {
  const out = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      // Node <18 uses the string 'IPv4'; newer versions use the number 4.
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, address: a.address })
    }
  }
  return out
}

/**
 * Best-effort "primary" LAN IP: open a UDP socket toward a public address and
 * read back which local interface the OS routing table would use. No packet is
 * actually sent (UDP connect only sets the default peer), so this needs no
 * network access and is instant. It reflects the real egress interface, which
 * is usually the one a LAN client should target — though on an active VPN it may
 * be the tunnel address, hence we also expose the full list above.
 */
function primaryLocalIp() {
  return new Promise((resolve) => {
    let settled = false
    const sock = createSocket('udp4')
    const finish = (v) => {
      if (settled) return
      settled = true
      try {
        sock.close()
      } catch {}
      resolve(v)
    }
    sock.on('error', () => finish(null))
    try {
      sock.connect(53, '8.8.8.8', () => {
        try {
          finish(sock.address().address || null)
        } catch {
          finish(null)
        }
      })
    } catch {
      finish(null)
    }
    setTimeout(() => finish(null), 300)
  })
}

// Short-lived cache for local-IP detection. The underlying calls are already
// cheap (a routing-table lookup via UDP connect — no packet sent — plus a
// networkInterfaces() syscall), but this coalesces bursts of remounts while
// still picking up adapter changes (VPN up/down, dock/undock) within seconds.
let ipCache = null
const IP_CACHE_TTL_MS = 15000

/** Everything `remote:get-config` reports, and the renderer's write allowlist. */
const CONFIG_KEYS = ['connectUrl', 'autoconnect', 'remoteEnabled', 'serveOnLaunch', 'servePort']

function readConfig() {
  // `autoconnect` is reported as the *effective* arm — armed with an address that
  // parses, the rule autostart.js owns — overriding the raw flag from the file, so
  // the renderer has one boolean to trust instead of two fields to reconcile.
  return { ...installPrefs.pick(CONFIG_KEYS), autoconnect: readAutostartUrl() !== null }
}

export function registerRemoteHandlers() {
  ipcMain.handle('remote:status', () => getStatus())

  ipcMain.handle('remote:local-ips', async () => {
    if (ipCache && Date.now() - ipCache.at < IP_CACHE_TTL_MS) return ipCache.value
    const all = listLocalIps()
    const primary = await primaryLocalIp()
    // Surface the egress interface first when it's among the enumerated NICs.
    const ordered = primary
      ? [...all].sort((a, b) => (a.address === primary ? -1 : b.address === primary ? 1 : 0))
      : all
    const value = { primary: primary || all[0]?.address || null, all: ordered }
    ipCache = { at: Date.now(), value }
    return value
  })

  ipcMain.handle('remote:start', async (_e, port) => {
    return await startServer(port || undefined)
  })

  ipcMain.handle('remote:stop', async () => {
    await stopServer()
    return { ok: true }
  })

  ipcMain.handle('remote:relaunch-connect', (_e, url) => {
    if (!url || typeof url !== 'string') return { ok: false, error: 'invalid url' }
    relaunchWithArgs([`--connect=${url}`])
    return { ok: true }
  })

  ipcMain.handle('remote:relaunch-disconnect', () => {
    // Any deliberate exit to local mode also disarms client auto-connect, so a
    // saved client can't immediately relaunch back into itself (and an offline
    // host can never trap the user in a connect loop).
    disarmAutostart()
    relaunchWithArgs([])
    return { ok: true }
  })

  ipcMain.handle('remote:get-config', () => readConfig())

  /** Partial patch; unknown keys are ignored. Returns the resulting config. */
  ipcMain.handle('remote:set-config', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return readConfig()
    const next = {}
    for (const key of CONFIG_KEYS) {
      if (Object.hasOwn(patch, key)) next[key] = patch[key]
    }
    // Arming without a parseable address would produce a head that relaunches
    // into a connection it can never make, so drop the arm and keep the address.
    if (next.autoconnect === true) {
      const address = Object.hasOwn(next, 'connectUrl') ? next.connectUrl : installPrefs.get('connectUrl')
      if (!normalizeConnectUrl(address)) {
        console.warn('[remote] refusing to arm auto-connect for unparseable address:', address)
        delete next.autoconnect
      }
    }
    // Nothing recognised, or the arm was the only key and got refused: no write.
    if (Object.keys(next).length) installPrefs.patch(next)
    return readConfig()
  })
}
