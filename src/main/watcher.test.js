import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdir, rename, readdir, writeFile, readFile, stat, unlink } from 'fs/promises'
import {
  mkTempVamDir,
  mkAuxDir,
  buildVar,
  placeVar,
  placeEmptyMarker,
  openTestDatabase,
} from '../../test/fixtures/index.js'
import { runScan } from './scanner/index.js'
import {
  closeDatabase,
  getAllPackages,
  insertLibraryDir,
  setLibraryDirBrowserAssist,
  setSetting,
  setStorageState,
} from './db.js'
import {
  __processBatchForTests,
  __setProcessBatchStateForTests,
  __prefsEventSyncForTests,
  __localPrefsEventSyncForTests,
  withBulkWindow,
  recordOwnedPath,
} from './watcher.js'
import { refreshLibraryDirs, pkgVarPath, resolveContentPath } from './library-dirs.js'
import { buildFromDb, getPackageIndex, getPrefsMap } from './store.js'
import { applyStorageState } from './storage-state.js'
import { ADDON_PACKAGES_FILE_PREFS } from '@shared/paths.js'

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

describe('watcher.processBatch — cross-dir move (single batch)', () => {
  it('unlink on main + add on aux (same canonical) → state moves to offloaded, no row delete', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    const buf = await buildVar({
      meta: { packageName: 'Author.Move', creator: 'Author' },
      files: { 'Saves/scene/X.json': '{"atoms":[]}' },
    })
    const mainPath = await placeVar(tmp.addonPackages, 'Author.Move.1.var', buf)
    await runScan(tmp.vamDir)

    let row = getAllPackages().find((r) => r.filename === 'Author.Move.1.var')
    expect(row).toBeDefined()
    expect(row.storage_state).toBe('enabled')
    expect(row.library_dir_id).toBeNull()

    const auxPath = join(aux, 'Author.Move.1.var')
    await rename(mainPath, auxPath)
    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [
        [mainPath, { type: 'unlink', libraryDirId: null }],
        [auxPath, { type: 'add', libraryDirId: auxId }],
      ],
    })

    await __processBatchForTests()

    row = getAllPackages().find((r) => r.filename === 'Author.Move.1.var')
    expect(row).toBeDefined()
    expect(row.storage_state).toBe('offloaded')
    expect(row.library_dir_id).toBe(auxId)

    expect(await readdir(tmp.addonPackages)).not.toContain('Author.Move.1.var')
    expect(await readdir(aux)).toContain('Author.Move.1.var')
  })

  it('unlink on main with no add in batch but file still on aux → findElsewhere updates state', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    const buf = await buildVar({
      meta: { packageName: 'Stale.Main', creator: 'S' },
      files: { 'Saves/scene/s.json': '{"atoms":[]}' },
    })
    const mainPath = await placeVar(tmp.addonPackages, 'Stale.Main.1.var', buf)
    await runScan(tmp.vamDir)
    const auxPath = join(aux, 'Stale.Main.1.var')
    await rename(mainPath, auxPath)
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[mainPath, { type: 'unlink', libraryDirId: null }]],
    })
    await __processBatchForTests()

    const row = getAllPackages().find((r) => r.filename === 'Stale.Main.1.var')
    expect(row?.storage_state).toBe('offloaded')
    expect(row?.library_dir_id).toBe(auxId)
  })

  it('unlink with no file anywhere → deletePackage removes the row', async () => {
    const buf = await buildVar({
      meta: { packageName: 'Vanish.V', creator: 'V' },
      files: { 'Saves/scene/v.json': '{"atoms":[]}' },
    })
    const mainPath = await placeVar(tmp.addonPackages, 'Vanish.V.1.var', buf)
    await runScan(tmp.vamDir)
    await rename(mainPath, join(tmp.vamDir, 'gone.tmp.var'))
    await import('fs/promises').then((fs) => fs.unlink(join(tmp.vamDir, 'gone.tmp.var')))
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[mainPath, { type: 'unlink', libraryDirId: null }]],
    })
    await __processBatchForTests()

    expect(getAllPackages().filter((r) => r.filename === 'Vanish.V.1.var')).toHaveLength(0)
  })

  it('move from aux back to main via unlink aux + add main → enabled, library_dir_id null', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    const buf = await buildVar({
      meta: { packageName: 'Back.M', creator: 'B' },
      files: { 'Saves/scene/b.json': '{"atoms":[]}' },
    })
    const auxPath = await placeVar(aux, 'Back.M.1.var', buf)
    await runScan(tmp.vamDir)
    expect(getAllPackages().find((r) => r.filename === 'Back.M.1.var')?.library_dir_id).toBe(auxId)

    const mainPath = join(tmp.addonPackages, 'Back.M.1.var')
    await rename(auxPath, mainPath)
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [
        [auxPath, { type: 'unlink', libraryDirId: auxId }],
        [mainPath, { type: 'add', libraryDirId: null }],
      ],
    })
    await __processBatchForTests()

    const row = getAllPackages().find((r) => r.filename === 'Back.M.1.var')
    expect(row?.storage_state).toBe('enabled')
    expect(row?.library_dir_id).toBeNull()
  })
})

