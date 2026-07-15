import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const storeMocks = vi.hoisted(() => ({
  getPackageIndex: vi.fn(() => new Map()),
  getContentByPackage: vi.fn(() => new Map()),
  effectivePackageType: vi.fn(() => 'Scenes'),
  getLabelsByPackageMap: vi.fn(() => new Map()),
  getLabelsByContentMap: vi.fn(() => new Map()),
  getLabelNameById: vi.fn(() => null),
}))

vi.mock('./store.js', () => storeMocks)

import { syncBrowserAssistTags, browserAssistSettingsDir } from './browser-assist.js'

const BA_REL = ['Saves', 'PluginData', 'JayJayWon', 'BrowserAssist', 'VARResourcesUserData']

function shardPayload(resources) {
  return {
    VARUserDataStoreFormat: '3',
    BAMajorVersion: '1',
    BAMinorVersion: '42',
    BAFixVersion: '0',
    resources,
  }
}

describe('syncBrowserAssistTags — package-level labels', () => {
  let vamDir
  let shardDir

  beforeEach(async () => {
    vamDir = await mkdtemp(join(tmpdir(), 'ba-sync-'))
    shardDir = join(vamDir, ...BA_REL)
    await mkdir(shardDir, { recursive: true })

    for (const fn of Object.values(storeMocks)) fn.mockReset()
    storeMocks.getPackageIndex.mockReturnValue(new Map())
    storeMocks.getContentByPackage.mockReturnValue(new Map())
    storeMocks.effectivePackageType.mockReturnValue('Scenes')
    storeMocks.getLabelsByPackageMap.mockReturnValue(new Map())
    storeMocks.getLabelsByContentMap.mockReturnValue(new Map())
    storeMocks.getLabelNameById.mockReturnValue(null)
  })

  afterEach(async () => {
    await rm(vamDir, { recursive: true, force: true })
  })

  async function writeShard(resources) {
    const path = join(shardDir, 'VARResourcesData0001.userData')
    await writeFile(path, JSON.stringify(shardPayload(resources), null, 3) + '\n', 'utf8')
    return path
  }

  function seedPackage({ filename, packageName, labelIds = [] }) {
    const pkgIndex = storeMocks.getPackageIndex()
    pkgIndex.set(filename, { package_name: packageName, filename })
    storeMocks.getPackageIndex.mockReturnValue(pkgIndex)

    const byPkg = storeMocks.getLabelsByPackageMap()
    byPkg.set(filename, labelIds)
    storeMocks.getLabelsByPackageMap.mockReturnValue(byPkg)
  }

  it('writes Label-category tags onto package rows with empty resourceFullFileName', async () => {
    seedPackage({
      filename: 'CuddleMocap.023-Witch-Seduction.1.var',
      packageName: 'CuddleMocap.023-Witch-Seduction',
      labelIds: [1, 2],
    })
    storeMocks.getLabelNameById.mockImplementation((id) => ({ 1: 'favorites', 2: 'nsfw' })[id] ?? null)

    const shardPath = await writeShard([
      {
        creatorName: 'CuddleMocap',
        packageName: '023-Witch-Seduction',
        resourceFullFileName: '',
        baNew: 'true',
        Tags: [{ tagName: 'vartag', tagCategory: 'User' }],
      },
    ])

    const result = await syncBrowserAssistTags(vamDir)
    expect(result.errors).toEqual([])
    expect(result.tagsUpdated).toBe(1)
    expect(result.shardsWritten).toBe(1)

    const written = JSON.parse(await readFile(shardPath, 'utf8'))
    expect(written.resources[0].Tags).toEqual([
      { tagName: 'vartag', tagCategory: 'User' },
      { tagName: 'favorites', tagCategory: 'Label' },
      { tagName: 'nsfw', tagCategory: 'Label' },
    ])
  })

  it('strips stale Label tags when the package no longer has labels', async () => {
    seedPackage({
      filename: 'A.B.1.var',
      packageName: 'A.B',
      labelIds: [],
    })

    const shardPath = await writeShard([
      {
        creatorName: 'A',
        packageName: 'B',
        resourceFullFileName: '',
        Tags: [
          { tagName: 'keep-me', tagCategory: 'User' },
          { tagName: 'gone', tagCategory: 'Label' },
        ],
      },
    ])

    const result = await syncBrowserAssistTags(vamDir)
    expect(result.tagsUpdated).toBe(1)

    const written = JSON.parse(await readFile(shardPath, 'utf8'))
    expect(written.resources[0].Tags).toEqual([{ tagName: 'keep-me', tagCategory: 'User' }])
  })

  it('unions labels across installed versions of the same package', async () => {
    seedPackage({ filename: 'A.B.1.var', packageName: 'A.B', labelIds: [1] })
    seedPackage({ filename: 'A.B.2.var', packageName: 'A.B', labelIds: [2] })
    storeMocks.getLabelNameById.mockImplementation((id) => ({ 1: 'alpha', 2: 'beta' })[id] ?? null)

    const shardPath = await writeShard([
      {
        creatorName: 'A',
        packageName: 'B',
        resourceFullFileName: '',
        Tags: [],
      },
    ])

    await syncBrowserAssistTags(vamDir)
    const written = JSON.parse(await readFile(shardPath, 'utf8'))
    expect(written.resources[0].Tags).toEqual([
      { tagName: 'alpha', tagCategory: 'Label' },
      { tagName: 'beta', tagCategory: 'Label' },
    ])
  })

  it('skips package rows with no local DB match', async () => {
    seedPackage({ filename: 'Known.Pkg.1.var', packageName: 'Known.Pkg', labelIds: [1] })
    storeMocks.getLabelNameById.mockReturnValue('x')

    await writeShard([
      {
        creatorName: 'Unknown',
        packageName: 'Pkg',
        resourceFullFileName: '',
        Tags: [],
      },
    ])

    const result = await syncBrowserAssistTags(vamDir)
    expect(result.skippedNoMatch).toBe(1)
    expect(result.tagsUpdated).toBe(0)
    expect(result.shardsWritten).toBe(0)
  })

  it('still syncs content-level labels alongside package rows', async () => {
    seedPackage({
      filename: 'A.B.1.var',
      packageName: 'A.B',
      labelIds: [1],
    })
    storeMocks.getContentByPackage.mockReturnValue(
      new Map([['A.B.1.var', [{ internal_path: 'Saves/scene/foo.json', type: 'scene' }]]]),
    )
    storeMocks.getLabelsByContentMap.mockReturnValue(new Map([['A.B.1.var\0Saves/scene/foo.json', [2]]]))
    storeMocks.getLabelNameById.mockImplementation((id) => ({ 1: 'pkg', 2: 'own' })[id] ?? null)
    storeMocks.effectivePackageType.mockReturnValue('Scenes')

    const shardPath = await writeShard([
      {
        creatorName: 'A',
        packageName: 'B',
        resourceFullFileName: '',
        Tags: [],
      },
      {
        creatorName: 'A',
        packageName: 'B',
        resourceFullFileName: 'Saves/scene/foo.json',
        Tags: [],
      },
    ])

    const result = await syncBrowserAssistTags(vamDir)
    expect(result.tagsUpdated).toBe(2)

    const written = JSON.parse(await readFile(shardPath, 'utf8'))
    expect(written.resources[0].Tags).toEqual([{ tagName: 'pkg', tagCategory: 'Label' }])
    expect(written.resources[1].Tags).toEqual([
      { tagName: 'scene-real', tagCategory: 'User' },
      { tagName: 'own', tagCategory: 'Label' },
      { tagName: 'pkg', tagCategory: 'Label' },
    ])
  })

  it('reports a clear error when the BrowserAssist directory is missing', async () => {
    const result = await syncBrowserAssistTags(join(vamDir, 'missing'))
    expect(result.shardsRead).toBe(0)
    expect(result.errors[0]).toMatch(/BrowserAssist directory not found/)
  })

  it('resolves the expected settings directory under vamDir', () => {
    expect(browserAssistSettingsDir('/vam')).toBe(join('/vam', ...BA_REL))
  })
})
