import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdir } from 'fs/promises'
import { mkTempVamDir, openTestDatabase } from '../../test/fixtures/index.js'
import { closeDatabase, setSetting } from './db.js'
import { validateNewAuxDirPath, refreshLibraryDirs } from './library-dirs.js'
import { ADDON_PACKAGES_FILE_PREFS } from '@shared/paths.js'

// Domain separation: an offload (aux) library dir may live anywhere *except*
// inside (or containing) a monitored loose-content dir or the prefs tree. The
// motivating case is JayJayWon BrowserAssist, which offloads vars to
// `Saves/PluginData/.../OffloadedVARs` — outside `Saves/scene` / `Saves/Person`,
// so it's allowed.
const BROWSER_ASSIST_REL = ['Saves', 'PluginData', 'JayJayWon', 'BrowserAssist', 'OffloadedVARs']

let tmp

beforeEach(async () => {
  tmp = await mkTempVamDir()
  await openTestDatabase(tmp.dbPath)
  setSetting('vam_dir', tmp.vamDir)
  refreshLibraryDirs()
})

afterEach(async () => {
  closeDatabase()
  if (tmp) await tmp.cleanup()
  delete process.env.VAM_DB_PATH
})

describe('validateNewAuxDirPath — domain separation from monitored content dirs', () => {
  it('allows BrowserAssist OffloadedVARs under Saves/PluginData', async () => {
    const browserAssist = join(tmp.vamDir, ...BROWSER_ASSIST_REL)
    await mkdir(browserAssist, { recursive: true })
    expect(await validateNewAuxDirPath(browserAssist)).toBeNull()
  })

  it('allows an arbitrary non-monitored subdir of Saves', async () => {
    const dir = join(tmp.vamDir, 'Saves', 'PluginData', 'SomeTool')
    await mkdir(dir, { recursive: true })
    expect(await validateNewAuxDirPath(dir)).toBeNull()
  })

  it('rejects a monitored dir itself (Saves/scene)', async () => {
    const dir = join(tmp.vamDir, 'Saves', 'scene')
    await mkdir(dir, { recursive: true })
    expect(await validateNewAuxDirPath(dir)).toMatch(/VaM-managed directory/)
  })

  it('rejects a monitored dir itself (Saves/Person)', async () => {
    const dir = join(tmp.vamDir, 'Saves', 'Person')
    await mkdir(dir, { recursive: true })
    expect(await validateNewAuxDirPath(dir)).toMatch(/VaM-managed directory/)
  })

  it('rejects the whole Custom tree (monitored)', async () => {
    expect(await validateNewAuxDirPath(tmp.customDir)).toMatch(/VaM-managed directory/)
  })

  it('rejects a subdir nested inside a monitored dir', async () => {
    const dir = join(tmp.vamDir, 'Saves', 'scene', 'Offload')
    await mkdir(dir, { recursive: true })
    expect(await validateNewAuxDirPath(dir)).toMatch(/VaM-managed directory/)
  })

  it('rejects the bare Saves root (it contains monitored Saves/scene)', async () => {
    expect(await validateNewAuxDirPath(tmp.savesDir)).toMatch(/VaM-managed directory/)
  })

  it('rejects the VaM dir itself (contains every managed dir)', async () => {
    expect(await validateNewAuxDirPath(tmp.vamDir)).toBeTruthy()
  })

  it('rejects a subdir of the prefs sidecar tree', async () => {
    const dir = join(tmp.vamDir, ADDON_PACKAGES_FILE_PREFS, 'SomeStem')
    await mkdir(dir, { recursive: true })
    expect(await validateNewAuxDirPath(dir)).toMatch(/VaM-managed directory/)
  })

  it('still rejects a subdir of the main AddonPackages directory', async () => {
    const dir = join(tmp.addonPackages, 'Nested')
    await mkdir(dir, { recursive: true })
    expect(await validateNewAuxDirPath(dir)).toMatch(/main AddonPackages/)
  })
})
