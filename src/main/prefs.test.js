import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { DEFAULT_REMOTE_PORT } from '@shared/remote-config.js'
import { installPrefs, instancePrefs } from './prefs.js'
import { readAutostartUrl, disarmAutostart } from './remote/autostart.js'

let dir

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vam-prefs-'))
  installPrefs.init(dir)
  instancePrefs.init(dir)
})

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

const installFile = () => join(dir, 'install-prefs.json')
const writeInstallFile = (data) => writeFile(installFile(), JSON.stringify(data), 'utf8')

describe('prefs store', () => {
  it('returns declared defaults when the file is absent', () => {
    expect(existsSync(installFile())).toBe(false)
    expect(installPrefs.get('updateChannel')).toBe('stable')
    expect(installPrefs.get('devUnlocked')).toBe(false)
    expect(installPrefs.get('servePort')).toBe(DEFAULT_REMOTE_PORT)
    expect(instancePrefs.get('windowState')).toBeNull()
  })

  it('round-trips values through the file', () => {
    installPrefs.set('updateChannel', 'dev')
    instancePrefs.set('windowState', { x: 1, y: 2, width: 800, height: 600, isMaximized: false })
    expect(installPrefs.get('updateChannel')).toBe('dev')
    expect(instancePrefs.get('windowState')).toEqual({ x: 1, y: 2, width: 800, height: 600, isMaximized: false })
  })

  it('keeps the two scopes in separate files', async () => {
    installPrefs.set('updateChannel', 'dev')
    instancePrefs.set('windowState', { x: 0, y: 0, width: 100, height: 100 })
    const install = JSON.parse(await readFile(installFile(), 'utf8'))
    const instance = JSON.parse(await readFile(join(dir, 'instance-prefs.json'), 'utf8'))
    expect(install).toEqual({ updateChannel: 'dev' })
    expect(instance.windowState).toBeTruthy()
    expect(install.windowState).toBeUndefined()
  })

  it('distinguishes "explicitly set" from "defaulted"', () => {
    expect(installPrefs.has('updateChannel')).toBe(false)
    installPrefs.set('updateChannel', 'stable')
    expect(installPrefs.has('updateChannel')).toBe(true)
  })

  it('rejects unknown keys instead of writing them', () => {
    expect(() => installPrefs.get('nope')).toThrow(/unknown pref key/)
    expect(() => installPrefs.set('nope', 1)).toThrow(/unknown pref key/)
  })

  it('coerces bad values to the declared default', async () => {
    await writeInstallFile({ updateChannel: 'nightly', devUnlocked: 'yes', servePort: 'abc' })
    expect(installPrefs.get('updateChannel')).toBe('stable')
    expect(installPrefs.get('devUnlocked')).toBe(false)
    expect(installPrefs.get('servePort')).toBe(DEFAULT_REMOTE_PORT)
  })

  it('accepts a numeric string port (the Settings field is text)', () => {
    installPrefs.set('servePort', '9000')
    expect(installPrefs.get('servePort')).toBe(9000)
  })

  it('falls back to defaults on a corrupt file rather than throwing', async () => {
    await writeFile(installFile(), '{ not json', 'utf8')
    expect(installPrefs.get('updateChannel')).toBe('stable')
    // And a write repairs the file.
    installPrefs.set('updateChannel', 'dev')
    expect(installPrefs.get('updateChannel')).toBe('dev')
  })

  it('preserves keys it does not know about, so an older build cannot clobber a newer one', async () => {
    await writeInstallFile({ updateChannel: 'dev', futureKey: 'keep me' })
    installPrefs.set('devUnlocked', true)
    const raw = JSON.parse(await readFile(installFile(), 'utf8'))
    expect(raw.futureKey).toBe('keep me')
    expect(raw.updateChannel).toBe('dev')
  })

  it('publishes through a per-pid scratch file and leaves nothing behind', async () => {
    installPrefs.set('updateChannel', 'dev')
    expect(await readdir(dir)).toEqual(['install-prefs.json'])
  })

  it('is unaffected by a scratch file left by another process', async () => {
    // A shared scratch name would let the other head's half-written bytes get
    // published as ours; ours is pid-scoped, so this file is inert.
    await writeFile(join(dir, 'install-prefs.json.999999.tmp'), 'garbage', 'utf8')
    installPrefs.set('updateChannel', 'dev')
    expect(JSON.parse(await readFile(installFile(), 'utf8'))).toEqual({ updateChannel: 'dev' })
  })

  it('merges concurrent writes from another instance sharing the install file', async () => {
    installPrefs.set('updateChannel', 'dev')
    // Simulates the other head on this machine writing a different key between
    // our read and our write.
    await writeInstallFile({ updateChannel: 'dev', connectUrl: 'ws://host:42069' })
    installPrefs.set('devUnlocked', true)
    expect(installPrefs.pick(['updateChannel', 'connectUrl', 'devUnlocked'])).toEqual({
      updateChannel: 'dev',
      connectUrl: 'ws://host:42069',
      devUnlocked: true,
    })
  })
})

describe('client auto-connect over prefs', () => {
  it('is disarmed by default', () => {
    expect(readAutostartUrl()).toBeNull()
  })

  it('normalizes the stored address when armed', () => {
    installPrefs.patch({ connectUrl: '192.168.1.5', autoconnect: true })
    expect(readAutostartUrl()).toBe(`ws://192.168.1.5:${DEFAULT_REMOTE_PORT}`)
  })

  it('reports disarmed while an unparseable address is armed', () => {
    installPrefs.patch({ connectUrl: '   ', autoconnect: true })
    expect(readAutostartUrl()).toBeNull()
  })

  it('keeps the address when disarming', () => {
    installPrefs.patch({ connectUrl: '192.168.1.5', autoconnect: true })
    disarmAutostart()
    expect(readAutostartUrl()).toBeNull()
    expect(installPrefs.get('connectUrl')).toBe('192.168.1.5')
  })
})
