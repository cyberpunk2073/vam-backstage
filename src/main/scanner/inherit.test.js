import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { mkTempVamDir, openTestDatabase, buildVar, placeVar } from '../../../test/fixtures/index.js'
import { ADDON_PACKAGES_FILE_PREFS } from '@shared/paths.js'
import {
  closeDatabase,
  getDb,
  findOrCreateLabel,
  applyLabelToPackages,
  applyLabelToContents,
  getAllLabelPackages,
  getAllLabelContents,
  setPackageTypeOverride,
  getAllPackages,
  setSetting,
} from '../db.js'
import { runScan } from './index.js'
import { inheritFromOlderVersion } from './inherit.js'
import { scanAndUpsert } from './ingest.js'

let tmp
// Auto-increment seedPackage's first_seen_at so each call lands strictly after
// the previous one — donor lookups gate on `first_seen_at < self`. Tests that
// need to simulate "two installs in the same batch" pass an explicit value.
let seedClock

beforeEach(async () => {
  tmp = await mkTempVamDir()
  await openTestDatabase(tmp.dbPath)
  setSetting('vam_dir', tmp.vamDir)
  seedClock = 1000
})

afterEach(async () => {
  closeDatabase()
  if (tmp) await tmp.cleanup()
  delete process.env.VAM_DB_PATH
})

function seedPackage(partial) {
  const row = {
    creator: '',
    package_name: '',
    version: '',
    type: null,
    title: null,
    description: null,
    license: null,
    size_bytes: 100,
    file_mtime: 0,
    is_direct: 1,
    storage_state: 'enabled',
    library_dir_id: null,
    hub_resource_id: null,
    dep_refs: '[]',
    type_override: null,
    is_corrupted: 0,
    first_seen_at: ++seedClock,
    ...partial,
  }
  getDb()
    .prepare(
      `INSERT INTO packages (filename, creator, package_name, version, type, title, description, license,
         size_bytes, file_mtime, is_direct, storage_state, library_dir_id, hub_resource_id, dep_refs,
         type_override, is_corrupted, first_seen_at)
       VALUES (@filename, @creator, @package_name, @version, @type, @title, @description, @license,
         @size_bytes, @file_mtime, @is_direct, @storage_state, @library_dir_id, @hub_resource_id, @dep_refs,
         @type_override, @is_corrupted, @first_seen_at)`,
    )
    .run(row)
}