describe('watcher.processBatch — nested .var move recovery', () => {
  it('move into a different main subfolder (unlink only) keeps the row and updates subpath', async () => {
    const fromDir = join(tmp.addonPackages, 'A')
    await mkdir(fromDir, { recursive: true })
    const buf = await buildVar({
      meta: { packageName: 'Nest.Mv', creator: 'N' },
      files: { 'Saves/scene/x.json': '{"atoms":[]}' },
    })
    const fromPath = await placeVar(fromDir, 'Nest.Mv.1.var', buf)
    await runScan(tmp.vamDir)
    expect(getAllPackages().find((r) => r.filename === 'Nest.Mv.1.var')?.subpath).toBe('A')

    const toDir = join(tmp.addonPackages, 'B', 'C')
    await mkdir(toDir, { recursive: true })
    await rename(fromPath, join(toDir, 'Nest.Mv.1.var'))
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[fromPath, { type: 'unlink', libraryDirId: null }]],
    })
    await __processBatchForTests()

    const row = getAllPackages().find((r) => r.filename === 'Nest.Mv.1.var')
    expect(row).toBeDefined() // not deleted — file found nested elsewhere
    expect(row.storage_state).toBe('enabled')
    expect(row.subpath).toBe('B/C')
  })

  it('move out of a subfolder with no copy anywhere still deletes the row', async () => {
    const dir = join(tmp.addonPackages, 'Solo')
    await mkdir(dir, { recursive: true })
    const buf = await buildVar({
      meta: { packageName: 'Nest.Gone', creator: 'N' },
      files: { 'Saves/scene/g.json': '{"atoms":[]}' },
    })
    const p = await placeVar(dir, 'Nest.Gone.1.var', buf)
    await runScan(tmp.vamDir)
    await import('fs/promises').then((fs) => fs.rm(p))
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[p, { type: 'unlink', libraryDirId: null }]],
    })
    await __processBatchForTests()

    expect(getAllPackages().filter((r) => r.filename === 'Nest.Gone.1.var')).toHaveLength(0)
  })
})

describe('applyStorageState — nested .var preserves its subfolder', () => {
  async function seedNested() {
    const sub = join(tmp.addonPackages, 'Creator', 'Bundle')
    await mkdir(sub, { recursive: true })
    const buf = await buildVar({
      meta: { packageName: 'Sub.Pkg', creator: 'Sub' },
      files: { 'Saves/scene/s.json': '{"atoms":[]}' },
    })
    await placeVar(sub, 'Sub.Pkg.1.var', buf)
    await runScan(tmp.vamDir)
    buildFromDb()
    return sub
  }

  it('disable drops an empty .var.disabled marker beside the bare file in the same subfolder', async () => {
    const sub = await seedNested()
    await applyStorageState('Sub.Pkg.1.var', { storageState: 'disabled', libraryDirId: null })

    const row = getAllPackages().find((r) => r.filename === 'Sub.Pkg.1.var')
    expect(row.storage_state).toBe('disabled')
    // VaM-native marker layout: content stays in the bare .var.
    expect(await resolveContentPath(row)).toBe(join(sub, 'Sub.Pkg.1.var'))
    expect(row.subpath).toBe('Creator/Bundle')
    // Both the bare content and the empty marker sit side by side.
    const onDisk = await readdir(sub)
    expect(onDisk).toContain('Sub.Pkg.1.var')
    expect(onDisk).toContain('Sub.Pkg.1.var.disabled')
    const markerStat = await stat(join(sub, 'Sub.Pkg.1.var.disabled'))
    expect(markerStat.size).toBe(0)
    // pkgVarPath still resolves to the bare content, not the marker.
    expect(pkgVarPath(getPackageIndex().get('Sub.Pkg.1.var'))).toBe(join(sub, 'Sub.Pkg.1.var'))
  })

  it('enable of a marker-disabled package deletes the marker and keeps the bare content', async () => {
    const sub = await seedNested()
    await applyStorageState('Sub.Pkg.1.var', { storageState: 'disabled', libraryDirId: null })
    await applyStorageState('Sub.Pkg.1.var', { storageState: 'enabled', libraryDirId: null })

    const row = getAllPackages().find((r) => r.filename === 'Sub.Pkg.1.var')
    expect(row.storage_state).toBe('enabled')
    const onDisk = await readdir(sub)
    expect(onDisk).toContain('Sub.Pkg.1.var')
    expect(onDisk).not.toContain('Sub.Pkg.1.var.disabled')
  })

  it('offload to an aux dir mirrors the subfolder, and enable restores it', async () => {
    const sub = await seedNested()
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    refreshLibraryDirs()

    await applyStorageState('Sub.Pkg.1.var', { storageState: 'offloaded', libraryDirId: auxId })
    let row = getAllPackages().find((r) => r.filename === 'Sub.Pkg.1.var')
    expect(row.storage_state).toBe('offloaded')
    expect(row.library_dir_id).toBe(auxId)
    expect(row.subpath).toBe('Creator/Bundle')
    // physically moved into the mirrored subfolder under the aux dir
    expect(await readdir(join(aux, 'Creator', 'Bundle'))).toContain('Sub.Pkg.1.var')
    expect(await readdir(sub)).not.toContain('Sub.Pkg.1.var')

    await applyStorageState('Sub.Pkg.1.var', { storageState: 'enabled', libraryDirId: null })
    row = getAllPackages().find((r) => r.filename === 'Sub.Pkg.1.var')
    expect(row.storage_state).toBe('enabled')
    expect(row.library_dir_id).toBeNull()
    expect(row.subpath).toBe('Creator/Bundle')
    expect(await readdir(sub)).toContain('Sub.Pkg.1.var') // back in the original main subfolder
  })
})

