import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  originalFolderFromSubpath,
  subpathFromOriginalFolder,
  writeSidecar,
  readSidecarSubpath,
  removeSidecar,
} from './browser-assist-sidecar.js'

describe('OriginalFolder ⇄ subpath mapping', () => {
  it('maps a subpath to a BrowserAssist OriginalFolder rooted at AddonPackages with backslashes', () => {
    expect(originalFolderFromSubpath('')).toBe('AddonPackages')
    expect(originalFolderFromSubpath('Creator')).toBe('AddonPackages\\Creator')
    expect(originalFolderFromSubpath('Creator/Bundle')).toBe('AddonPackages\\Creator\\Bundle')
  })

  it('parses an OriginalFolder back to a subpath, dropping the AddonPackages root (either slash style)', () => {
    expect(subpathFromOriginalFolder('AddonPackages')).toBe('')
    expect(subpathFromOriginalFolder('AddonPackages\\Creator\\Bundle')).toBe('Creator/Bundle')
    expect(subpathFromOriginalFolder('AddonPackages/Creator/Bundle')).toBe('Creator/Bundle')
    expect(subpathFromOriginalFolder('addonpackages\\Creator')).toBe('Creator')
  })

  it('round-trips a nested subpath', () => {
    expect(subpathFromOriginalFolder(originalFolderFromSubpath('A/B/C'))).toBe('A/B/C')
  })

  it('tolerates missing / non-string OriginalFolder values', () => {
    expect(subpathFromOriginalFolder(undefined)).toBe('')
    expect(subpathFromOriginalFolder('')).toBe('')
    expect(subpathFromOriginalFolder(42)).toBe('')
  })

  it('rejects a sidecar that would escape AddonPackages, degrading to a root restore', () => {
    expect(subpathFromOriginalFolder('AddonPackages\\..\\..\\Windows')).toBe('')
    expect(subpathFromOriginalFolder('..\\..\\Secret')).toBe('')
    expect(subpathFromOriginalFolder('AddonPackages\\Creator\\..\\..\\..\\x')).toBe('')
  })

  it('normalizes a contained `..` instead of dropping to root', () => {
    expect(subpathFromOriginalFolder('AddonPackages\\Creator\\Sub\\..\\Other')).toBe('Creator/Other')
  })
})

describe('sidecar write / read / remove', () => {
  let dir
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ba-sidecar-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes a sidecar for a nested package and reads its restore subpath back', async () => {
    const varPath = join(dir, 'Creator.Pkg.1.var')
    await writeFile(varPath, 'bytes')
    expect(await writeSidecar(varPath, 'Creator/Bundle')).toBe(true)

    const raw = JSON.parse(await readFile(varPath + '.json', 'utf8'))
    expect(raw.OriginalFolder).toBe('AddonPackages\\Creator\\Bundle')
    expect(raw).toHaveProperty('BAMajorVersion')
    expect(raw).toHaveProperty('BAMinorVersion')
    expect(raw).toHaveProperty('BAFixVersion')

    expect(await readSidecarSubpath(varPath)).toBe('Creator/Bundle')
  })

  it('writes no sidecar for a root package (BrowserAssist restores the root by default)', async () => {
    const varPath = join(dir, 'Creator.Pkg.1.var')
    await writeFile(varPath, 'bytes')
    expect(await writeSidecar(varPath, '')).toBe(false)
    expect(await readSidecarSubpath(varPath)).toBeNull()
  })

  it('reads null when the sidecar is absent or malformed', async () => {
    const varPath = join(dir, 'X.Y.1.var')
    expect(await readSidecarSubpath(varPath)).toBeNull()
    await writeFile(varPath + '.json', 'not json{')
    expect(await readSidecarSubpath(varPath)).toBeNull()
  })

  it('honors a sidecar OriginalFolder pointing at the AddonPackages root (empty subpath)', async () => {
    const varPath = join(dir, 'R.R.1.var')
    await writeFile(varPath + '.json', JSON.stringify({ OriginalFolder: 'AddonPackages' }))
    expect(await readSidecarSubpath(varPath)).toBe('')
  })

  it('removes an existing sidecar and reports absence on a second call', async () => {
    const varPath = join(dir, 'Z.Z.1.var')
    await writeFile(varPath, 'bytes')
    await writeSidecar(varPath, 'Sub')
    expect(await removeSidecar(varPath)).toBe(true)
    expect(await removeSidecar(varPath)).toBe(false)
    expect(await readSidecarSubpath(varPath)).toBeNull()
  })
})