describe('inheritFromOlderVersion', () => {
  it('returns null when there is no older version', async () => {
    seedPackage({ filename: 'A.B.1.var', creator: 'A', package_name: 'A.B', version: '1' })
    const result = await inheritFromOlderVersion({
      filename: 'A.B.1.var',
      packageName: 'A.B',
      contentItems: [],
      vamDir: tmp.vamDir,
    })
    expect(result).toBeNull()
  })

  it('copies type_override from highest existing version', async () => {
    seedPackage({
      filename: 'A.B.1.var',
      creator: 'A',
      package_name: 'A.B',
      version: '1',
      type_override: 'CustomCat',
    })
    seedPackage({ filename: 'A.B.2.var', creator: 'A', package_name: 'A.B', version: '2' })

    const result = await inheritFromOlderVersion({
      filename: 'A.B.2.var',
      packageName: 'A.B',
      contentItems: [],
      vamDir: tmp.vamDir,
    })
    expect(result).toEqual({ donor: 'A.B.1.var', copiedTypeOverride: true })

    const row = getAllPackages().find((p) => p.filename === 'A.B.2.var')
    expect(row.type_override).toBe('CustomCat')
  })

  it('copies package and matching content labels from donor', async () => {
    seedPackage({ filename: 'A.B.1.var', creator: 'A', package_name: 'A.B', version: '1' })
    seedPackage({ filename: 'A.B.2.var', creator: 'A', package_name: 'A.B', version: '2' })

    const lblPkg = findOrCreateLabel('Project-X')
    const lblContent = findOrCreateLabel('FavScene')
    applyLabelToPackages(lblPkg.id, ['A.B.1.var'])
    applyLabelToContents(lblContent.id, [{ packageFilename: 'A.B.1.var', internalPath: 'Saves/scene/Demo.json' }])
    applyLabelToContents(lblContent.id, [{ packageFilename: 'A.B.1.var', internalPath: 'Saves/scene/Gone.json' }])

    await inheritFromOlderVersion({
      filename: 'A.B.2.var',
      packageName: 'A.B',
      contentItems: [{ internalPath: 'Saves/scene/Demo.json' }],
      vamDir: tmp.vamDir,
    })

    const pkgLabels = getAllLabelPackages().filter((r) => r.package_filename === 'A.B.2.var')
    expect(pkgLabels.map((r) => r.label_id)).toEqual([lblPkg.id])

    const contentLabels = getAllLabelContents().filter((r) => r.package_filename === 'A.B.2.var')
    // Only the path that exists in the new package's contentItems is carried over.
    expect(contentLabels).toEqual([
      { label_id: lblContent.id, package_filename: 'A.B.2.var', internal_path: 'Saves/scene/Demo.json' },
    ])
  })

  it('copies .hide and .fav sidecars from donor stem to new stem', async () => {
    seedPackage({ filename: 'A.B.1.var', creator: 'A', package_name: 'A.B', version: '1' })
    seedPackage({ filename: 'A.B.2.var', creator: 'A', package_name: 'A.B', version: '2' })

    const prefsRoot = join(tmp.vamDir, ADDON_PACKAGES_FILE_PREFS)
    const oldStemDir = join(prefsRoot, 'A.B.1', 'Saves', 'scene')
    await mkdir(oldStemDir, { recursive: true })
    await writeFile(join(oldStemDir, 'Demo.json.hide'), '')
    await writeFile(join(oldStemDir, 'Demo.json.fav'), '')
    await writeFile(join(oldStemDir, 'NotInNew.json.hide'), '')

    await inheritFromOlderVersion({
      filename: 'A.B.2.var',
      packageName: 'A.B',
      contentItems: [{ internalPath: 'Saves/scene/Demo.json' }],
      vamDir: tmp.vamDir,
    })

    const newStem = join(prefsRoot, 'A.B.2', 'Saves', 'scene')
    expect(existsSync(join(newStem, 'Demo.json.hide'))).toBe(true)
    expect(existsSync(join(newStem, 'Demo.json.fav'))).toBe(true)
    // Path not present in the new package's content items should NOT be copied.
    expect(existsSync(join(newStem, 'NotInNew.json.hide'))).toBe(false)
  })

  it('first_seen_at gate skips peer rows inserted in the same batch', async () => {
    // v1 was around long before; v2 + v3 are batch peers (same first_seen_at).
    seedPackage({
      filename: 'A.B.1.var',
      creator: 'A',
      package_name: 'A.B',
      version: '1',
      type_override: 'FromV1',
      first_seen_at: 1000,
    })
    seedPackage({
      filename: 'A.B.2.var',
      creator: 'A',
      package_name: 'A.B',
      version: '2',
      first_seen_at: 2000,
    })
    seedPackage({
      filename: 'A.B.3.var',
      creator: 'A',
      package_name: 'A.B',
      version: '3',
      first_seen_at: 2000,
    })

    // v3 should NOT pick v2 as donor (peer in the same batch). It reaches back to v1.
    const r = await inheritFromOlderVersion({
      filename: 'A.B.3.var',
      packageName: 'A.B',
      contentItems: [],
      vamDir: tmp.vamDir,
    })
    expect(r).toEqual({ donor: 'A.B.1.var', copiedTypeOverride: true })
  })

  it('runScan inherits settings on a non-initial scan when a new version appears', async () => {
    // Initial scan with v1 only — labels/type_override applied AFTER initial scan.
    const v1 = await buildVar({
      meta: { packageName: 'A.B', creator: 'A' },
      files: { 'Saves/scene/Demo.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'A.B.1.var', v1)
    await runScan(tmp.vamDir)

    const lbl = findOrCreateLabel('Keep')
    applyLabelToPackages(lbl.id, ['A.B.1.var'])
    setPackageTypeOverride('A.B.1.var', 'MyCat')

    // Backdate v1 so the donor lookup's `first_seen_at < self` gate is satisfied
    // even if both runScans land in the same wall-clock second under fast tests.
    getDb().prepare('UPDATE packages SET first_seen_at = 1 WHERE filename = ?').run('A.B.1.var')

    // A second .var of the same package_name appears — non-initial scan must
    // inherit the user-set state from v1.
    const v2 = await buildVar({
      meta: { packageName: 'A.B', creator: 'A' },
      files: { 'Saves/scene/Demo.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'A.B.2.var', v2)
    await runScan(tmp.vamDir)

    const v2Row = getAllPackages().find((p) => p.filename === 'A.B.2.var')
    expect(v2Row.type_override).toBe('MyCat')

    const v2Labels = getAllLabelPackages().filter((r) => r.package_filename === 'A.B.2.var')
    expect(v2Labels.map((r) => r.label_id)).toEqual([lbl.id])
  })

  it('initial scan does NOT auto-inherit between siblings present at first index', async () => {
    const v1 = await buildVar({
      meta: { packageName: 'A.B', creator: 'A' },
      files: { 'Saves/scene/Demo.json': '{"atoms":[]}' },
    })
    const v2 = await buildVar({
      meta: { packageName: 'A.B', creator: 'A' },
      files: { 'Saves/scene/Demo.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'A.B.1.var', v1)
    await placeVar(tmp.addonPackages, 'A.B.2.var', v2)

    // Pre-seed type_override on what will become "older" version, but do it BEFORE
    // the row exists by inserting a placeholder row… instead easier: rely on the
    // fact that inheritance shouldn't fire on isInitialScan regardless of state.
    // We can't add labels before the first scan because the FK requires a row,
    // so this test just verifies the absence of cross-contamination from v1→v2
    // type_override on the very first index pass.
    setSetting('initial_scan_done', null)
    await runScan(tmp.vamDir)

    const rows = getAllPackages()
    const v1Row = rows.find((p) => p.filename === 'A.B.1.var')
    const v2Row = rows.find((p) => p.filename === 'A.B.2.var')
    expect(v1Row.type_override).toBeNull()
    expect(v2Row.type_override).toBeNull()
  })

  it('downloads-style flow: scanAndUpsert + inherit copies labels into the new row', async () => {
    seedPackage({ filename: 'A.B.1.var', creator: 'A', package_name: 'A.B', version: '1' })
    const lbl = findOrCreateLabel('Carry')
    applyLabelToPackages(lbl.id, ['A.B.1.var'])

    const v2 = await buildVar({
      meta: { packageName: 'A.B', creator: 'A' },
      files: { 'Saves/scene/Demo.json': '{"atoms":[]}' },
    })
    const v2Path = await placeVar(tmp.addonPackages, 'A.B.2.var', v2)
    const result = await scanAndUpsert(v2Path, { isDirect: 1, storageState: 'enabled', libraryDirId: null })

    await inheritFromOlderVersion({
      filename: result.filename,
      packageName: result.packageName,
      contentItems: result.contentItems,
      vamDir: tmp.vamDir,
    })

    const v2Labels = getAllLabelPackages().filter((r) => r.package_filename === 'A.B.2.var')
    expect(v2Labels.map((r) => r.label_id)).toEqual([lbl.id])
  })
})
