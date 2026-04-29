import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkTempVamDir, openTestDatabase } from '../../test/fixtures/index.js'
import { closeDatabase, getDb } from './db.js'
import {
  buildFromDb,
  effectivePackageType,
  getFilteredContents,
  getFilteredPackages,
  getStatusCounts,
  getMissingDeps,
  getPackageDetail,
  getOrphanSet,
  getOrphanTotalSize,
  getTagCounts,
  getAuthorCounts,
  getStats,
} from './store.js'
import { setPackagesIndexForTests } from './hub/packages-json.js'

afterEach(() => {
  setPackagesIndexForTests({ index: null, fnIndex: null })
})

// ── buildFromDb aggregate tests ───────────────────────────────────────────────
//
// ⚠ NODE_MODULE_VERSION mismatch? Use `npm test` (Electron-as-Node).
// See `openTestDatabase` in `test/fixtures/index.js`.

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

function seedPackage(db, partial) {
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
    is_direct: 0,
    storage_state: 'enabled',
    library_dir_id: null,
    hub_resource_id: null,
    dep_refs: '[]',
    hub_tags: null,
    is_corrupted: 0,
    ...partial,
  }
  db.prepare(
    `INSERT INTO packages (filename, creator, package_name, version, type, title, description, license,
       size_bytes, file_mtime, is_direct, storage_state, library_dir_id, hub_resource_id, dep_refs, hub_tags, is_corrupted)
     VALUES (@filename, @creator, @package_name, @version, @type, @title, @description, @license,
       @size_bytes, @file_mtime, @is_direct, @storage_state, @library_dir_id, @hub_resource_id, @dep_refs, @hub_tags, @is_corrupted)`,
  ).run(row)
}

function seedContent(db, partial) {
  const row = {
    display_name: '',
    type: 'scene',
    thumbnail_path: null,
    person_atom_ids: null,
    file_mtime: 0,
    size_bytes: 0,
    ...partial,
  }
  db.prepare(
    `INSERT INTO contents (package_filename, internal_path, display_name, type, thumbnail_path,
       person_atom_ids, file_mtime, size_bytes)
     VALUES (@package_filename, @internal_path, @display_name, @type, @thumbnail_path,
       @person_atom_ids, @file_mtime, @size_bytes)`,
  ).run(row)
}

describe('buildFromDb — cross-version content dedup', () => {
  it('keeps the highest version of a (packageName, category, displayName) triple', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Author.Pkg.1.var',
      creator: 'Author',
      package_name: 'Author.Pkg',
      version: '1',
      is_direct: 1,
    })
    seedPackage(db, {
      filename: 'Author.Pkg.2.var',
      creator: 'Author',
      package_name: 'Author.Pkg',
      version: '2',
      is_direct: 1,
    })
    seedContent(db, {
      package_filename: 'Author.Pkg.1.var',
      internal_path: 'Saves/scene/Demo.json',
      display_name: 'Demo',
      type: 'scene',
    })
    seedContent(db, {
      package_filename: 'Author.Pkg.2.var',
      internal_path: 'Saves/scene/Demo.json',
      display_name: 'Demo',
      type: 'scene',
    })
    seedContent(db, {
      package_filename: 'Author.Pkg.1.var',
      internal_path: 'Saves/scene/OnlyInV1.json',
      display_name: 'OnlyInV1',
      type: 'scene',
    })

    buildFromDb()

    const items = getFilteredContents().filter((c) => c.packageName === 'Author.Pkg')
    const demoOwners = items.filter((c) => c.displayName === 'Demo').map((c) => c.packageFilename)
    expect(demoOwners).toEqual(['Author.Pkg.2.var'])
    const onlyInV1 = items.filter((c) => c.displayName === 'OnlyInV1').map((c) => c.packageFilename)
    expect(onlyInV1).toEqual(['Author.Pkg.1.var'])
  })

  it('tiebreak at equal numeric versions keeps the first item encountered in DB order', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Tie.Pkg.1.var',
      creator: 'T',
      package_name: 'Tie.Pkg',
      version: '1',
      is_direct: 1,
    })
    seedPackage(db, {
      filename: 'Tie.Pkg.01.var',
      creator: 'T',
      package_name: 'Tie.Pkg',
      version: '01',
      is_direct: 1,
    })
    seedContent(db, {
      package_filename: 'Tie.Pkg.1.var',
      internal_path: 'Saves/scene/x.json',
      display_name: 'Same',
      type: 'scene',
    })
    seedContent(db, {
      package_filename: 'Tie.Pkg.01.var',
      internal_path: 'Saves/scene/y.json',
      display_name: 'Same',
      type: 'scene',
    })
    buildFromDb()
    const items = getFilteredContents().filter((c) => c.packageName === 'Tie.Pkg' && c.displayName === 'Same')
    expect(items).toHaveLength(1)
    expect(items[0].packageFilename).toBe('Tie.Pkg.1.var')
  })

  it('dedup is skipped when the package group has only one version on disk', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Single.V.1.var',
      creator: 'S',
      package_name: 'Single.V',
      version: '1',
      is_direct: 1,
    })
    seedContent(db, {
      package_filename: 'Single.V.1.var',
      internal_path: 'Saves/scene/a.json',
      display_name: 'A',
      type: 'scene',
    })
    seedContent(db, {
      package_filename: 'Single.V.1.var',
      internal_path: 'Saves/scene/b.json',
      display_name: 'B',
      type: 'scene',
    })
    buildFromDb()
    expect(getFilteredContents().filter((c) => c.packageName === 'Single.V')).toHaveLength(2)
  })

  it('does not dedupe across categories with the same display name', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Mix.Pkg.1.var',
      creator: 'M',
      package_name: 'Mix.Pkg',
      version: '1',
      is_direct: 1,
    })
    seedPackage(db, {
      filename: 'Mix.Pkg.2.var',
      creator: 'M',
      package_name: 'Mix.Pkg',
      version: '2',
      is_direct: 1,
    })
    seedContent(db, {
      package_filename: 'Mix.Pkg.1.var',
      internal_path: 'Saves/scene/e.json',
      display_name: 'DupName',
      type: 'scene',
    })
    seedContent(db, {
      package_filename: 'Mix.Pkg.2.var',
      internal_path: 'Custom/Atom/Person/Appearance/e.vap',
      display_name: 'DupName',
      type: 'look',
    })
    buildFromDb()
    const dups = getFilteredContents().filter((c) => c.packageName === 'Mix.Pkg' && c.displayName === 'DupName')
    expect(dups).toHaveLength(2)
  })
})

