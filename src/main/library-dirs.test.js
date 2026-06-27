import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdir } from 'fs/promises'
import { mkTempVamDir, openTestDatabase } from '../../test/fixtures/index.js'
import { closeDatabase, setSetting, insertLibraryDir } from './db.js'
import { validateNewAuxDirPath, refreshLibraryDirs, pkgVarPath, libraryRelSubpath } from './library-dirs.js'
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

// A `.var` may live in a subfolder of its library dir. `libraryRelSubpath`
// derives the stored subpath from a discovered on-disk path; `pkgVarPath`
// joins it back so nested packages resolve for every reader/writer/deleter.
describe('libraryRelSubpath', () => {
  const root = join('/lib', 'AddonPackages')

  it('returns empty string for a file at the library root', () => {
    expect(libraryRelSubpath(root, join(root, 'Author.Pkg.1.var'))).toBe('')
  })

  it('returns the single parent folder for a one-level-deep file', () => {
    expect(libraryRelSubpath(root, join(root, 'Author', 'Author.Pkg.1.var'))).toBe('Author')
  })

  it('returns a POSIX-joined path for a deeply nested file', () => {
    expect(libraryRelSubpath(root, join(root, 'Author', 'Scenes', 'Author.Pkg.1.var'))).toBe('Author/Scenes')
  })

  it('falls back to empty string when the file is not under the library dir', () => {
    expect(libraryRelSubpath(root, join('/elsewhere', 'Author.Pkg.1.var'))).toBe('')
    expect(libraryRelSubpath('', join(root, 'Author.Pkg.1.var'))).toBe('')
  })
})

describe('pkgVarPath — nested subpath resolution', () => {
  it('joins subpath for an enabled package in main', () => {
    const pkg = {
      filename: 'Author.Pkg.1.var',
      storage_state: 'enabled',
      library_dir_id: null,
      subpath: 'Author/Scenes',
    }
    expect(pkgVarPath(pkg)).toBe(join(tmp.addonPackages, 'Author', 'Scenes', 'Author.Pkg.1.var'))
  })

  it('appends .disabled at the nested location for a disabled package', () => {
    const pkg = { filename: 'Author.Pkg.1.var', storage_state: 'disabled', library_dir_id: null, subpath: 'Author' }
    expect(pkgVarPath(pkg)).toBe(join(tmp.addonPackages, 'Author', 'Author.Pkg.1.var.disabled'))
  })

  it('resolves nested subpath inside an aux/offload dir', () => {
    const auxPath = join(tmp.vamDir, '..', 'auxlib')
    const auxId = insertLibraryDir(auxPath)
    refreshLibraryDirs()
    const pkg = { filename: 'Author.Pkg.1.var', storage_state: 'offloaded', library_dir_id: auxId, subpath: 'Sub' }
    expect(pkgVarPath(pkg)).toBe(join(auxPath, 'Sub', 'Author.Pkg.1.var'))
  })

  it('still works for a root-level package (empty subpath)', () => {
    const pkg = { filename: 'Author.Pkg.1.var', storage_state: 'enabled', library_dir_id: null, subpath: '' }
    expect(pkgVarPath(pkg)).toBe(join(tmp.addonPackages, 'Author.Pkg.1.var'))
  })
})
