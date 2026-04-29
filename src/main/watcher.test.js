import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdir, rename, readdir, writeFile, readFile } from 'fs/promises'
import { mkTempVamDir, mkAuxDir, buildVar, placeVar, openTestDatabase } from '../../test/fixtures/index.js'
import { runScan } from './scanner/index.js'
import { closeDatabase, getAllPackages, insertLibraryDir, setSetting, setStorageState } from './db.js'
import {
  __processBatchForTests,
  __setProcessBatchStateForTests,
  __prefsEventSyncForTests,
  __localPrefsEventSyncForTests,
  suppressPrefsStem,
  unsuppressPrefsStem,
} from './watcher.js'
import { refreshLibraryDirs } from './library-dirs.js'
import { buildFromDb, getPrefsMap } from './store.js'
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

describe('watcher.processBatch — cascade enable', () => {
  it('newly enabled package cascade-enables disabled forward deps', async () => {
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

    const dep = getAllPackages().find((r) => r.filename === 'Dep.D.1.var')
    expect(dep?.storage_state).toBe('enabled')
    expect(await readdir(tmp.addonPackages)).toContain('Dep.D.1.var')
  })

  it('cascade-enables offloaded deps', async () => {
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
    expect(dep?.storage_state).toBe('enabled')
    expect(dep?.library_dir_id).toBeNull()
  })

  it('does not cascade-enable when the new package state is disabled', async () => {
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

  it('does not cascade-enable when the new package state is offloaded', async () => {
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

  it('batching: one cascade pass covers deps for multiple newly enabled roots', async () => {
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

    expect(getAllPackages().find((r) => r.filename === 'Shared.S.1.var')?.storage_state).toBe('enabled')
  })
})

describe('watcher.processBatch — prefs / sidecar handling', () => {
  it('suppressPrefsStem drops prefs events for that package stem', async () => {
    const stem = 'Author.Pref.1'
    suppressPrefsStem(stem)
    try {
      const prefsRoot = join(tmp.vamDir, ADDON_PACKAGES_FILE_PREFS)
      await mkdir(join(prefsRoot, stem, 'Saves', 'scene'), { recursive: true })
      const sidecar = join(prefsRoot, stem, 'Saves', 'scene', 'HideMe.json.hide')
      await writeFile(sidecar, '')
      __setProcessBatchStateForTests({
        vamDir: tmp.vamDir,
        prefsDir: prefsRoot,
      })
      await __prefsEventSyncForTests(`${stem}/Saves/scene/HideMe.json.hide`)
      const prefs = getPrefsMap()
      expect(prefs.has(`Author.Pref.1.var/Saves/scene/HideMe.json`)).toBe(false)
    } finally {
      unsuppressPrefsStem(stem)
    }
  })

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
