import { describe, it, expect, afterEach } from 'vitest'
import { parsePackageEntry, buildIndexes, checkUpdatesFromIndex, setPackagesIndexForTests } from './packages-json.js'

afterEach(() => {
  // Module-level packagesIndex would otherwise leak between tests.
  setPackagesIndexForTests({ index: null, fnIndex: null })
})

// ── parsePackageEntry / buildIndexes (5b) ──────────────────────────────────────
//
// packages.json is `{ "Author.Pkg.123.var": "<resourceId>", ... }`.
// `parsePackageEntry` splits the key into `{ packageName, version: <int> }`
// (or null for malformed keys). `buildIndexes` builds two maps:
//   - `index` keyed by packageName, holding the *highest numeric version* per group
//   - `fnIndex` keyed by every listed filename → resourceId
// Non-numeric versions are dropped from `index` (so a hypothetical
// "Foo.Bar.latest.var" can't pollute the package-grouping) but they MUST stay
// in `fnIndex` because the renderer still routes by exact filename.

describe('parsePackageEntry', () => {
  it('parses a standard 3-segment key', () => {
    expect(parsePackageEntry('Author.Pkg.42.var')).toEqual({ packageName: 'Author.Pkg', version: 42 })
  })

  it('returns null for non-numeric version', () => {
    expect(parsePackageEntry('Author.Pkg.latest.var')).toBeNull()
  })

  it('parses multi-dot package names', () => {
    expect(parsePackageEntry('A.B.C.123.var')).toEqual({ packageName: 'A.B.C', version: 123 })
  })

  it('returns null for keys with fewer than 3 segments', () => {
    expect(parsePackageEntry('Only.Two.var')).toBeNull()
    expect(parsePackageEntry('Single.var')).toBeNull()
  })

  it('accepts the .var extension case-insensitively', () => {
    expect(parsePackageEntry('Author.Pkg.1.VAR')).toEqual({ packageName: 'Author.Pkg', version: 1 })
    expect(parsePackageEntry('X.Y.2.Var')).toEqual({ packageName: 'X.Y', version: 2 })
  })
})

describe('buildIndexes', () => {
  it('keeps the highest numeric version per group in `index`', () => {
    const { index } = buildIndexes({
      'Foo.Bar.1.var': 'r1',
      'Foo.Bar.10.var': 'r10',
      'Foo.Bar.2.var': 'r2',
    })
    expect(index.get('Foo.Bar')).toEqual({ version: 10, filename: 'Foo.Bar.10.var', resourceId: 'r10' })
  })

  it('compares versions numerically, not lexicographically', () => {
    // Lexicographic would put "9" > "10"; numeric comparison must win.
    const { index } = buildIndexes({
      'A.B.9.var': 'r9',
      'A.B.10.var': 'r10',
    })
    expect(index.get('A.B').version).toBe(10)
  })

  it('excludes non-numeric keys from `index` but keeps them in `fnIndex`', () => {
    const { index, fnIndex } = buildIndexes({
      'Foo.Bar.5.var': 'r5',
      'Foo.Bar.latest.var': 'rlatest',
    })
    expect(index.has('Foo.Bar')).toBe(true)
    expect(index.get('Foo.Bar').version).toBe(5)
    // Both filenames must be reachable by exact-name lookup
    expect(fnIndex.get('Foo.Bar.5.var')).toBe('r5')
    expect(fnIndex.get('Foo.Bar.latest.var')).toBe('rlatest')
  })

  it('handles multi-dot package names in index', () => {
    const { index } = buildIndexes({
      'My.Cool.Package.99.var': 'rid',
    })
    expect(index.get('My.Cool.Package')).toEqual({ version: 99, filename: 'My.Cool.Package.99.var', resourceId: 'rid' })
  })

  it('on equal numeric versions keeps the first entry (stable tie)', () => {
    const { index } = buildIndexes({
      'Foo.Bar.05.var': 'first',
      'Foo.Bar.5.var': 'second',
    })
    const row = index.get('Foo.Bar')
    expect(row.version).toBe(5)
    // Insertion order: both parse to 5; second does not beat first (>), so first wins.
    expect(row.resourceId).toBe('first')
  })
})

