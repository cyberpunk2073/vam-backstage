import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkTempVamDir, openTestDatabase } from '../../../test/fixtures/index.js'
import { closeDatabase, getDb, setSetting } from '../db.js'
import { buildFromDb } from '../store.js'
import { resolveExtractedSource } from './extract.js'

// `resolveExtractedSource` inverts the extracted-preset naming to rediscover the
// source scene + atom + kind, powering the "Re-extract" that lives on the
// extracted item itself. It reads the built store (`getContentByPackage`), so
// each test seeds rows, runs `buildFromDb`, then resolves.
//
// ⚠ NODE_MODULE_VERSION mismatch? Use `npm test` (Electron-as-Node).

let tmp

beforeEach(async () => {
  tmp = await mkTempVamDir()
  await openTestDatabase(tmp.dbPath)
  setSetting('vam_dir', tmp.vamDir)
})

afterEach(async () => {
  closeDatabase()
  if (tmp) await tmp.cleanup()
  delete process.env.VAM_DB_PATH
})

const APP_DIR = 'Custom/Atom/Person/Appearance/extracted'
const CLO_DIR = 'Custom/Atom/Person/Clothing/extracted'

function seedPackage(db, filename, { version = '1' } = {}) {
  db.prepare(
    `INSERT INTO packages (filename, creator, package_name, version, size_bytes, file_mtime, is_direct, storage_state, dep_refs)
     VALUES (?, 'Author', 'Author.Pkg', ?, 100, 0, 1, 'enabled', '[]')`,
  ).run(filename, version)
}

function seedScene(db, filename, { scene = 'Demo', atomIds = '["Person"]', type = 'scene' } = {}) {
  db.prepare(
    `INSERT INTO contents (package_filename, internal_path, display_name, type, person_atom_ids, file_mtime, size_bytes)
     VALUES (?, ?, ?, ?, ?, 0, 0)`,
  ).run(filename, `Saves/scene/${scene}.json`, scene, type, atomIds)
}

describe('resolveExtractedSource', () => {
  it('maps an appearance preset back to its source scene + atom (kind from folder)', async () => {
    const db = getDb()
    seedPackage(db, 'Author.Pkg.1.var')
    seedScene(db, 'Author.Pkg.1.var')
    buildFromDb()

    const res = resolveExtractedSource({
      packageFilename: 'Author.Pkg.1.var',
      presetInternalPath: `${APP_DIR}/Preset_Author - Demo.vap`,
    })
    expect(res).toEqual({
      packageFilename: 'Author.Pkg.1.var',
      internalPath: 'Saves/scene/Demo.json',
      atomId: 'Person',
      kind: 'appearance',
      sourceType: 'scene',
    })
  })

  it('resolves the outfit kind from the Clothing folder', async () => {
    const db = getDb()
    seedPackage(db, 'Author.Pkg.1.var')
    seedScene(db, 'Author.Pkg.1.var')
    buildFromDb()

    const res = resolveExtractedSource({
      packageFilename: 'Author.Pkg.1.var',
      presetInternalPath: `${CLO_DIR}/Preset_Author - Demo.vap`,
    })
    expect(res?.kind).toBe('outfit')
    expect(res?.internalPath).toBe('Saves/scene/Demo.json')
  })

  it('matches the atom suffix for a multi-atom scene', async () => {
    const db = getDb()
    seedPackage(db, 'Author.Pkg.1.var')
    seedScene(db, 'Author.Pkg.1.var', { atomIds: '["Person","Person#2"]' })
    buildFromDb()

    const res = resolveExtractedSource({
      packageFilename: 'Author.Pkg.1.var',
      presetInternalPath: `${APP_DIR}/Preset_Author - Demo_Person2.vap`,
    })
    expect(res?.atomId).toBe('Person#2')
  })

  it('reports a legacy-look source type (so the UI shows "Re-convert")', async () => {
    const db = getDb()
    seedPackage(db, 'Author.Pkg.1.var')
    seedScene(db, 'Author.Pkg.1.var', { type: 'legacyLook' })
    buildFromDb()

    const res = resolveExtractedSource({
      packageFilename: 'Author.Pkg.1.var',
      presetInternalPath: `${APP_DIR}/Preset_Author - Demo.vap`,
    })
    expect(res?.sourceType).toBe('legacyLook')
    expect(res?.kind).toBe('appearance')
  })

  it('never maps an outfit to a legacy look (looks produce no outfit preset)', async () => {
    const db = getDb()
    seedPackage(db, 'Author.Pkg.1.var')
    seedScene(db, 'Author.Pkg.1.var', { type: 'legacyLook' })
    buildFromDb()

    expect(
      resolveExtractedSource({
        packageFilename: 'Author.Pkg.1.var',
        presetInternalPath: `${CLO_DIR}/Preset_Author - Demo.vap`,
      }),
    ).toBeNull()
  })

  it('resolves through a trailing `.disabled` marker', async () => {
    const db = getDb()
    seedPackage(db, 'Author.Pkg.1.var')
    seedScene(db, 'Author.Pkg.1.var')
    buildFromDb()

    const res = resolveExtractedSource({
      packageFilename: 'Author.Pkg.1.var',
      presetInternalPath: `${APP_DIR}/Preset_Author - Demo.vap.disabled`,
    })
    expect(res?.internalPath).toBe('Saves/scene/Demo.json')
  })

  it('returns null for a non-extracted path or an unmatched basename', async () => {
    const db = getDb()
    seedPackage(db, 'Author.Pkg.1.var')
    seedScene(db, 'Author.Pkg.1.var')
    buildFromDb()

    expect(
      resolveExtractedSource({
        packageFilename: 'Author.Pkg.1.var',
        presetInternalPath: 'Custom/other/Preset_Author - Demo.vap',
      }),
    ).toBeNull()
    expect(
      resolveExtractedSource({
        packageFilename: 'Author.Pkg.1.var',
        presetInternalPath: `${APP_DIR}/Preset_Author - Nope.vap`,
      }),
    ).toBeNull()
  })
})