describe('applyStorageState — BrowserAssist sidecar mode on an aux dir', () => {
  async function seedNestedMain() {
    const sub = join(tmp.addonPackages, 'Creator', 'Bundle')
    await mkdir(sub, { recursive: true })
    const buf = await buildVar({
      meta: { packageName: 'Sub.Pkg', creator: 'Sub' },
      files: { 'Saves/scene/s.json': '{"atoms":[]}' },
    })
    await placeVar(sub, 'Sub.Pkg.1.var', buf)
    await runScan(tmp.vamDir)
    buildFromDb()
    return sub
  }

  async function mkBrowserAssistAux() {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    setLibraryDirBrowserAssist(auxId, 1)
    refreshLibraryDirs()
    return { aux, auxId }
  }

  it('offloading a nested package writes a .var.json sidecar recording its OriginalFolder', async () => {
    await seedNestedMain()
    const { aux, auxId } = await mkBrowserAssistAux()

    await applyStorageState('Sub.Pkg.1.var', { storageState: 'offloaded', libraryDirId: auxId })

    const row = getAllPackages().find((r) => r.filename === 'Sub.Pkg.1.var')
    expect(row.storage_state).toBe('offloaded')
    expect(row.library_dir_id).toBe(auxId)
    expect(row.subpath).toBe('Creator/Bundle')

    // Bytes mirrored into the subfolder; sidecar sits beside them.
    const destDir = join(aux, 'Creator', 'Bundle')
    const files = await readdir(destDir)
    expect(files).toContain('Sub.Pkg.1.var')
    expect(files).toContain('Sub.Pkg.1.var.json')
    const sidecar = JSON.parse(await readFile(join(destDir, 'Sub.Pkg.1.var.json'), 'utf8'))
    expect(sidecar.OriginalFolder).toBe('AddonPackages\\Creator\\Bundle')
  })

  it('restoring from a BrowserAssist dir removes the sidecar and lands in the original folder', async () => {
    const sub = await seedNestedMain()
    const { aux, auxId } = await mkBrowserAssistAux()

    await applyStorageState('Sub.Pkg.1.var', { storageState: 'offloaded', libraryDirId: auxId })
    await applyStorageState('Sub.Pkg.1.var', { storageState: 'enabled', libraryDirId: null })

    const row = getAllPackages().find((r) => r.filename === 'Sub.Pkg.1.var')
    expect(row.storage_state).toBe('enabled')
    expect(row.library_dir_id).toBeNull()
    expect(row.subpath).toBe('Creator/Bundle')
    expect(await readdir(sub)).toContain('Sub.Pkg.1.var')
    // The sidecar left the aux dir with the file.
    expect(await readdir(join(aux, 'Creator', 'Bundle'))).not.toContain('Sub.Pkg.1.var.json')
  })

  it('root-level packages get no sidecar (BrowserAssist restores the root by default)', async () => {
    const buf = await buildVar({
      meta: { packageName: 'Root.Pkg', creator: 'Root' },
      files: { 'Saves/scene/r.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Root.Pkg.1.var', buf)
    await runScan(tmp.vamDir)
    buildFromDb()
    const { aux, auxId } = await mkBrowserAssistAux()

    await applyStorageState('Root.Pkg.1.var', { storageState: 'offloaded', libraryDirId: auxId })

    const files = await readdir(aux)
    expect(files).toContain('Root.Pkg.1.var')
    expect(files).not.toContain('Root.Pkg.1.var.json')
  })

  it('restores a package BrowserAssist offloaded flat, honoring the sidecar OriginalFolder', async () => {
    // BrowserAssist flattens every offloaded .var to the aux root and records the
    // real restore folder in the sidecar. We must restore to that folder, not the
    // flat physical location.
    const { aux } = await mkBrowserAssistAux()
    const buf = await buildVar({
      meta: { packageName: 'Flat.Pkg', creator: 'Flat' },
      files: { 'Saves/scene/f.json': '{"atoms":[]}' },
    })
    await placeVar(aux, 'Flat.Pkg.1.var', buf) // flat at aux root
    await writeFile(
      join(aux, 'Flat.Pkg.1.var.json'),
      JSON.stringify({ OriginalFolder: 'AddonPackages\\Sorted\\Scenes' }),
    )
    await runScan(tmp.vamDir)
    buildFromDb()

    const offloaded = getAllPackages().find((r) => r.filename === 'Flat.Pkg.1.var')
    expect(offloaded.storage_state).toBe('offloaded')
    expect(offloaded.subpath).toBe('') // physically flat at the aux root

    await applyStorageState('Flat.Pkg.1.var', { storageState: 'enabled', libraryDirId: null })

    const row = getAllPackages().find((r) => r.filename === 'Flat.Pkg.1.var')
    expect(row.storage_state).toBe('enabled')
    expect(row.subpath).toBe('Sorted/Scenes')
    expect(await readdir(join(tmp.addonPackages, 'Sorted', 'Scenes'))).toContain('Flat.Pkg.1.var')
    expect(await readdir(aux)).not.toContain('Flat.Pkg.1.var') // moved out
    expect(await readdir(aux)).not.toContain('Flat.Pkg.1.var.json') // sidecar removed
  })

  it('re-offloads after a BA flat restore using the in-memory subpath (no rebuild)', async () => {
    // Regression: enable from a BA-flattened package updates DB subpath via the
    // sidecar, but used to leave packageIndex.subpath as '' — the next offload
    // then looked for the .var under AddonPackages root and threw "Source file missing".
    const { aux, auxId } = await mkBrowserAssistAux()
    const buf = await buildVar({
      meta: { packageName: 'Round.Pkg', creator: 'Round' },
      files: { 'Saves/scene/r.json': '{"atoms":[]}' },
    })
    await placeVar(aux, 'Round.Pkg.1.var', buf)
    await writeFile(
      join(aux, 'Round.Pkg.1.var.json'),
      JSON.stringify({ OriginalFolder: 'AddonPackages\\Sorted\\Scenes' }),
    )
    await runScan(tmp.vamDir)
    buildFromDb()

    await applyStorageState('Round.Pkg.1.var', { storageState: 'enabled', libraryDirId: null })
    // In-memory index must carry the restore subpath — no buildFromDb in between.
    expect(getPackageIndex().get('Round.Pkg.1.var')?.subpath).toBe('Sorted/Scenes')

    await applyStorageState('Round.Pkg.1.var', { storageState: 'offloaded', libraryDirId: auxId })
    const row = getPackageIndex().get('Round.Pkg.1.var')
    expect(row.storage_state).toBe('offloaded')
    expect(row.subpath).toBe('Sorted/Scenes')
    expect(await readdir(join(aux, 'Sorted', 'Scenes'))).toContain('Round.Pkg.1.var')
    expect(await readdir(join(tmp.addonPackages, 'Sorted', 'Scenes'))).not.toContain('Round.Pkg.1.var')
  })
})

describe('applyStorageState — destination collision size guard', () => {
  async function seedEnabled() {
    const buf = await buildVar({
      meta: { packageName: 'Guard.Pkg', creator: 'Guard' },
      files: { 'Saves/scene/s.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Guard.Pkg.1.var', buf)
    await runScan(tmp.vamDir)
    buildFromDb()
  }

  it('throws and leaves both files in place when a different-size file occupies the destination', async () => {
    await seedEnabled()
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    refreshLibraryDirs()

    // A foreign file sharing the canonical name but with different bytes already lives at the aux dest.
    const auxDest = join(aux, 'Guard.Pkg.1.var')
    await writeFile(auxDest, 'not the same package at all')

    await expect(
      applyStorageState('Guard.Pkg.1.var', { storageState: 'offloaded', libraryDirId: auxId }),
    ).rejects.toThrow(/different file already exists at the destination/)

    // Neither side was touched: source stays in main, foreign dest is intact.
    expect(await readdir(tmp.addonPackages)).toContain('Guard.Pkg.1.var')
    expect(await readFile(auxDest, 'utf8')).toBe('not the same package at all')
    const row = getAllPackages().find((r) => r.filename === 'Guard.Pkg.1.var')
    expect(row.storage_state).toBe('enabled')
    expect(row.library_dir_id).toBeNull()
  })

  it('replaces a byte-identical (same-size) file already at the destination', async () => {
    await seedEnabled()
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    refreshLibraryDirs()

    // A byte-identical copy already sits at the aux dest (same canonical, same bytes).
    const mainPath = join(tmp.addonPackages, 'Guard.Pkg.1.var')
    const auxDest = join(aux, 'Guard.Pkg.1.var')
    await writeFile(auxDest, await readFile(mainPath))

    await applyStorageState('Guard.Pkg.1.var', { storageState: 'offloaded', libraryDirId: auxId })

    const row = getAllPackages().find((r) => r.filename === 'Guard.Pkg.1.var')
    expect(row.storage_state).toBe('offloaded')
    expect(row.library_dir_id).toBe(auxId)
    expect(await readdir(aux)).toContain('Guard.Pkg.1.var')
    expect(await readdir(tmp.addonPackages)).not.toContain('Guard.Pkg.1.var')
  })

  it('replaces an empty (0-byte) stub already at the destination', async () => {
    await seedEnabled()
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    refreshLibraryDirs()

    // A 0-byte stub (leftover from an interrupted write / external `touch`) occupies
    // the aux dest — it carries no content, so the offload should replace it.
    const mainPath = join(tmp.addonPackages, 'Guard.Pkg.1.var')
    const auxDest = join(aux, 'Guard.Pkg.1.var')
    const realBytes = await readFile(mainPath)
    await writeFile(auxDest, '')

    await applyStorageState('Guard.Pkg.1.var', { storageState: 'offloaded', libraryDirId: auxId })

    const row = getAllPackages().find((r) => r.filename === 'Guard.Pkg.1.var')
    expect(row.storage_state).toBe('offloaded')
    expect(row.library_dir_id).toBe(auxId)
    // The real content bytes now live at the aux dest, the stub is gone.
    expect(await readFile(auxDest)).toEqual(realBytes)
    expect(await readdir(tmp.addonPackages)).not.toContain('Guard.Pkg.1.var')
  })
})

describe('applyStorageState — marker vs suffix disable safety', () => {
  async function seedMain(name, pkgMeta, opts) {
    const buf = await buildVar({ meta: pkgMeta, files: { 'Saves/scene/s.json': '{"atoms":[]}' } })
    await placeVar(tmp.addonPackages, name, buf, opts)
    await runScan(tmp.vamDir)
    buildFromDb()
    return buf
  }

  it('enable of a legacy suffix-disabled package renames .var.disabled → bare .var', async () => {
    await seedMain('Legacy.D.1.var', { packageName: 'Legacy.D', creator: 'L' }, { disabled: true })
    // Content initially lives in the suffixed file (legacy rename layout).
    expect(await resolveContentPath(getAllPackages().find((r) => r.filename === 'Legacy.D.1.var'))).toBe(
      join(tmp.addonPackages, 'Legacy.D.1.var.disabled'),
    )

    await applyStorageState('Legacy.D.1.var', { storageState: 'enabled', libraryDirId: null })

    const onDisk = await readdir(tmp.addonPackages)
    expect(onDisk).toContain('Legacy.D.1.var')
    expect(onDisk).not.toContain('Legacy.D.1.var.disabled')
    const row = getAllPackages().find((r) => r.filename === 'Legacy.D.1.var')
    expect(row.storage_state).toBe('enabled')
    expect(await resolveContentPath(row)).toBe(join(tmp.addonPackages, 'Legacy.D.1.var'))
  })

  it('enable removes a byte-identical .var.disabled copy sitting beside the bare content', async () => {
    const buf = await seedMain('Dup.En.1.var', { packageName: 'Dup.En', creator: 'D' })
    // Drop a byte-identical .disabled copy beside the bare content, then reconcile.
    await writeFile(join(tmp.addonPackages, 'Dup.En.1.var.disabled'), buf)
    await runScan(tmp.vamDir)
    buildFromDb()
    expect(getAllPackages().find((r) => r.filename === 'Dup.En.1.var')?.storage_state).toBe('disabled')

    await applyStorageState('Dup.En.1.var', { storageState: 'enabled', libraryDirId: null })

    const onDisk = await readdir(tmp.addonPackages)
    expect(onDisk).toContain('Dup.En.1.var')
    expect(onDisk).not.toContain('Dup.En.1.var.disabled')
    expect(getAllPackages().find((r) => r.filename === 'Dup.En.1.var')?.storage_state).toBe('enabled')
  })

  it('enable refuses (throws) when a different-size non-empty .var.disabled sits beside the bare content', async () => {
    await seedMain('Amb.En.1.var', { packageName: 'Amb.En', creator: 'A' })
    await writeFile(join(tmp.addonPackages, 'Amb.En.1.var.disabled'), 'totally different bytes, non-empty')
    await runScan(tmp.vamDir)
    buildFromDb()
    // Classified as disabled (marker layout — content in the bare file).
    expect(getAllPackages().find((r) => r.filename === 'Amb.En.1.var')?.storage_state).toBe('disabled')

    await expect(applyStorageState('Amb.En.1.var', { storageState: 'enabled', libraryDirId: null })).rejects.toThrow(
      /Refusing to remove/,
    )

    // Neither file destroyed.
    const onDisk = await readdir(tmp.addonPackages)
    expect(onDisk).toContain('Amb.En.1.var')
    expect(onDisk).toContain('Amb.En.1.var.disabled')
  })
})

describe('watcher.processBatch — VaM-native marker events', () => {
  async function seedEnabled(name, pkgMeta) {
    const buf = await buildVar({ meta: pkgMeta, files: { 'Saves/scene/s.json': '{"atoms":[]}' } })
    await placeVar(tmp.addonPackages, name, buf)
    await runScan(tmp.vamDir)
    buildFromDb()
    return buf
  }

  it('external .var.disabled marker add flips an enabled package to disabled (no re-read)', async () => {
    await seedEnabled('Ext.M.1.var', { packageName: 'Ext.M', creator: 'E' })
    const markerPath = await placeEmptyMarker(tmp.addonPackages, 'Ext.M.1.var')

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[markerPath, { type: 'add', libraryDirId: null }]],
    })
    await __processBatchForTests()

    const row = getAllPackages().find((r) => r.filename === 'Ext.M.1.var')
    expect(row.storage_state).toBe('disabled')
    expect(await resolveContentPath(row)).toBe(join(tmp.addonPackages, 'Ext.M.1.var'))
    // Bare content untouched.
    expect(await readdir(tmp.addonPackages)).toContain('Ext.M.1.var')
  })

  it('external .var.disabled marker removal flips a disabled package back to enabled', async () => {
    const buf = await buildVar({
      meta: { packageName: 'Ext.E', creator: 'E' },
      files: { 'Saves/scene/e.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Ext.E.1.var', buf, { marker: true })
    await runScan(tmp.vamDir)
    buildFromDb()
    expect(getAllPackages().find((r) => r.filename === 'Ext.E.1.var')?.storage_state).toBe('disabled')

    const markerPath = join(tmp.addonPackages, 'Ext.E.1.var.disabled')
    await unlink(markerPath)
    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[markerPath, { type: 'unlink', libraryDirId: null }]],
    })
    await __processBatchForTests()

    const row = getAllPackages().find((r) => r.filename === 'Ext.E.1.var')
    expect(row.storage_state).toBe('enabled')
    expect(await resolveContentPath(row)).toBe(join(tmp.addonPackages, 'Ext.E.1.var'))
  })
})

