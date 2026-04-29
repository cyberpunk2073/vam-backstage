import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'path'
import { writeFile, readdir } from 'fs/promises'
import { readVar, extractFile, extractFiles, parseVarFilename, canonicalVarFilename } from './var-reader.js'
import { buildVar, mkTempVamDir } from '../../../test/fixtures/index.js'

// ── filename helpers (no FS) ──────────────────────────────────────────────────

describe('parseVarFilename', () => {
  it('parses a standard filename', () => {
    expect(parseVarFilename('AcidBubbles.Timeline.249.var')).toEqual({
      creator: 'AcidBubbles',
      packageName: 'AcidBubbles.Timeline',
      version: '249',
    })
  })

  it('strips .disabled before parsing and returns the full record', () => {
    expect(parseVarFilename('Author.Pkg.5.var.disabled')).toEqual({
      creator: 'Author',
      packageName: 'Author.Pkg',
      version: '5',
    })
  })

  it('strips .disabled case-insensitively (.DISABLED, .Disabled)', () => {
    expect(parseVarFilename('Author.Pkg.5.var.DISABLED')?.version).toBe('5')
    expect(parseVarFilename('Author.Pkg.5.var.Disabled')?.version).toBe('5')
    // and the .var part is also case-insensitive
    expect(parseVarFilename('Author.Pkg.5.VAR.disabled')?.version).toBe('5')
  })

  it('strips .disabled with multi-dot package names', () => {
    expect(parseVarFilename('A.B.C.42.var.disabled')).toEqual({
      creator: 'A',
      packageName: 'A.B.C',
      version: '42',
    })
  })

  it('rejects .latest token (load-bearing — these must never become DB rows)', () => {
    expect(parseVarFilename('Author.Pkg.latest.var')).toBeNull()
    expect(parseVarFilename('Author.Pkg.LATEST.var')).toBeNull()
    // also when wrapped in .var.disabled
    expect(parseVarFilename('Author.Pkg.latest.var.disabled')).toBeNull()
  })

  it('rejects .min5 / .minN tokens (any case)', () => {
    expect(parseVarFilename('Author.Pkg.min5.var')).toBeNull()
    expect(parseVarFilename('X.Y.min0.var')).toBeNull()
    expect(parseVarFilename('A.B.MIN10.var')).toBeNull()
    expect(parseVarFilename('A.B.min7.var.disabled')).toBeNull()
  })

  it('rejects 2-segment filenames (no version segment)', () => {
    expect(parseVarFilename('OnlyTwo.var')).toBeNull()
    expect(parseVarFilename('OnlyTwo.var.disabled')).toBeNull()
  })

  it('handles multi-dot package names', () => {
    expect(parseVarFilename('A.B.C.123.var')).toEqual({
      creator: 'A',
      packageName: 'A.B.C',
      version: '123',
    })
  })

  it('rejects non-numeric versions (beta, alpha, negatives, mixed)', () => {
    expect(parseVarFilename('Author.Pkg.beta.var')).toBeNull()
    expect(parseVarFilename('Author.Pkg.alpha.var')).toBeNull()
    expect(parseVarFilename('Author.Pkg.-1.var')).toBeNull()
    expect(parseVarFilename('Author.Pkg.1a.var')).toBeNull()
  })
})

describe('canonicalVarFilename', () => {
  it('strips trailing .disabled', () => {
    expect(canonicalVarFilename('Foo.Bar.1.var.disabled')).toBe('Foo.Bar.1.var')
  })

  it('is case-insensitive on the .disabled suffix', () => {
    expect(canonicalVarFilename('Foo.Bar.1.var.DISABLED')).toBe('Foo.Bar.1.var')
    expect(canonicalVarFilename('Foo.Bar.1.var.Disabled')).toBe('Foo.Bar.1.var')
  })

  it('returns the input unchanged when already canonical', () => {
    expect(canonicalVarFilename('Foo.Bar.1.var')).toBe('Foo.Bar.1.var')
  })
})

// ── readVar against fixture ZIPs ──────────────────────────────────────────────
//
// yauzl's API is event-driven; close-too-early or wrong 'end' ordering loses
// entries. JSON5 fallback only fires on malformed meta and almost no real
// package exercises it, so it can silently break.

