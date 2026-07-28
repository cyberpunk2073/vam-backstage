import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_REMOTE_PORT } from '@shared/remote-config.js'

const mocks = vi.hoisted(() => {
  const handlers = new Map()
  return {
    handlers,
    electron: {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { relaunch: () => {}, exit: () => {} },
    },
    // The real module pulls in the WS server and the database; nothing here
    // touches server control.
    server: { startServer: async () => ({ ok: true }), stopServer: async () => {}, getStatus: () => null },
  }
})

vi.mock('electron', () => mocks.electron)
vi.mock('../remote/server.js', () => mocks.server)

const { registerRemoteHandlers } = await import('./remote.js')
const { installPrefs } = await import('../prefs.js')

const call = (channel, arg) => mocks.handlers.get(channel)({}, arg)

describe('remote config handlers', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'remote-config-'))
    installPrefs.init(dir)
    mocks.handlers.clear()
    registerRemoteHandlers()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports declared defaults before anything is written', () => {
    expect(call('remote:get-config')).toEqual({
      connectUrl: '',
      autoconnect: false,
      remoteEnabled: false,
      serveOnLaunch: false,
      servePort: DEFAULT_REMOTE_PORT,
    })
  })

  it('applies a partial patch, coerces types, and returns the result', () => {
    const cfg = call('remote:set-config', { remoteEnabled: true, servePort: '8080' })
    expect(cfg).toMatchObject({ remoteEnabled: true, servePort: 8080, serveOnLaunch: false })
    expect(call('remote:get-config').servePort).toBe(8080)
  })

  it('ignores keys outside the config surface', () => {
    const cfg = call('remote:set-config', { serveOnLaunch: true, vam_dir: '/elsewhere' })
    expect(cfg.serveOnLaunch).toBe(true)
    expect(cfg).not.toHaveProperty('vam_dir')
  })

  it('survives a garbage payload', () => {
    expect(call('remote:set-config', null).servePort).toBe(DEFAULT_REMOTE_PORT)
    expect(call('remote:set-config', 'nope').remoteEnabled).toBe(false)
  })

  it('arms auto-connect with an address supplied in the same patch', () => {
    const cfg = call('remote:set-config', { connectUrl: '192.168.1.5', autoconnect: true })
    // Stored as typed; normalization happens where the URL is used.
    expect(cfg).toMatchObject({ connectUrl: '192.168.1.5', autoconnect: true })
  })

  it('arms against the already-stored address when only the flag is flipped', () => {
    call('remote:set-config', { connectUrl: '192.168.1.5:9000' })
    expect(call('remote:set-config', { autoconnect: true }).autoconnect).toBe(true)
  })

  it('refuses to arm without a parseable address, keeping the address on offer', () => {
    const cfg = call('remote:set-config', { connectUrl: 'not a host', autoconnect: true })
    expect(cfg).toMatchObject({ connectUrl: 'not a host', autoconnect: false })
  })

  it('disarming keeps the address so the field can re-offer it', () => {
    call('remote:set-config', { connectUrl: '192.168.1.5', autoconnect: true })
    expect(call('remote:set-config', { autoconnect: false })).toMatchObject({
      connectUrl: '192.168.1.5',
      autoconnect: false,
    })
  })

  it('reports the effective arm, not the raw flag', () => {
    // Reachable only from outside these handlers (a legacy file, a hand-edit): the
    // flag is set but there is no address to connect to.
    installPrefs.patch({ autoconnect: true })
    expect(installPrefs.get('autoconnect')).toBe(true)
    expect(call('remote:get-config').autoconnect).toBe(false)
  })
})