describe('watcher.processBatch — aux .var.disabled normalization', () => {
  it('aux .var.disabled add normalizes to bare .var', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    const buf = await buildVar({
      meta: { packageName: 'Norm.A', creator: 'N' },
      files: { 'Saves/scene/n.json': '{"atoms":[]}' },
    })
    const disPath = await placeVar(aux, 'Norm.A.1.var', buf, { disabled: true })
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[disPath, { type: 'add', libraryDirId: auxId }]],
    })
    await __processBatchForTests()

    expect(await readdir(aux)).toContain('Norm.A.1.var')
    expect(await readdir(aux)).not.toContain('Norm.A.1.var.disabled')
  })

  it('aux .var.disabled unlinks when bare sibling exists with same size', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    const body = await buildVar({
      meta: { packageName: 'Dup.Sz', creator: 'D' },
      files: { 'Saves/scene/d.json': '{"atoms":[]}' },
    })
    const bare = join(aux, 'Dup.Sz.1.var')
    const dis = join(aux, 'Dup.Sz.1.var.disabled')
    await writeFile(bare, body)
    await writeFile(dis, body)
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[dis, { type: 'add', libraryDirId: auxId }]],
    })
    await __processBatchForTests()

    expect(await readFile(bare)).toEqual(body)
    await expect(readFile(dis)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('aux .var.disabled left in place when bare sibling has different size', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    const bufA = await buildVar({
      meta: { packageName: 'Diff.Sz', creator: 'A' },
      files: { 'Saves/scene/a.json': '{"atoms":[]}' },
    })
    const bufB = await buildVar({
      meta: { packageName: 'Diff.Sz', creator: 'B' },
      files: { 'Saves/scene/a.json': '{"atoms":[1]}' },
    })
    const bare = join(aux, 'Diff.Sz.1.var')
    const dis = join(aux, 'Diff.Sz.1.var.disabled')
    await writeFile(bare, bufA)
    await writeFile(dis, bufB)
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[dis, { type: 'add', libraryDirId: auxId }]],
    })
    await __processBatchForTests()

    expect(await readdir(aux)).toContain('Diff.Sz.1.var')
    expect(await readdir(aux)).toContain('Diff.Sz.1.var.disabled')
  })

  it('aux bare .var add after normalize installs package', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    const buf = await buildVar({
      meta: { packageName: 'Norm.B', creator: 'N' },
      files: { 'Saves/scene/x.json': '{"atoms":[]}' },
    })
    const disPath = await placeVar(aux, 'Norm.B.1.var', buf, { disabled: true })
    refreshLibraryDirs()
    const normBare = join(aux, 'Norm.B.1.var')

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [
        [disPath, { type: 'add', libraryDirId: auxId }],
        [normBare, { type: 'add', libraryDirId: auxId }],
      ],
    })
    await __processBatchForTests()

    const row = getAllPackages().find((r) => r.filename === 'Norm.B.1.var')
    expect(row?.storage_state).toBe('offloaded')
  })
})

