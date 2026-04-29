import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readdir, writeFile, mkdir, rm, utimes } from 'fs/promises'
import { join } from 'path'
import { mkTempVamDir, mkAuxDir, buildVar, placeVar, openTestDatabase } from '../../../test/fixtures/index.js'
import { runScan } from './index.js'
import { closeDatabase, getAllPackages, insertLibraryDir, setSetting, getAllContents } from '../db.js'
import { runLocalScan } from './local.js'
import { LOCAL_PACKAGE_FILENAME } from '@shared/local-package.js'

// ── Integration harness: real fixture filesystem driving runScan ───────────────
//
// These tests exercise the scanner pipeline end-to-end against a real (temp)
// filesystem. We build .var ZIPs in-memory with `buildVar`, drop them into
// `addonPackages` (and aux dirs) via `placeVar`, then call `runScan` and
// assert the resulting DB rows.
//
// ⚠ NODE_MODULE_VERSION mismatch from `new Database(...)` here? You're
// running Vitest under host Node — use `npm test` (Electron-as-Node). See
// the comment on `openTestDatabase` in `test/fixtures/index.js`.
//
// One implemented test per regression class is enough to demonstrate the
// pattern; the rest are todos for the follow-up pass to fill in.

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

describe('runScan — main library only', () => {
  it('indexes a .var.disabled in main as storage_state="disabled" with suffix preserved on disk', async () => {
    const buf = await buildVar({
      meta: { packageName: 'Author.Pkg', creator: 'Author' },
      files: { 'Saves/scene/Demo.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Author.Pkg.1.var', buf, { disabled: true })

    const result = await runScan(tmp.vamDir)
    expect(result.added).toBe(1)

    const rows = getAllPackages().filter((r) => r.filename === 'Author.Pkg.1.var')
    expect(rows).toHaveLength(1)
    expect(rows[0].storage_state).toBe('disabled')
    expect(rows[0].library_dir_id).toBeNull()

    // The on-disk suffix must NOT be normalized away in main.
    const onDisk = await readdir(tmp.addonPackages)
    expect(onDisk).toContain('Author.Pkg.1.var.disabled')
  })

  it('indexes a bare .var as storage_state="enabled"', async () => {
    const buf = await buildVar({
      meta: { packageName: 'Bare.Pkg', creator: 'Bare' },
      files: { 'Saves/scene/Y.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Bare.Pkg.1.var', buf)
    await runScan(tmp.vamDir)
    const row = getAllPackages().find((r) => r.filename === 'Bare.Pkg.1.var')
    expect(row?.storage_state).toBe('enabled')
    expect(await readdir(tmp.addonPackages)).toContain('Bare.Pkg.1.var')
  })

  it('initial scan: packages with dependents are deps; roots nobody depends on are direct', async () => {
    const childBuf = await buildVar({
      meta: { packageName: 'Child.C', creator: 'C' },
      files: { 'Saves/scene/c.json': '{"atoms":[]}' },
    })
    const parentBuf = await buildVar({
      meta: {
        packageName: 'Parent.P',
        creator: 'P',
        dependencies: { 'Child.C.1': { dependencies: {} } },
      },
      files: { 'Saves/scene/p.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Child.C.1.var', childBuf)
    await placeVar(tmp.addonPackages, 'Parent.P.1.var', parentBuf)
    await runScan(tmp.vamDir)
    const byFile = Object.fromEntries(getAllPackages().map((r) => [r.filename, r]))
    expect(byFile['Parent.P.1.var'].is_direct).toBe(1)
    expect(byFile['Child.C.1.var'].is_direct).toBe(0)
  })

  it('second scan with no FS changes performs no package re-reads (stat cache)', async () => {
    const buf = await buildVar({
      meta: { packageName: 'Cache.Pkg', creator: 'A' },
      files: { 'Saves/scene/z.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Cache.Pkg.1.var', buf)
    const a = await runScan(tmp.vamDir)
    expect(a.scanned).toBeGreaterThan(0)
    const b = await runScan(tmp.vamDir)
    expect(b.scanned).toBe(0)
  })

  it('removes packages whose canonical filename is no longer on disk', async () => {
    const buf = await buildVar({
      meta: { packageName: 'Gone.Pkg', creator: 'G' },
      files: { 'Saves/scene/g.json': '{"atoms":[]}' },
    })
    const p = await placeVar(tmp.addonPackages, 'Gone.Pkg.1.var', buf)
    await runScan(tmp.vamDir)
    expect(getAllPackages().some((r) => r.filename === 'Gone.Pkg.1.var')).toBe(true)
    await rm(p)
    await runScan(tmp.vamDir)
    expect(getAllPackages().filter((r) => r.filename === 'Gone.Pkg.1.var')).toHaveLength(0)
  })
})

describe('runScan — aux library dirs', () => {
  it('normalizes a stray .var.disabled in aux to bare .var and indexes as offloaded', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)

    const buf = await buildVar({
      meta: { packageName: 'Aux.Stray', creator: 'Aux' },
      files: { 'Saves/scene/X.json': '{"atoms":[]}' },
    })
    // Drop a .var.disabled into aux — external tooling could have left this here.
    await placeVar(aux, 'Aux.Stray.1.var', buf, { disabled: true })

    await runScan(tmp.vamDir)

    const rows = getAllPackages().filter((r) => r.filename === 'Aux.Stray.1.var')
    expect(rows).toHaveLength(1)
    expect(rows[0].storage_state).toBe('offloaded')
    expect(rows[0].library_dir_id).toBe(auxId)

    // Stray .var.disabled must have been renamed to bare .var on disk.
    const auxFiles = await readdir(aux)
    expect(auxFiles).toContain('Aux.Stray.1.var')
    expect(auxFiles).not.toContain('Aux.Stray.1.var.disabled')
  })

  it('cross-dir collision: same canonical in main + aux → main wins (single row, main)', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    insertLibraryDir(aux)
    const buf = await buildVar({
      meta: { packageName: 'Dup.Pkg', creator: 'D' },
      files: { 'Saves/scene/d.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Dup.Pkg.1.var', buf)
    await placeVar(aux, 'Dup.Pkg.1.var', buf)
    await runScan(tmp.vamDir)
    const rows = getAllPackages().filter((r) => r.filename === 'Dup.Pkg.1.var')
    expect(rows).toHaveLength(1)
    expect(rows[0].library_dir_id).toBeNull()
  })

  it('offline aux dir does not prune packages that lived there', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    const buf = await buildVar({
      meta: { packageName: 'Off.Aux', creator: 'O' },
      files: { 'Saves/scene/o.json': '{"atoms":[]}' },
    })
    await placeVar(aux, 'Off.Aux.1.var', buf)
    await runScan(tmp.vamDir)
    expect(getAllPackages().find((r) => r.filename === 'Off.Aux.1.var')?.library_dir_id).toBe(auxId)
    await rm(aux, { recursive: true, force: true })
    await runScan(tmp.vamDir)
    const row = getAllPackages().find((r) => r.filename === 'Off.Aux.1.var')
    expect(row).toBeDefined()
  })

  it('unreachable aux path is skipped; main scan still succeeds', async () => {
    insertLibraryDir('/nonexistent/vam-aux-test-path-' + Date.now())
    const buf = await buildVar({
      meta: { packageName: 'Main.Ok', creator: 'M' },
      files: { 'Saves/scene/m.json': '{"atoms":[]}' },
    })
    await placeVar(tmp.addonPackages, 'Main.Ok.1.var', buf)
    await expect(runScan(tmp.vamDir)).resolves.toBeDefined()
    expect(getAllPackages().some((r) => r.filename === 'Main.Ok.1.var')).toBe(true)
  })

  it('single .var only in aux is offloaded', async () => {
    const aux = await mkAuxDir(tmp.vamDir)
    const auxId = insertLibraryDir(aux)
    const buf = await buildVar({
      meta: { packageName: 'Aux.Only', creator: 'A' },
      files: { 'Saves/scene/a.json': '{"atoms":[]}' },
    })
    await placeVar(aux, 'Aux.Only.1.var', buf)
    await runScan(tmp.vamDir)
    const row = getAllPackages().find((r) => r.filename === 'Aux.Only.1.var')
    expect(row?.storage_state).toBe('offloaded')
    expect(row?.library_dir_id).toBe(auxId)
  })
})

describe('runScan — local content', () => {
  it('loose .json under Saves/scene is owned by __local__', async () => {
    const sceneDir = join(tmp.savesDir, 'scene')
    await mkdir(sceneDir, { recursive: true })
    await writeFile(join(sceneDir, 'Loose.json'), JSON.stringify({ atoms: [] }))
    await runScan(tmp.vamDir)
    const c = getAllContents().filter((r) => r.internal_path.replace(/\\/g, '/').includes('Loose.json'))
    expect(c.length).toBeGreaterThan(0)
    expect(c[0].package_filename).toBe(LOCAL_PACKAGE_FILENAME)
    expect(c[0].type).toBe('scene')
  })

  it('loose .vap under Custom/Atom/Person/Appearance is owned by __local__', async () => {
    const lookDir = join(tmp.customDir, 'Atom', 'Person', 'Appearance')
    await mkdir(lookDir, { recursive: true })
    await writeFile(join(lookDir, 'Cool_Look.vap'), '<vap>')
    await runScan(tmp.vamDir)
    const c = getAllContents().find((r) => r.internal_path.endsWith('Cool_Look.vap'))
    expect(c?.package_filename).toBe(LOCAL_PACKAGE_FILENAME)
    expect(c?.type).toBe('look')
  })

  it('unchanged loose file is skipped on second local scan (stat gate)', async () => {
    const sceneDir = join(tmp.savesDir, 'scene')
    await mkdir(sceneDir, { recursive: true })
    await writeFile(join(sceneDir, 'Gate.json'), JSON.stringify({ atoms: [] }))
    await runScan(tmp.vamDir)
    const a = await runLocalScan(tmp.vamDir)
    expect(a.added).toBe(0)
  })

  it('touched loose file updates stored file_mtime (stat gate)', async () => {
    const sceneDir = join(tmp.savesDir, 'scene')
    await mkdir(sceneDir, { recursive: true })
    const fp = join(sceneDir, 'Touch.json')
    await writeFile(fp, JSON.stringify({ atoms: [] }))
    await runScan(tmp.vamDir)
    const before = getAllContents().find((r) => r.internal_path.endsWith('Touch.json'))
    const t = new Date(Date.now() + 80_000)
    await utimes(fp, t, t)
    await runLocalScan(tmp.vamDir)
    const after = getAllContents().find((r) => r.internal_path.endsWith('Touch.json'))
    expect(after?.file_mtime).not.toBe(before?.file_mtime)
    expect(Math.abs((after?.file_mtime ?? 0) - t.getTime() / 1000)).toBeLessThan(2)
  })
})