describe('buildFromDb — graph aggregates', () => {
  it('removableSizeMap: exclusive chain; shared dep is not removable from one root alone', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Shared.D.1.var',
      package_name: 'Shared.D',
      version: '1',
      creator: 'S',
      is_direct: 0,
      size_bytes: 40,
      dep_refs: '[]',
    })
    seedPackage(db, {
      filename: 'Root.A.1.var',
      package_name: 'Root.A',
      version: '1',
      creator: 'R',
      is_direct: 1,
      size_bytes: 10,
      dep_refs: JSON.stringify(['Shared.D.1']),
    })
    seedPackage(db, {
      filename: 'Root.B.1.var',
      package_name: 'Root.B',
      version: '1',
      creator: 'R',
      is_direct: 1,
      size_bytes: 10,
      dep_refs: JSON.stringify(['Shared.D.1']),
    })
    buildFromDb()
    const a = getFilteredPackages().find((p) => p.filename === 'Root.A.1.var')
    const b = getFilteredPackages().find((p) => p.filename === 'Root.B.1.var')
    expect(a?.removableSize).toBe(0)
    expect(b?.removableSize).toBe(0)
  })

  it('removableSizeMap: linear non-direct chain is removable with the root', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Leaf.C.1.var',
      package_name: 'Leaf.C',
      version: '1',
      is_direct: 0,
      size_bytes: 5,
      dep_refs: '[]',
    })
    seedPackage(db, {
      filename: 'Mid.B.1.var',
      package_name: 'Mid.B',
      version: '1',
      is_direct: 0,
      size_bytes: 7,
      dep_refs: JSON.stringify(['Leaf.C.1']),
    })
    seedPackage(db, {
      filename: 'Head.A.1.var',
      package_name: 'Head.A',
      version: '1',
      is_direct: 1,
      size_bytes: 9,
      dep_refs: JSON.stringify(['Mid.B.1']),
    })
    buildFromDb()
    const head = getFilteredPackages().find((p) => p.filename === 'Head.A.1.var')
    expect(head?.removableSize).toBe(12)
  })

  it('transitiveMissingMap: cycles through resolved deps do not hang; missing refs accumulate', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'A.Cyc.1.var',
      package_name: 'A.Cyc',
      version: '1',
      is_direct: 1,
      dep_refs: JSON.stringify(['B.Cyc.1']),
    })
    seedPackage(db, {
      filename: 'B.Cyc.1.var',
      package_name: 'B.Cyc',
      version: '1',
      is_direct: 0,
      dep_refs: JSON.stringify(['A.Cyc.1']),
    })
    buildFromDb()
    const d = getPackageDetail('A.Cyc.1.var')
    expect(d.missingDepsTotal).toBe(0)
  })

  it('transitiveMissingMap: unions missing refs down a small DAG', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Tip.T.1.var',
      package_name: 'Tip.T',
      version: '1',
      is_direct: 0,
      dep_refs: JSON.stringify(['Missing.Z.1']),
    })
    seedPackage(db, {
      filename: 'Mid.M.1.var',
      package_name: 'Mid.M',
      version: '1',
      is_direct: 0,
      dep_refs: JSON.stringify(['Tip.T.1']),
    })
    seedPackage(db, {
      filename: 'Top.P.1.var',
      package_name: 'Top.P',
      version: '1',
      is_direct: 1,
      dep_refs: JSON.stringify(['Mid.M.1']),
    })
    buildFromDb()
    expect(getPackageDetail('Top.P.1.var').missingDepsTotal).toBeGreaterThanOrEqual(1)
  })

  it('orphanSet and orphan totalSize', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Orp.O.1.var',
      package_name: 'Orp.O',
      version: '1',
      is_direct: 0,
      size_bytes: 33,
      dep_refs: '[]',
    })
    buildFromDb()
    expect(getOrphanSet().has('Orp.O.1.var')).toBe(true)
    expect(getOrphanTotalSize()).toBeGreaterThanOrEqual(33)
  })

  it('aggregateMorphCountMap includes transitive dep morphs', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'DepMorph.D.1.var',
      package_name: 'DepMorph.D',
      version: '1',
      is_direct: 0,
      dep_refs: '[]',
    })
    seedPackage(db, {
      filename: 'RootMorph.R.1.var',
      package_name: 'RootMorph.R',
      version: '1',
      is_direct: 1,
      dep_refs: JSON.stringify(['DepMorph.D.1']),
    })
    seedContent(db, {
      package_filename: 'RootMorph.R.1.var',
      internal_path: 'Custom/Atom/Person/Morphs/a.vmi',
      display_name: 'a',
      type: 'morphBinary',
    })
    seedContent(db, {
      package_filename: 'DepMorph.D.1.var',
      internal_path: 'Custom/Atom/Person/Morphs/b.vmi',
      display_name: 'b',
      type: 'morphBinary',
    })
    buildFromDb()
    const p = getFilteredPackages().find((x) => x.filename === 'RootMorph.R.1.var')
    expect(p?.morphCount).toBe(2)
  })

  it('transitiveDepsCountMap lists dep count on package summary', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'OnlyLeaf.L.1.var',
      package_name: 'OnlyLeaf.L',
      version: '1',
      is_direct: 0,
      dep_refs: '[]',
    })
    seedPackage(db, {
      filename: 'HasDeps.H.1.var',
      package_name: 'HasDeps.H',
      version: '1',
      is_direct: 1,
      dep_refs: JSON.stringify(['OnlyLeaf.L.1']),
    })
    buildFromDb()
    const p = getFilteredPackages().find((x) => x.filename === 'HasDeps.H.1.var')
    expect(p?.depCount).toBeGreaterThanOrEqual(1)
  })
})