// External (watcher-observed) changes never cascade state onto other packages:
// enabling a parent by dropping its `.var` on disk must NOT re-enable/restore its
// disabled or offloaded deps. That would race a peer app's own queued changes,
// enable content the user may not want, and be a surprising side effect. Missing
// deps just surface as "broken" in the graph. (App/user-initiated enables still
// cascade — that path lives in ipc/packages.js and downloads/manager.js.)
describe('watcher.processBatch — external adds never cascade', () => {
  it('leaves a disabled forward dep disabled when its parent is added on disk', async () => {
    const depBuf = await buildVar({
      meta: { packageName: 'Dep.D', creator: 'D' },
      files: { 'Saves/scene/d1.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Dep.D.1.var', depBuf)
    await runScan(tmp.vamDir)
    await applyStorageState('Dep.D.1.var', { storageState: 'disabled', libraryDirId: null })
    buildFromDb()

    const parentBuf = await buildVar({
      meta: {
        packageName: 'Par.P',
        creator: 'P',
        dependencies: { 'Dep.D.1': { dependencies: {} } },
      },
      files: { 'Saves/scene/p1.json': '{"atoms":[]}' },
    })
    const parentPath = await placeVar(tmp.addonPackages, 'Par.P.1.var', parentBuf)
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[parentPath, { type: 'add', libraryDirId: null }]],
    })
    await __processBatchForTests()

    // Parent itself is scanned + enabled, but the dep is untouched.
    expect(getAllPackages().find((r) => r.filename === 'Par.P.1.var')?.storage_state).toBe('enabled')
    const dep = getAllPackages().find((r) => r.filename === 'Dep.D.1.var')
    expect(dep?.storage_state).toBe('disabled')
  })

  it('leaves an offloaded forward dep offloaded when its parent is added on disk', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    const depBuf = await buildVar({
      meta: { packageName: 'DepOff.O', creator: 'O' },
      files: { 'Saves/scene/o1.json': '{"atoms":[]}' },
    })
    await placeVar(aux, 'DepOff.O.1.var', depBuf)
    await runScan(tmp.vamDir)
    setStorageState('DepOff.O.1.var', 'offloaded', auxId)
    buildFromDb()

    const parBuf = await buildVar({
      meta: {
        packageName: 'ParOff.P',
        creator: 'P',
        dependencies: { 'DepOff.O.1': { dependencies: {} } },
      },
      files: { 'Saves/scene/p2.json': '{"atoms":[]}' },
    })
    const parPath = await placeVar(tmp.addonPackages, 'ParOff.P.1.var', parBuf)
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[parPath, { type: 'add', libraryDirId: null }]],
    })
    await __processBatchForTests()

    const dep = getAllPackages().find((r) => r.filename === 'DepOff.O.1.var')
    expect(dep?.storage_state).toBe('offloaded')
    expect(dep?.library_dir_id).toBe(auxId)
  })

  it('leaves a disabled dep disabled even when the added parent is itself disabled', async () => {
    const depBuf = await buildVar({
      meta: { packageName: 'DepX.X', creator: 'X' },
      files: { 'Saves/scene/dx.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'DepX.X.1.var', depBuf)
    await runScan(tmp.vamDir)
    await applyStorageState('DepX.X.1.var', { storageState: 'disabled', libraryDirId: null })
    buildFromDb()

    const parBuf = await buildVar({
      meta: { packageName: 'ParX.P', creator: 'P', dependencies: { 'DepX.X.1': { dependencies: {} } } },
      files: { 'Saves/scene/px.json': '{"atoms":[]}' },
    })
    const disPath = await placeVar(tmp.addonPackages, 'ParX.P.1.var', parBuf, { disabled: true })
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[disPath, { type: 'add', libraryDirId: null }]],
    })
    await __processBatchForTests()

    expect(getAllPackages().find((r) => r.filename === 'DepX.X.1.var')?.storage_state).toBe('disabled')
  })

  it('leaves an offloaded dep offloaded even when the added parent is itself offloaded', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    const depBuf = await buildVar({
      meta: { packageName: 'DepY.Y', creator: 'Y' },
      files: { 'Saves/scene/dy.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'DepY.Y.1.var', depBuf)
    await runScan(tmp.vamDir)
    await applyStorageState('DepY.Y.1.var', {
      storageState: 'offloaded',
      libraryDirId: auxId,
    })
    buildFromDb()

    const parBuf = await buildVar({
      meta: { packageName: 'ParY.P', creator: 'P', dependencies: { 'DepY.Y.1': { dependencies: {} } } },
      files: { 'Saves/scene/py.json': '{"atoms":[]}' },
    })
    const parAux = await placeVar(aux, 'ParY.P.1.var', parBuf)
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [[parAux, { type: 'add', libraryDirId: auxId }]],
    })
    await __processBatchForTests()

    expect(getAllPackages().find((r) => r.filename === 'DepY.Y.1.var')?.storage_state).toBe('offloaded')
  })

  it('leaves a shared dep disabled when multiple parents are added in one batch', async () => {
    const depBuf = await buildVar({
      meta: { packageName: 'Shared.S', creator: 'S' },
      files: { 'Saves/scene/s1.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Shared.S.1.var', depBuf)
    await runScan(tmp.vamDir)
    await applyStorageState('Shared.S.1.var', { storageState: 'disabled', libraryDirId: null })
    buildFromDb()

    const aBuf = await buildVar({
      meta: { packageName: 'Root.A', creator: 'R', dependencies: { 'Shared.S.1': { dependencies: {} } } },
      files: { 'Saves/scene/ra.json': '{"atoms":[]}' },
    })
    const bBuf = await buildVar({
      meta: { packageName: 'Root.B', creator: 'R', dependencies: { 'Shared.S.1': { dependencies: {} } } },
      files: { 'Saves/scene/rb.json': '{"atoms":[]}' },
    })
    const aPath = await placeVar(tmp.addonPackages, 'Root.A.1.var', aBuf)
    const bPath = await placeVar(tmp.addonPackages, 'Root.B.1.var', bBuf)
    refreshLibraryDirs()

    __setProcessBatchStateForTests({
      vamDir: tmp.vamDir,
      packageEvents: [
        [aPath, { type: 'add', libraryDirId: null }],
        [bPath, { type: 'add', libraryDirId: null }],
      ],
    })
    await __processBatchForTests()

    expect(getAllPackages().find((r) => r.filename === 'Shared.S.1.var')?.storage_state).toBe('disabled')
  })
})

