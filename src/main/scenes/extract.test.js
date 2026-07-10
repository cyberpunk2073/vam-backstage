import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { stat, writeFile, mkdir, utimes } from 'fs/promises'
import { join } from 'path'
import { mkTempVamDir, buildVar, placeVar, openTestDatabase } from '../../../test/fixtures/index.js'
import { closeDatabase, getDb, setSetting } from '../db.js'
import { buildFromDb } from '../store.js'
import { runExtract } from './extract.js'

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

const SCENE = 'Saves/scene/Demo.json'
const SCENE_JSON = JSON.stringify({
  atoms: [{ type: 'Person', id: 'Person', storables: [{ id: 'geometry', morphs: [] }] }],
})
const TARGET = 'Custom/Atom/Person/Appearance/extracted/Preset_Author - Demo.vap'
const PACKAGE_MTIME = 1_700_000_000.25

function seedPackage(db, filename, { fileMtime = PACKAGE_MTIME } = {}) {
  db.prepare(
    `INSERT INTO packages (filename, creator, package_name, version, size_bytes, file_mtime, is_direct, storage_state, dep_refs)
     VALUES (?, 'Author', 'Author.Pkg', '1', 100, ?, 1, 'enabled', '[]')`,
  ).run(filename, fileMtime)
}

function seedScene(db, filename) {
  db.prepare(
    `INSERT INTO contents (package_filename, internal_path, display_name, type, person_atom_ids, file_mtime, size_bytes)
     VALUES (?, ?, 'Demo', 'scene', '["Person"]', 0, 0)`,
  ).run(filename, SCENE)
}

describe('runExtract — extracted preset mtime', () => {
  it('stamps loose presets with the source package file_mtime', async () => {
    const filename = 'Author.Pkg.1.var'
    const db = getDb()
    seedPackage(db, filename)
    seedScene(db, filename)
    buildFromDb()

    const buf = await buildVar({ files: { [SCENE]: SCENE_JSON } })
    await placeVar(tmp.addonPackages, filename, buf)

    const result = await runExtract({
      packageFilename: filename,
      internalPath: SCENE,
      kind: 'appearance',
    })
    expect(result.written).toHaveLength(1)

    const s = await stat(join(tmp.vamDir, TARGET))
    expect(Math.abs(s.mtimeMs / 1000 - PACKAGE_MTIME)).toBeLessThan(0.01)
  })

  it('stamps loose presets from local legacy looks with the source file mtime', async () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO contents (package_filename, internal_path, display_name, type, person_atom_ids, file_mtime, size_bytes)
       VALUES ('__local__', ?, 'Demo', 'legacyLook', '["Person"]', 0, 0)`,
    ).run(SCENE)

    const sceneAbs = join(tmp.vamDir, SCENE)
    await mkdir(join(sceneAbs, '..'), { recursive: true })
    await writeFile(sceneAbs, SCENE_JSON)
    const sourceMtime = new Date(1_600_000_000.5 * 1000)
    await utimes(sceneAbs, sourceMtime, sourceMtime)
    buildFromDb()

    const result = await runExtract({
      packageFilename: '__local__',
      internalPath: SCENE,
      kind: 'appearance',
    })
    expect(result.written).toHaveLength(1)

    const s = await stat(join(tmp.vamDir, 'Custom/Atom/Person/Appearance/extracted/Preset_!local - Demo.vap'))
    expect(Math.abs(s.mtimeMs / 1000 - 1_600_000_000.5)).toBeLessThan(0.01)
  })
})
