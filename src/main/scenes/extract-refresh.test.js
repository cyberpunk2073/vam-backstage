import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { mkTempVamDir, openTestDatabase } from '../../../test/fixtures/index.js'
import { closeDatabase, getDb } from '../db.js'
import { collectExtractRefreshItems } from './extract-refresh.js'

// The update-refresh gate: only regenerate presets the user already has, and
// only for a strictly-newer install. Exercised against a real temp VaM dir + DB
// (getPersonAtomIds reads the `contents` table; existence is a real fs check).

let tmp

beforeEach(async () => {
  tmp = await mkTempVamDir()
  await openTestDatabase(tmp.dbPath)
})

afterEach(async () => {
  closeDatabase()
  if (tmp) await tmp.cleanup()
  delete process.env.VAM_DB_PATH
})

const SCENE = 'Saves/scene/Demo.json'
const APPEARANCE_TARGET = 'Custom/Atom/Person/Appearance/extracted/Preset_Author - Demo.vap'

function seedSceneRow(filename) {
  const db = getDb()
  // `contents.package_filename` is a FK into `packages`.
  db.prepare(
    `INSERT INTO packages (filename, creator, package_name, version, size_bytes, file_mtime, is_direct, storage_state, dep_refs)
     VALUES (?, 'Author', 'Author.Pkg', '2', 0, 0, 1, 'enabled', '[]')`,
  ).run(filename)
  db.prepare(
    `INSERT INTO contents (package_filename, internal_path, display_name, type, thumbnail_path, person_atom_ids, file_mtime, size_bytes)
       VALUES (?, ?, 'Demo', 'scene', NULL, '["Person"]', 0, 0)`,
  ).run(filename, SCENE)
}

async function writeTarget(rel) {
  const abs = join(tmp.vamDir, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, '{}')
}

const args = (over = {}) => ({
  vamDir: tmp.vamDir,
  filename: 'Author.Pkg.2.var',
  donorFilename: 'Author.Pkg.1.var',
  contentItems: [{ type: 'scene', internalPath: SCENE }],
  ...over,
})

describe('collectExtractRefreshItems', () => {
  it('collects a scene whose appearance target already exists (strict upgrade)', async () => {
    seedSceneRow('Author.Pkg.2.var')
    await writeTarget(APPEARANCE_TARGET)
    const res = collectExtractRefreshItems(args())
    expect(res).not.toBeNull()
    expect(res.appearance).toEqual([{ packageFilename: 'Author.Pkg.2.var', internalPath: SCENE }])
    expect(res.outfit).toEqual([]) // no outfit target on disk → not regenerated
  })

  it('also counts a disabled target (`.vap.disabled`) as existing', async () => {
    seedSceneRow('Author.Pkg.2.var')
    await writeTarget(APPEARANCE_TARGET + '.disabled')
    const res = collectExtractRefreshItems(args())
    expect(res?.appearance).toHaveLength(1)
  })

  it('returns null when the new version is not strictly newer (downgrade / equal)', async () => {
    seedSceneRow('Author.Pkg.2.var')
    await writeTarget(APPEARANCE_TARGET)
    expect(collectExtractRefreshItems(args({ donorFilename: 'Author.Pkg.3.var' }))).toBeNull()
    expect(collectExtractRefreshItems(args({ donorFilename: 'Author.Pkg.2.var' }))).toBeNull()
  })

  it('returns null when no target exists on disk (never creates new presets)', async () => {
    seedSceneRow('Author.Pkg.2.var')
    expect(collectExtractRefreshItems(args())).toBeNull()
  })

  it('returns null when the scene has no cached Person atom ids', async () => {
    // No DB row → getPersonAtomIds finds nothing → skipped.
    await writeTarget(APPEARANCE_TARGET)
    expect(collectExtractRefreshItems(args())).toBeNull()
  })
})