describe('watcher.processBatch — prefs / sidecar handling', () => {
  it('.hide sidecar toggles hidden in prefsMap', async () => {
    await runScan(tmp.vamDir)
    buildFromDb()
    const prefsRoot = join(tmp.vamDir, ADDON_PACKAGES_FILE_PREFS)
    const stem = 'Pkg.Hide.1'
    await mkdir(join(prefsRoot, stem, 'Saves', 'scene'), { recursive: true })
    const sidecar = join(prefsRoot, stem, 'Saves', 'scene', 'Item.json.hide')
    await writeFile(sidecar, '')
    __setProcessBatchStateForTests({ vamDir: tmp.vamDir, prefsDir: prefsRoot })
    await __prefsEventSyncForTests(`${stem}/Saves/scene/Item.json.hide`)
    const key = 'Pkg.Hide.1.var/Saves/scene/Item.json'
    expect(getPrefsMap().get(key)?.hidden).toBe(true)
    await import('fs/promises').then((fs) => fs.unlink(sidecar))
    await __prefsEventSyncForTests(`${stem}/Saves/scene/Item.json.hide`)
    expect(getPrefsMap().get(key)?.hidden).toBe(false)
  })

  it('.fav sidecar toggles favorite in prefsMap', async () => {
    await runScan(tmp.vamDir)
    buildFromDb()
    const prefsRoot = join(tmp.vamDir, ADDON_PACKAGES_FILE_PREFS)
    const stem = 'Pkg.Fav.1'
    await mkdir(join(prefsRoot, stem, 'Saves', 'scene'), { recursive: true })
    const sidecar = join(prefsRoot, stem, 'Saves', 'scene', 'Item.json.fav')
    await writeFile(sidecar, '')
    __setProcessBatchStateForTests({ vamDir: tmp.vamDir, prefsDir: prefsRoot })
    await __prefsEventSyncForTests(`${stem}/Saves/scene/Item.json.fav`)
    const key = 'Pkg.Fav.1.var/Saves/scene/Item.json'
    expect(getPrefsMap().get(key)?.favorite).toBe(true)
    await import('fs/promises').then((fs) => fs.unlink(sidecar))
    await __prefsEventSyncForTests(`${stem}/Saves/scene/Item.json.fav`)
    expect(getPrefsMap().get(key)?.favorite).toBe(false)
  })

  it('local .hide under Saves updates prefs for __local__', async () => {
    await runScan(tmp.vamDir)
    buildFromDb()
    const sceneDir = join(tmp.vamDir, 'Saves', 'scene')
    await mkdir(sceneDir, { recursive: true })
    await writeFile(join(sceneDir, 'Local.json'), JSON.stringify({ atoms: [] }))
    await runScan(tmp.vamDir)
    buildFromDb()

    const hidePath = join(sceneDir, 'Local.json.hide')
    await writeFile(hidePath, '')
    __setProcessBatchStateForTests({ vamDir: tmp.vamDir })
    await __localPrefsEventSyncForTests(hidePath)
    const key = '__local__/Saves/scene/Local.json'
    expect(getPrefsMap().get(key)?.hidden).toBe(true)
  })

  it('local .fav under Custom updates prefs for __local__', async () => {
    const lookDir = join(tmp.vamDir, 'Custom', 'Atom', 'Person', 'Appearance')
    await mkdir(lookDir, { recursive: true })
    await writeFile(join(lookDir, 'L.vap'), 'x')
    await runScan(tmp.vamDir)
    buildFromDb()

    const favPath = join(lookDir, 'L.vap.fav')
    await writeFile(favPath, '')
    __setProcessBatchStateForTests({ vamDir: tmp.vamDir })
    await __localPrefsEventSyncForTests(favPath)
    const key = '__local__/Custom/Atom/Person/Appearance/L.vap'
    expect(getPrefsMap().get(key)?.favorite).toBe(true)
  })
})