describe('buildFromDb — counts / filters', () => {
  it('getStatusCounts direct vs dependency and excludes __local__ from tallies', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Direct.D.1.var',
      package_name: 'Direct.D',
      version: '1',
      is_direct: 1,
    })
    seedPackage(db, {
      filename: 'DepOnly.X.1.var',
      package_name: 'DepOnly.X',
      version: '1',
      is_direct: 0,
    })
    buildFromDb()
    const s = getStatusCounts()
    expect(s.direct).toBe(1)
    expect(s.dependency).toBe(1)
  })

  it('getStatusCounts.broken includes corrupted packages', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Broke.B.1.var',
      package_name: 'Broke.B',
      version: '1',
      is_direct: 1,
      is_corrupted: 1,
    })
    buildFromDb()
    expect(getStatusCounts().broken).toBeGreaterThanOrEqual(1)
  })

  it('getStatusCounts.missingUnique groups missing dep refs by packageName', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Need.N.1.var',
      package_name: 'Need.N',
      version: '1',
      is_direct: 1,
      dep_refs: JSON.stringify(['Ghost.Unk.999']),
    })
    buildFromDb()
    expect(getStatusCounts().missingUnique).toBeGreaterThanOrEqual(1)
  })

  it('getMissingDeps: neededBy, isFallback for min-floor fallback resolution', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Holder.H.1.var',
      package_name: 'Holder.H',
      version: '1',
      is_direct: 1,
      dep_refs: JSON.stringify(['Floor.Pkg.min50']),
    })
    seedPackage(db, {
      filename: 'Floor.Pkg.1.var',
      package_name: 'Floor.Pkg',
      version: '1',
      is_direct: 0,
      dep_refs: '[]',
    })
    buildFromDb()
    const rows = getMissingDeps()
    const floor = rows.find((r) => r.ref === 'Floor.Pkg.min50')
    expect(floor?.isFallback).toBe(true)
    expect(floor?.neededBy.length).toBeGreaterThanOrEqual(1)
  })

  it('getMissingDeps prefers exact hub filename when hubFilenameIndex is provided', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Miss.M.1.var',
      package_name: 'Miss.M',
      version: '1',
      is_direct: 1,
      dep_refs: JSON.stringify(['Exact.Dep.7']),
    })
    buildFromDb()
    const hubPackages = new Map([['Exact.Dep', { version: 9, filename: 'Exact.Dep.9.var', resourceId: 'g' }]])
    const hubFiles = new Map([['Exact.Dep.7.var', 'rid7']])
    const row = getMissingDeps(hubPackages, hubFiles).find((r) => r.ref === 'Exact.Dep.7')
    expect(row?.hub?.isExact).toBe(true)
    expect(row?.hub?.resourceId).toBe('rid7')
  })

  it('getMissingDeps falls back to hub group when exact filename missing', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'FallMe.F.1.var',
      package_name: 'FallMe.F',
      version: '1',
      is_direct: 1,
      dep_refs: JSON.stringify(['Missing.Group.3']),
    })
    buildFromDb()
    const hubPackages = new Map([
      ['Missing.Group', { version: 10, filename: 'Missing.Group.10.var', resourceId: 'ridg' }],
    ])
    const row = getMissingDeps(hubPackages, new Map()).find((r) => r.ref === 'Missing.Group.3')
    expect(row?.hub?.isExact).toBe(false)
    expect(row?.hub?.filename).toBe('Missing.Group.10.var')
  })

  it('effectivePackageType prefers type_override over type', () => {
    expect(
      effectivePackageType({
        type: 'Looks',
        type_override: 'Plugins',
      }),
    ).toBe('Plugins')
    expect(effectivePackageType({ type: 'Looks', type_override: null })).toBe('Looks')
  })

  it('tagCounts and authorCounts exclude __local__ sentinel', async () => {
    const db = getDb()
    db.prepare('UPDATE packages SET creator = ?, hub_tags = ? WHERE filename = ?').run(
      'ShouldNotAppear',
      'Alpha,Beta',
      '__local__',
    )
    seedPackage(db, {
      filename: 'Real.U.1.var',
      package_name: 'Real.U',
      version: '1',
      creator: 'Alice',
      is_direct: 1,
      hub_tags: 'Gamma',
    })
    buildFromDb()
    const tc = getTagCounts()
    const ac = getAuthorCounts()
    expect(ac.Alice).toBe(1)
    expect(ac.ShouldNotAppear).toBeUndefined()
    expect(tc.gamma).toBe(1)
  })

  it('getStats.contentByType counts gallery-visible content categories', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Content.C.1.var',
      package_name: 'Content.C',
      version: '1',
      is_direct: 1,
    })
    seedContent(db, {
      package_filename: 'Content.C.1.var',
      internal_path: 'Saves/scene/x.json',
      display_name: 'x',
      type: 'scene',
    })
    buildFromDb()
    expect(getStats().contentByType.Scenes).toBeGreaterThanOrEqual(1)
  })
})