// ── checkUpdatesFromIndex (5c) ─────────────────────────────────────────────────
//
// Cross-references the local `packageIndex` / `groupIndex` / `forwardDeps`
// against a hub `packagesIndex` (the result of `buildIndexes(...).index`).
// The hub state lives at module scope; tests seed it via the test-only
// `setPackagesIndexForTests` export. afterEach clears it.
//
// Two pass types:
//   1. Direct updates — for each direct package, pick the highest installed
//      version, compare to CDN. CDN newer → update entry. If a *newer* version
//      of the same group is locally installed (e.g. dragged in as a dep),
//      `localNewerFilename` is set so the UI navigates rather than re-downloading.
//   2. `.latest`-dep updates — for forward-dep refs resolved via `.latest`, if
//      the CDN moved past what we resolved to → flag with `isDepUpdate: true`
//      and a `neededBy` array.

/** Build a minimal package row sufficient for checkUpdatesFromIndex. */
function makePkg(filename, { is_direct = 1, version = null } = {}) {
  const stem = filename.replace(/\.var$/, '')
  const parts = stem.split('.')
  return {
    filename,
    package_name: parts.slice(0, -1).join('.'),
    version: version ?? parts[parts.length - 1],
    is_direct,
  }
}

/** Build a packageIndex / groupIndex pair from filenames; matches store.js shape. */
function indexes(filenames, opts = {}) {
  const packageIndex = new Map()
  const groupIndex = new Map()
  for (const fn of filenames) {
    const pkg = makePkg(fn, opts[fn])
    packageIndex.set(fn, pkg)
    if (!groupIndex.has(pkg.package_name)) groupIndex.set(pkg.package_name, [])
    groupIndex.get(pkg.package_name).push(fn)
  }
  return { packageIndex, groupIndex }
}

