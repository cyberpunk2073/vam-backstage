import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { mkTempVamDir, openTestDatabase } from '../../../test/fixtures/index.js'
import { closeDatabase, getDb } from '../db.js'
import { runLocalScan } from '../scanner/local.js'
import { buildFromDb, getAllExtractedLocalItems } from '../store.js'
import { reconcileExtractedLifecycle, deleteOrphanedExtractedPresets } from './extracted-reconcile.js'

// End-to-end against a real temp VaM dir + DB: a scene-source package owns a
// loose extracted appearance preset (name derived by the store's ownership
// inversion), and we drive the preset's on-disk enabled/disabled state off the
// package's storage_state — the sync that used to happen only for app-driven
// toggles, now for external changes too.

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

const PKG = 'Author.Pkg.2.var'
const SCENE = 'Saves/scene/Demo.json'
// Matches extractedPresetBasename({ creator: 'Author', internalPath: SCENE, atomId: 'Person', singleAtom: true }).
const PRESET = 'Custom/Atom/Person/Appearance/extracted/Preset_Author - Demo.vap'

function seedScenePackage(filename, { storageState = 'enabled' } = {}) {
  const db = getDb()
  db.prepare(
    `INSERT INTO packages (filename, creator, package_name, version, size_bytes, file_mtime, is_direct, storage_state, dep_refs)
     VALUES (?, 'Author', 'Author.Pkg', '2', 0, 0, 1, ?, '[]')`,
  ).run(filename, storageState)
  db.prepare(
    `INSERT INTO contents (package_filename, internal_path, display_name, type, thumbnail_path, person_atom_ids, file_mtime, size_bytes)
       VALUES (?, ?, 'Demo', 'scene', NULL, '["Person"]', 0, 0)`,
  ).run(filename, SCENE)
}

function setPackageState(filename, storageState) {
  getDb().prepare('UPDATE packages SET storage_state = ? WHERE filename = ?').run(storageState, filename)
}

function tombstonePackage(filename) {
  getDb().prepare('UPDATE packages SET missing_since = unixepoch() WHERE filename = ?').run(filename)
}

async function writePreset(rel) {
  const abs = join(tmp.vamDir, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, '{}')
}

/** After a reconcile renames the file, mirror the caller's rescan so the loose
 *  row's internal_path tracks the new on-disk name for the next transition. */
async function resync() {
  await runLocalScan(tmp.vamDir)
  buildFromDb()
}

const live = () => existsSync(join(tmp.vamDir, PRESET))
const disabled = () => existsSync(join(tmp.vamDir, PRESET + '.disabled'))

describe('reconcileExtractedLifecycle', () => {
  it('tracks the preset and its owning package after a scan', async () => {
    seedScenePackage(PKG)
    await writePreset(PRESET)
    await resync()
    const items = getAllExtractedLocalItems()
    expect(items).toHaveLength(1)
    expect(items[0].extractedCandidates).toContain(PKG)
  })

  it('disables the preset when its only owner goes inactive, re-enables when active again', async () => {
    seedScenePackage(PKG)
    await writePreset(PRESET)
    await resync()

    setPackageState(PKG, 'disabled')
    buildFromDb()
    const r1 = await reconcileExtractedLifecycle({ vamDir: tmp.vamDir })
    expect(r1.changed).toBe(1)
    expect(live()).toBe(false)
    expect(disabled()).toBe(true)

    await resync() // loose row now points at the .disabled name

    setPackageState(PKG, 'enabled')
    buildFromDb()
    const r2 = await reconcileExtractedLifecycle({ vamDir: tmp.vamDir })
    expect(r2.changed).toBe(1)
    expect(live()).toBe(true)
    expect(disabled()).toBe(false)
  })

  it('is a no-op when presets already match owner state', async () => {
    seedScenePackage(PKG)
    await writePreset(PRESET)
    await resync()
    const r = await reconcileExtractedLifecycle({ vamDir: tmp.vamDir })
    expect(r.changed).toBe(0)
    expect(live()).toBe(true)
  })

  it('treats an offloaded owner as inactive (disables the preset)', async () => {
    seedScenePackage(PKG, { storageState: 'offloaded' })
    await writePreset(PRESET)
    await resync()
    const r = await reconcileExtractedLifecycle({ vamDir: tmp.vamDir })
    expect(r.changed).toBe(1)
    expect(disabled()).toBe(true)
  })

  it('targeted mode only reconciles presets owned by the given filenames', async () => {
    seedScenePackage(PKG)
    await writePreset(PRESET)
    await resync()
    setPackageState(PKG, 'disabled')
    buildFromDb()

    const none = await reconcileExtractedLifecycle({ vamDir: tmp.vamDir, filenames: new Set(['Other.Pkg.1.var']) })
    expect(none.changed).toBe(0)
    expect(live()).toBe(true)

    const hit = await reconcileExtractedLifecycle({ vamDir: tmp.vamDir, filenames: new Set([PKG]) })
    expect(hit.changed).toBe(1)
    expect(disabled()).toBe(true)
  })
})

describe('orphaned presets (external removal)', () => {
  it('disables (not deletes) an orphaned preset via full sweep, then deletes on forget-cleanup', async () => {
    seedScenePackage(PKG)
    await writePreset(PRESET)
    await resync()

    // Owner removed externally -> tombstoned out of the store.
    tombstonePackage(PKG)
    buildFromDb()
    expect(getAllExtractedLocalItems()[0].extractedCandidates).toEqual([])

    const r = await reconcileExtractedLifecycle({ vamDir: tmp.vamDir })
    expect(r.changed).toBe(1)
    expect(disabled()).toBe(true) // disabled, preserved (removal is reversible)
    expect(live()).toBe(false)

    await resync()

    const del = await deleteOrphanedExtractedPresets({ vamDir: tmp.vamDir })
    expect(del.removed).toBe(1)
    expect(disabled()).toBe(false)
    expect(live()).toBe(false)
  })
})
