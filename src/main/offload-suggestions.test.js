import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { mkTempVamDir, openTestDatabase } from '../../test/fixtures/index.js'
import { closeDatabase, setSetting, insertLibraryDir } from './db.js'
import { refreshLibraryDirs } from './library-dirs.js'
import { detectOffloadSuggestions, matchOffloadToolId } from './offload-suggestions.js'

const BA_REL = ['Saves', 'PluginData', 'JayJayWon', 'BrowserAssist', 'OffloadedVARs']

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

describe('detectOffloadSuggestions', () => {
  it('returns nothing when no tool folders exist', async () => {
    expect(await detectOffloadSuggestions(tmp.vamDir)).toEqual([])
  })

  it('returns nothing when vamDir is missing', async () => {
    expect(await detectOffloadSuggestions(null)).toEqual([])
    expect(await detectOffloadSuggestions('')).toEqual([])
  })

  it('suggests BrowserAssist OffloadedVARs when it exists, with a var count', async () => {
    const dir = join(tmp.vamDir, ...BA_REL)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'Author.Pkg.1.var'), 'x')
    await writeFile(join(dir, 'Author.Pkg.2.var'), 'x')
    await writeFile(join(dir, 'notes.txt'), 'x')

    const out = await detectOffloadSuggestions(tmp.vamDir)
    expect(out).toEqual([{ id: 'browser-assist', label: 'BrowserAssist', path: dir, varCount: 2 }])
  })

  it('suggests var_browser AllPackages when it exists', async () => {
    const dir = join(tmp.vamDir, 'AllPackages')
    await mkdir(dir, { recursive: true })

    const out = await detectOffloadSuggestions(tmp.vamDir)
    expect(out).toEqual([{ id: 'var-browser', label: 'var_browser', path: dir, varCount: 0 }])
  })

  it('counts .var files nested in subfolders (preserved structure)', async () => {
    const dir = join(tmp.vamDir, 'AllPackages')
    await mkdir(join(dir, 'Author'), { recursive: true })
    await writeFile(join(dir, 'Author', 'Author.Pkg.1.var'), 'x')

    const out = await detectOffloadSuggestions(tmp.vamDir)
    expect(out[0].varCount).toBe(1)
  })

  it('does not suggest a folder that is already registered', async () => {
    const dir = join(tmp.vamDir, 'AllPackages')
    await mkdir(dir, { recursive: true })
    insertLibraryDir(dir)
    refreshLibraryDirs()

    expect(await detectOffloadSuggestions(tmp.vamDir)).toEqual([])
  })

  it('detects both tools independently', async () => {
    await mkdir(join(tmp.vamDir, ...BA_REL), { recursive: true })
    await mkdir(join(tmp.vamDir, 'AllPackages'), { recursive: true })

    const ids = (await detectOffloadSuggestions(tmp.vamDir)).map((s) => s.id).sort()
    expect(ids).toEqual(['browser-assist', 'var-browser'])
  })
})

describe('matchOffloadToolId', () => {
  it('matches a known tool default folder to its id', () => {
    expect(matchOffloadToolId(join(tmp.vamDir, 'AllPackages'), tmp.vamDir)).toBe('var-browser')
    expect(matchOffloadToolId(join(tmp.vamDir, ...BA_REL), tmp.vamDir)).toBe('browser-assist')
  })

  it('ignores trailing separators', () => {
    expect(matchOffloadToolId(join(tmp.vamDir, 'AllPackages') + '/', tmp.vamDir)).toBe('var-browser')
  })

  it('returns null for an unrelated folder or missing input', () => {
    expect(matchOffloadToolId(join(tmp.vamDir, 'SomethingElse'), tmp.vamDir)).toBeNull()
    expect(matchOffloadToolId(null, tmp.vamDir)).toBeNull()
    expect(matchOffloadToolId(join(tmp.vamDir, 'AllPackages'), null)).toBeNull()
  })
})
