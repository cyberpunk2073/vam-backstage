import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkTempVamDir, openTestDatabase } from '../../test/fixtures/index.js'
import {
  closeDatabase,
  setSetting,
  insertLibraryDir,
  countPackagesInLibraryDir,
  deleteLibraryDir,
  deleteLibraryDirWithPackages,
  getLibraryDir,
} from './db.js'

let tmp
let db

beforeEach(async () => {
  tmp = await mkTempVamDir()
  db = await openTestDatabase(tmp.dbPath)
  setSetting('vam_dir', tmp.vamDir)
})

afterEach(async () => {
  closeDatabase()
  if (tmp) await tmp.cleanup()
  delete process.env.VAM_DB_PATH
})

/** Seed a package in `dirId` plus a content row and a label link that cascade-delete. */
function seedPackage(filename, dirId) {
  db.prepare(
    `INSERT INTO packages (filename, creator, package_name, version, size_bytes, file_mtime, storage_state, library_dir_id)
     VALUES (?, 'Creator', 'Pkg', '1', 100, 0, 'offloaded', ?)`,
  ).run(filename, dirId)
  db.prepare(
    `INSERT INTO contents (package_filename, internal_path, display_name, type) VALUES (?, ?, ?, 'scene')`,
  ).run(filename, 'Saves/scene/x.json', 'x')
  const labelId = db.prepare(`INSERT INTO labels (name) VALUES (?)`).run(`lbl-${filename}`).lastInsertRowid
  db.prepare(`INSERT INTO label_packages (label_id, package_filename) VALUES (?, ?)`).run(labelId, filename)
}

describe('deleteLibraryDirWithPackages — force un-register', () => {
  it('deletes package rows (cascading contents + label links) and the dir, keeping other dirs intact', () => {
    const dirId = insertLibraryDir('/some/offload')
    const otherId = insertLibraryDir('/other/offload')
    seedPackage('Creator.Pkg.1.var', dirId)
    seedPackage('Creator.Pkg.2.var', dirId)
    seedPackage('Creator.Other.1.var', otherId)

    expect(countPackagesInLibraryDir(dirId).n).toBe(2)

    const forgotten = deleteLibraryDirWithPackages(dirId)

    expect(forgotten).toBe(2)
    expect(getLibraryDir(dirId)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS n FROM packages WHERE library_dir_id = ?').get(dirId).n).toBe(0)
    // Cascades fired.
    expect(db.prepare('SELECT COUNT(*) AS n FROM contents').get().n).toBe(1) // only the other dir's content
    expect(db.prepare('SELECT COUNT(*) AS n FROM label_packages').get().n).toBe(1)
    // Untouched dir + its package survive.
    expect(getLibraryDir(otherId)).toBeTruthy()
    expect(countPackagesInLibraryDir(otherId).n).toBe(1)
  })

  it('returns 0 and just removes an empty dir', () => {
    const dirId = insertLibraryDir('/empty/offload')
    expect(deleteLibraryDirWithPackages(dirId)).toBe(0)
    expect(getLibraryDir(dirId)).toBeUndefined()
  })

  it('plain deleteLibraryDir is blocked by the FK while packages remain', () => {
    const dirId = insertLibraryDir('/guarded/offload')
    seedPackage('Creator.Pkg.1.var', dirId)
    expect(() => deleteLibraryDir(dirId)).toThrow()
    expect(getLibraryDir(dirId)).toBeTruthy()
  })
})