describe('buildFromDb — package summary enrichment', () => {
  it('noLookPresetTag when type is Looks but no look items', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'LooksEmpty.L.1.var',
      package_name: 'LooksEmpty.L',
      version: '1',
      is_direct: 1,
      type: 'Looks',
    })
    buildFromDb()
    const p = getFilteredPackages().find((x) => x.filename === 'LooksEmpty.L.1.var')
    expect(p?.noLookPresetTag).toBe(true)
  })

  it('isOrphan is true only for deps with no dependents', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'LOrph.L.1.var',
      package_name: 'LOrph.L',
      version: '1',
      is_direct: 0,
      dep_refs: '[]',
    })
    buildFromDb()
    const leaf = getFilteredPackages().find((p) => p.filename === 'LOrph.L.1.var')
    expect(leaf?.isOrphan).toBe(true)
    expect(leaf?.isCascadeOrphan).toBe(false)
  })

  it('removableSize on summary for packages with removable dep chain', async () => {
    const db = getDb()
    seedPackage(db, {
      filename: 'Rem.B.1.var',
      package_name: 'Rem.B',
      version: '1',
      is_direct: 0,
      size_bytes: 15,
      dep_refs: '[]',
    })
    seedPackage(db, {
      filename: 'Rem.A.1.var',
      package_name: 'Rem.A',
      version: '1',
      is_direct: 1,
      size_bytes: 20,
      dep_refs: JSON.stringify(['Rem.B.1']),
    })
    buildFromDb()
    const p = getFilteredPackages().find((x) => x.filename === 'Rem.A.1.var')
    expect(p?.removableSize).toBe(15)
  })
})