describe('checkUpdatesFromIndex', () => {
  it('returns null when packagesIndex has not been loaded yet', () => {
    setPackagesIndexForTests({ index: null, fnIndex: null })
    expect(checkUpdatesFromIndex(new Map(), new Map(), new Map())).toBeNull()
  })

  it('detects a direct update when CDN version > highest local installed version', () => {
    setPackagesIndexForTests({
      data: {
        'Author.Pkg.5.var': 'r5',
      },
    })
    const { packageIndex, groupIndex } = indexes(['Author.Pkg.3.var'])
    const updates = checkUpdatesFromIndex(packageIndex, groupIndex, new Map())
    expect(updates['Author.Pkg.3.var']).toMatchObject({
      currentVersion: 3,
      hubVersion: 5,
      hubFilename: 'Author.Pkg.5.var',
      hubResourceId: 'r5',
      packageName: 'Author.Pkg',
      localNewerFilename: null,
    })
  })

  it('suppresses update when CDN version equals highest local installed version', () => {
    setPackagesIndexForTests({ data: { 'Author.Pkg.3.var': 'r3' } })
    const { packageIndex, groupIndex } = indexes(['Author.Pkg.3.var'])
    expect(checkUpdatesFromIndex(packageIndex, groupIndex, new Map())).toEqual({})
  })

  it('suppresses update when CDN version is older than local', () => {
    setPackagesIndexForTests({ data: { 'Author.Pkg.2.var': 'r2' } })
    const { packageIndex, groupIndex } = indexes(['Author.Pkg.5.var'])
    expect(checkUpdatesFromIndex(packageIndex, groupIndex, new Map())).toEqual({})
  })

  it('sets localNewerFilename only when a non-direct install at >= hub version already exists', () => {
    // Direct: v3, non-direct sibling: v10 (matches hub) — UI promotes the local v10.
    setPackagesIndexForTests({ data: { 'Author.Pkg.10.var': 'r10' } })
    const { packageIndex, groupIndex } = indexes(['Author.Pkg.3.var', 'Author.Pkg.10.var'], {
      'Author.Pkg.3.var': { is_direct: 1 },
      'Author.Pkg.10.var': { is_direct: 0 },
    })
    const updates = checkUpdatesFromIndex(packageIndex, groupIndex, new Map())
    expect(updates['Author.Pkg.3.var'].localNewerFilename).toBe('Author.Pkg.10.var')
    expect(updates['Author.Pkg.3.var'].hubVersion).toBe(10)
  })

  it('leaves localNewerFilename null when local sibling is newer than direct but still older than hub', () => {
    // Promoting v7 would be wrong: the UI's promote button toasts "Updated to v${hubVersion}",
    // and we'd actually need to download v10 to satisfy that. Force a download instead.
    setPackagesIndexForTests({ data: { 'Author.Pkg.10.var': 'r10' } })
    const { packageIndex, groupIndex } = indexes(['Author.Pkg.3.var', 'Author.Pkg.7.var'], {
      'Author.Pkg.3.var': { is_direct: 1 },
      'Author.Pkg.7.var': { is_direct: 0 },
    })
    const updates = checkUpdatesFromIndex(packageIndex, groupIndex, new Map())
    expect(updates['Author.Pkg.3.var'].localNewerFilename).toBeNull()
    expect(updates['Author.Pkg.3.var'].hubVersion).toBe(10)
  })

  it('flags `.latest` dep update with isDepUpdate and merges neededBy', () => {
    setPackagesIndexForTests({ data: { 'Child.Pkg.5.var': 'hub5' } })
    const { packageIndex, groupIndex } = indexes(['Parent.A.1.var', 'Parent.B.1.var', 'Child.Pkg.2.var'], {
      'Parent.A.1.var': { is_direct: 1 },
      'Parent.B.1.var': { is_direct: 1 },
      'Child.Pkg.2.var': { is_direct: 0 },
    })
    const forwardDeps = new Map([
      ['Parent.A.1.var', [{ ref: 'Child.Pkg.latest', resolved: 'Child.Pkg.2.var', resolution: 'latest' }]],
      ['Parent.B.1.var', [{ ref: 'Child.Pkg.latest', resolved: 'Child.Pkg.2.var', resolution: 'latest' }]],
    ])
    const updates = checkUpdatesFromIndex(packageIndex, groupIndex, forwardDeps)
    const u = updates['Child.Pkg.2.var']
    expect(u.isDepUpdate).toBe(true)
    expect(u.hubVersion).toBe(5)
    expect(u.neededBy.sort()).toEqual(['Parent.A.1.var', 'Parent.B.1.var'].sort())
  })

  it('suppresses dep update when direct update already covers the resolved dep filename', () => {
    setPackagesIndexForTests({ data: { 'Dep.Pkg.5.var': 'r5' } })
    const { packageIndex, groupIndex } = indexes(['App.Pkg.1.var', 'Dep.Pkg.2.var'], {
      'App.Pkg.1.var': { is_direct: 1 },
      'Dep.Pkg.2.var': { is_direct: 1 },
    })
    const forwardDeps = new Map([
      ['App.Pkg.1.var', [{ ref: 'Dep.Pkg.latest', resolved: 'Dep.Pkg.2.var', resolution: 'latest' }]],
    ])
    const updates = checkUpdatesFromIndex(packageIndex, groupIndex, forwardDeps)
    expect(updates['Dep.Pkg.2.var']).toBeDefined()
    expect(updates['Dep.Pkg.2.var'].isDepUpdate).toBeUndefined()
    expect(updates['Dep.Pkg.2.var'].hubVersion).toBe(5)
  })

  it('skips non-direct rows when picking best for direct-update pass (no spurious entry)', () => {
    setPackagesIndexForTests({ data: { 'Z.Only.5.var': 'r5' } })
    const { packageIndex, groupIndex } = indexes(['Z.Only.1.var'], {
      'Z.Only.1.var': { is_direct: 0 },
    })
    expect(checkUpdatesFromIndex(packageIndex, groupIndex, new Map())).toEqual({})
  })
})