describe('watcher.withBulkWindow', () => {
  it('runs the function and returns its value when no nesting', async () => {
    const result = await withBulkWindow(async () => 42)
    expect(result).toBe(42)
  })

  it('recordOwnedPath outside a window is a no-op (no error)', () => {
    expect(() => recordOwnedPath('/tmp/anything')).not.toThrow()
  })

  it('nested calls share the same ourPaths set', async () => {
    let outerOwned, innerOwned
    await withBulkWindow(async (outer) => {
      outerOwned = outer
      outer.add('/a/b')
      await withBulkWindow(async (inner) => {
        innerOwned = inner
        inner.add('/c/d')
      })
    })
    expect(outerOwned).toBe(innerOwned)
    expect(outerOwned.has('/a/b')).toBe(true)
    expect(outerOwned.has('/c/d')).toBe(true)
  })

  it('rethrows fn errors but still drains the buffer (no leaked window state)', async () => {
    await expect(
      withBulkWindow(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    // After failure, a fresh window should still work — no stale bulkWindow.
    const result = await withBulkWindow(async () => 'fresh')
    expect(result).toBe('fresh')
  })

  it('keeps the window alive while a peer caller is still running (refcount)', async () => {
    // Two concurrent callers, B starts after A and finishes before A. B's
    // recordOwnedPath calls must keep working until A also exits, otherwise
    // any call that joins someone else's window would silently lose its
    // event filter the moment the originator returns.
    let releaseA
    const aDone = new Promise((r) => (releaseA = r))
    let observedDuringA
    const a = withBulkWindow(async (owned) => {
      owned.add('/from-a')
      await aDone
      observedDuringA = new Set(owned)
    })
    // Yield so A has set the window before B enters.
    await Promise.resolve()
    await withBulkWindow(async (owned) => {
      owned.add('/from-b')
      // Window must still be open here — recordOwnedPath should be a real op.
      recordOwnedPath('/from-b-2')
      expect(owned.has('/from-b-2')).toBe(true)
    })
    // B has exited. Window must still be alive because A holds it.
    recordOwnedPath('/from-after-b')
    releaseA()
    await a
    expect(observedDuringA.has('/from-b')).toBe(true)
    expect(observedDuringA.has('/from-after-b')).toBe(true)
    // Now nothing holds the window — recordOwnedPath should no-op cleanly.
    expect(() => recordOwnedPath('/post')).not.toThrow()
  })
})
