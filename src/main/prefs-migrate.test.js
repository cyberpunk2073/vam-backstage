import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import { mkTempVamDir, openTestDatabase } from '../../test/fixtures/index.js'
import { closeDatabase, getSetting, setSetting } from './db.js'
import { installPrefs, instancePrefs } from './prefs.js'
import { readAutostartUrl } from './remote/autostart.js'
import { foldLegacyClientAutostart, migrateMachinePrefs } from './prefs-migrate.js'

let tmp
let userData

beforeEach(async () => {
  tmp = await mkTempVamDir()
  await openTestDatabase(tmp.dbPath)
  userData = dirname(tmp.dbPath)
  installPrefs.init(userData)
  instancePrefs.init(userData)
})

afterEach(async () => {
  closeDatabase()
  if (tmp) await tmp.cleanup()
  delete process.env.VAM_DB_PATH
})

describe('migrateMachinePrefs', () => {
  it('moves the machine-scoped settings into the prefs files and drops the rows', () => {
    setSetting('update_channel', 'dev')
    setSetting('developer_options_unlocked', '1')
    setSetting('remote_connect_url', '192.168.1.5')
    setSetting('remote_mode_enabled', '1')
    setSetting('remote_serve_on_launch', '1')
    setSetting('remote_serve_port', '9000')
    setSetting('main_window_state', JSON.stringify({ x: 10, y: 20, width: 900, height: 700, isMaximized: true }))

    migrateMachinePrefs()

    expect(
      installPrefs.pick(['updateChannel', 'devUnlocked', 'connectUrl', 'remoteEnabled', 'serveOnLaunch', 'servePort']),
    ).toEqual({
      updateChannel: 'dev',
      devUnlocked: true,
      connectUrl: '192.168.1.5',
      remoteEnabled: true,
      serveOnLaunch: true,
      servePort: 9000,
    })
    expect(instancePrefs.get('windowState')).toEqual({ x: 10, y: 20, width: 900, height: 700, isMaximized: true })

    for (const key of [
      'update_channel',
      'developer_options_unlocked',
      'remote_connect_url',
      'remote_mode_enabled',
      'remote_serve_on_launch',
      'remote_serve_port',
      'main_window_state',
    ]) {
      expect(getSetting(key)).toBeNull()
    }
  })

  it('leaves library settings alone', () => {
    setSetting('vam_dir', tmp.vamDir)
    setSetting('disable_behavior', 'suffix')
    migrateMachinePrefs()
    expect(getSetting('vam_dir')).toBe(tmp.vamDir)
    expect(getSetting('disable_behavior')).toBe('suffix')
  })

  // The install file is shared with a client head on this machine, which may have
  // written its own choice before the host ever ran this migration.
  it('does not clobber a value the prefs already hold', () => {
    installPrefs.set('updateChannel', 'dev')
    setSetting('update_channel', 'stable')
    migrateMachinePrefs()
    expect(installPrefs.get('updateChannel')).toBe('dev')
  })

  it('runs once, so a later pref change is not undone by a stale DB row', () => {
    setSetting('update_channel', 'dev')
    migrateMachinePrefs()
    expect(getSetting('machine_prefs_migrated')).toBe('1')

    installPrefs.set('updateChannel', 'stable')
    setSetting('update_channel', 'dev') // as an older build would have written it
    migrateMachinePrefs()
    expect(installPrefs.get('updateChannel')).toBe('stable')
    expect(getSetting('update_channel')).toBe('dev')
  })

  it('tolerates a corrupt window-state row', () => {
    setSetting('main_window_state', '{ not json')
    expect(() => migrateMachinePrefs()).not.toThrow()
    expect(instancePrefs.get('windowState')).toBeNull()
    expect(getSetting('main_window_state')).toBeNull()
  })
})

describe('foldLegacyClientAutostart', () => {
  const legacyPath = () => join(userData, 'client-autostart.json')

  it('folds the legacy file into the prefs and removes it', async () => {
    await writeFile(legacyPath(), JSON.stringify({ url: 'ws://10.0.0.2:42069' }), 'utf8')
    foldLegacyClientAutostart(userData)
    expect(readAutostartUrl()).toBe('ws://10.0.0.2:42069')
    expect(existsSync(legacyPath())).toBe(false)
  })

  it('does not let a stale legacy file override a newer arm', async () => {
    installPrefs.patch({ connectUrl: 'ws://10.0.0.9:42069', autoconnect: true })
    await writeFile(legacyPath(), JSON.stringify({ url: 'ws://10.0.0.2:42069' }), 'utf8')
    foldLegacyClientAutostart(userData)
    expect(readAutostartUrl()).toBe('ws://10.0.0.9:42069')
    expect(existsSync(legacyPath())).toBe(false)
  })

  it('drops a corrupt legacy file without arming anything', async () => {
    await writeFile(legacyPath(), '{ not json', 'utf8')
    foldLegacyClientAutostart(userData)
    expect(readAutostartUrl()).toBeNull()
    expect(existsSync(legacyPath())).toBe(false)
  })

  it('is a no-op without a legacy file', () => {
    foldLegacyClientAutostart(userData)
    expect(readAutostartUrl()).toBeNull()
  })

  // Losing both at once — no prefs written and the source deleted — is the one
  // unrecoverable outcome: the head comes up local with nothing left to retry from.
  it('keeps the legacy file when the prefs write cannot land', async () => {
    await writeFile(legacyPath(), JSON.stringify({ url: 'ws://10.0.0.2:42069' }), 'utf8')
    const blocker = join(userData, 'not-a-dir')
    await writeFile(blocker, '', 'utf8')
    installPrefs.init(join(blocker, 'nested'))

    foldLegacyClientAutostart(userData)

    expect(installPrefs.has('autoconnect')).toBe(false)
    expect(existsSync(legacyPath())).toBe(true)
  })
})