describe('readVar', () => {
  let tmp
  beforeAll(async () => {
    tmp = await mkTempVamDir()
  })
  afterAll(async () => {
    if (tmp) await tmp.cleanup()
  })

  it('parses a standard meta.json and lists files', async () => {
    const buf = await buildVar({
      meta: { packageName: 'Author.Pkg', creator: 'Author', licenseType: 'CC BY' },
      files: { 'Saves/scene/Demo.json': '{"atoms":[]}' },
    })
    const path = join(tmp.addonPackages, 'Author.Pkg.1.var')
    await writeFile(path, buf)

    const result = await readVar(path)
    expect(result.meta).toMatchObject({ packageName: 'Author.Pkg', licenseType: 'CC BY' })
    expect(result.fileList.map((f) => f.path)).toContain('Saves/scene/Demo.json')
  })

  it('falls back to JSON5 for trailing-comma meta.json (VaM SimpleJSON dialect)', async () => {
    // Strict JSON.parse would choke on the trailing comma; JSON5 must rescue it.
    const metaRaw = '{\n  "packageName": "Author.Pkg",\n  "licenseType": "FC",\n}\n'
    const buf = await buildVar({ metaRaw, files: {} })
    const path = join(tmp.addonPackages, 'Author.Pkg.2.var')
    await writeFile(path, buf)

    const result = await readVar(path)
    expect(result.meta).toMatchObject({ packageName: 'Author.Pkg', licenseType: 'FC' })
  })

  it('returns meta:null when meta.json is absent', async () => {
    const buf = await buildVar({ files: { 'Saves/scene/Z.json': '{}' } })
    const path = join(tmp.addonPackages, 'NoMeta.1.var')
    await writeFile(path, buf)
    const result = await readVar(path)
    expect(result.meta).toBeNull()
    expect(result.fileList.some((f) => f.path === 'Saves/scene/Z.json')).toBe(true)
  })

  it('returns meta:null when meta.json is not valid JSON', async () => {
    const buf = await buildVar({ metaRaw: '\x00\xff\xfe not json {{{', files: {} })
    const path = join(tmp.addonPackages, 'BadMeta.1.var')
    await writeFile(path, buf)
    const result = await readVar(path)
    expect(result.meta).toBeNull()
  })

  it('with extractSceneJsons populates extracts for scene and legacyLook', async () => {
    const sceneBody = '{"atoms":[]}'
    const buf = await buildVar({
      meta: { packageName: 'Scene.Pkg' },
      files: {
        'Saves/scene/S1.json': sceneBody,
        'Saves/Person/Appearance/Legacy.json': '{"atoms":[]}',
        'Custom/Atom/Person/Morphs/x.vmi': 'bin',
      },
    })
    const path = join(tmp.addonPackages, 'Scene.Pkg.1.var')
    await writeFile(path, buf)
    const result = await readVar(path, { extractSceneJsons: true })
    expect(result.extracts.get('Saves/scene/S1.json')?.toString()).toBe(sceneBody)
    expect(result.extracts.has('Custom/Atom/Person/Morphs/x.vmi')).toBe(false)
    expect(result.extracts.has('Saves/Person/Appearance/Legacy.json')).toBe(true)
  })

  it('with extractSceneJsons does not populate non scene/legacyLook types', async () => {
    const buf = await buildVar({
      meta: { packageName: 'P' },
      files: {
        'Custom/Atom/Person/Appearance/Look.vap': 'vap',
        'Custom/SubScene/Room.json': '{}',
      },
    })
    const path = join(tmp.addonPackages, 'P.1.var')
    await writeFile(path, buf)
    const result = await readVar(path, { extractSceneJsons: true })
    expect(result.extracts?.size ?? 0).toBe(0)
  })

  it('handles a ZIP with no file entries', async () => {
    const buf = await buildVar({ files: {} })
    const path = join(tmp.addonPackages, 'Empty.1.var')
    await writeFile(path, buf)
    const result = await readVar(path)
    expect(result.meta).toBeNull()
    expect(result.fileList).toHaveLength(0)
  })
})

describe('extractFile / extractFiles', () => {
  let tmp
  beforeAll(async () => {
    tmp = await mkTempVamDir()
  })
  afterAll(async () => {
    if (tmp) await tmp.cleanup()
  })

  it('extractFile returns null when path is not present', async () => {
    const buf = await buildVar({ meta: { packageName: 'Q' }, files: { 'a.txt': 'x' } })
    const path = join(tmp.addonPackages, 'Q.1.var')
    await writeFile(path, buf)
    expect(await extractFile(path, 'nope.txt')).toBeNull()
  })

  it('extractFiles returns only found paths', async () => {
    const buf = await buildVar({ files: { 'u.txt': '1', 'v.txt': '2' } })
    const path = join(tmp.addonPackages, 'R.1.var')
    await writeFile(path, buf)
    const map = await extractFiles(path, ['u.txt', 'ghost.txt', 'v.txt'])
    expect([...map.keys()].sort()).toEqual(['u.txt', 'v.txt'])
    expect(map.get('u.txt')?.toString()).toBe('1')
  })

  it('extractFiles stops after all wanted paths are found (many irrelevant entries first)', async () => {
    const files = {}
    for (let i = 0; i < 30; i++) files[`noise/${i}.txt`] = 'n'
    files['needle.txt'] = 'found'
    const buf = await buildVar({ files })
    const path = join(tmp.addonPackages, 'Big.1.var')
    await writeFile(path, buf)
    const map = await extractFiles(path, ['needle.txt'])
    expect(map.get('needle.txt')?.toString()).toBe('found')
  })

  it('extractFiles with empty internalPaths returns empty Map without throwing', async () => {
    const buf = await buildVar({ files: { 'a.txt': 'z' } })
    const path = join(tmp.addonPackages, 'S.1.var')
    await writeFile(path, buf)
    const map = await extractFiles(path, [])
    expect(map.size).toBe(0)
  })

  // Sanity that the fixture infrastructure is sound — keeps the suite from
  // silently no-op'ing if the helper ever regresses.
  it('fixture builds a valid ZIP that yauzl can open', async () => {
    const buf = await buildVar({ meta: { packageName: 'X.Y' }, files: { 'a.txt': 'hello' } })
    const path = join(tmp.addonPackages, 'X.Y.1.var')
    await writeFile(path, buf)
    const found = await extractFile(path, 'a.txt')
    expect(found?.toString()).toBe('hello')
    // Multi-path single-pass returns the same buffer
    const map = await extractFiles(path, ['a.txt', 'missing.txt'])
    expect(map.get('a.txt')?.toString()).toBe('hello')
    expect(map.has('missing.txt')).toBe(false)
    // Cleanup so afterAll's rm doesn't trip over missing dir on weird FS
    expect((await readdir(tmp.addonPackages)).length).toBeGreaterThan(0)
  })
})
