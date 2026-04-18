import { describe, it, expect } from 'vitest'
import {
  parseDepRef,
  extractDepRefs,
  resolveRef,
  buildForwardDeps,
  buildReverseDeps,
  buildGroupIndex,
  detectLeaves,
  getTransitiveDeps,
  computeRemovableDeps,
  isFlexibleRef,
} from './graph'

function pkg(filename, opts = {}) {
  const parts = filename.replace(/\.var$/, '').split('.')
  return {
    filename,
    package_name: opts.package_name ?? parts.slice(0, -1).join('.'),
    version: opts.version ?? parts[parts.length - 1],
    dep_refs: opts.dep_refs ?? '[]',
    is_direct: opts.is_direct ?? 0,
    size_bytes: opts.size_bytes ?? 100,
  }
}

// ── parseDepRef ─────────────────────────────────────────────────

describe('parseDepRef', () => {
  it('parses a standard numeric version', () => {
    expect(parseDepRef('Author.Pkg.42')).toEqual({
      creator: 'Author',
      packageName: 'Author.Pkg',
      version: '42',
      raw: 'Author.Pkg.42',
    })
  })

  it('parses .latest keyword', () => {
    const result = parseDepRef('Author.Pkg.latest')
    expect(result.version).toBe('latest')
    expect(result.packageName).toBe('Author.Pkg')
  })

  it('normalizes LATEST to lowercase', () => {
    expect(parseDepRef('Author.Pkg.LATEST').version).toBe('latest')
    expect(parseDepRef('Author.Pkg.Latest').version).toBe('latest')
  })

  it('handles multi-dot package names', () => {
    const result = parseDepRef('A.B.C.123')
    expect(result.creator).toBe('A')
    expect(result.packageName).toBe('A.B.C')
    expect(result.version).toBe('123')
  })

  it('accepts version 0', () => {
    const result = parseDepRef('A.B.0')
    expect(result.version).toBe('0')
  })

  it('returns null for two-part string', () => {
    expect(parseDepRef('OnlyTwo.Parts')).toBeNull()
  })

  it('returns null for single segment', () => {
    expect(parseDepRef('NoDots')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseDepRef('')).toBeNull()
  })

  it('returns null for non-string inputs', () => {
    expect(parseDepRef(null)).toBeNull()
    expect(parseDepRef(undefined)).toBeNull()
    expect(parseDepRef(42)).toBeNull()
  })

  it('returns null for non-numeric non-latest version', () => {
    expect(parseDepRef('A.B.beta')).toBeNull()
    expect(parseDepRef('A.B.1a')).toBeNull()
    expect(parseDepRef('A.B.v2')).toBeNull()
  })

  it('preserves the raw ref string unchanged', () => {
    expect(parseDepRef('Author.Pkg.LATEST').raw).toBe('Author.Pkg.LATEST')
  })

  it('parses .minN keyword', () => {
    expect(parseDepRef('Author.Pkg.min5')).toEqual({
      creator: 'Author',
      packageName: 'Author.Pkg',
      version: 'min',
      minVersion: 5,
      raw: 'Author.Pkg.min5',
    })
  })

  it('normalizes .MIN casing', () => {
    expect(parseDepRef('A.B.MIN10')).toMatchObject({ version: 'min', minVersion: 10 })
    expect(parseDepRef('A.B.Min42')).toMatchObject({ version: 'min', minVersion: 42 })
  })

  it('accepts .min0 as a valid floor', () => {
    expect(parseDepRef('A.B.min0')).toMatchObject({ version: 'min', minVersion: 0 })
  })

  it('handles multi-dot package names with .minN', () => {
    expect(parseDepRef('A.B.C.min7')).toMatchObject({
      creator: 'A',
      packageName: 'A.B.C',
      version: 'min',
      minVersion: 7,
    })
  })

  it('rejects malformed .min refs', () => {
    expect(parseDepRef('A.B.min')).toBeNull()
    expect(parseDepRef('A.B.minbeta')).toBeNull()
    expect(parseDepRef('A.B.min-1')).toBeNull()
    expect(parseDepRef('A.B.min5x')).toBeNull()
  })
})

// ── isFlexibleRef ───────────────────────────────────────────────

describe('isFlexibleRef', () => {
  it('returns true for .latest', () => {
    expect(isFlexibleRef(parseDepRef('A.B.latest'))).toBe(true)
  })

  it('returns true for .minN', () => {
    expect(isFlexibleRef(parseDepRef('A.B.min5'))).toBe(true)
  })

  it('returns false for numeric refs', () => {
    expect(isFlexibleRef(parseDepRef('A.B.42'))).toBe(false)
  })

  it('returns false for null/undefined', () => {
    expect(isFlexibleRef(null)).toBe(false)
    expect(isFlexibleRef(undefined)).toBe(false)
  })
})

// ── extractDepRefs ──────────────────────────────────────────────

describe('extractDepRefs', () => {
  it('extracts keys from dict-format dependencies', () => {
    const meta = { dependencies: { 'A.B.1': 'https://example.com', 'C.D.2': '' } }
    expect(extractDepRefs(meta, 'Self.Pkg.1.var')).toEqual(['A.B.1', 'C.D.2'])
  })

  it('extracts entries from array-format dependencies', () => {
    const meta = { dependencies: ['A.B.1', 'C.D.2'] }
    expect(extractDepRefs(meta, 'Self.Pkg.1.var')).toEqual(['A.B.1', 'C.D.2'])
  })

  it('normalizes .LATEST casing to lowercase', () => {
    const meta = { dependencies: ['A.B.LATEST', 'C.D.Latest'] }
    expect(extractDepRefs(meta, 'Self.Pkg.1.var')).toEqual(['A.B.latest', 'C.D.latest'])
  })

  it('normalizes .MIN casing to lowercase and preserves digits', () => {
    const meta = { dependencies: ['A.B.MIN5', 'C.D.Min10'] }
    expect(extractDepRefs(meta, 'Self.Pkg.1.var')).toEqual(['A.B.min5', 'C.D.min10'])
  })

  it('filters out self-references', () => {
    const meta = { dependencies: ['A.B.1', 'Self.Pkg.1'] }
    expect(extractDepRefs(meta, 'Self.Pkg.1.var')).toEqual(['A.B.1'])
  })

  it('handles self-reference with case-insensitive .var suffix stripping', () => {
    const meta = { dependencies: ['Self.Pkg.1'] }
    expect(extractDepRefs(meta, 'Self.Pkg.1.VAR')).toEqual([])
  })

  it('returns empty array for missing dependencies field', () => {
    expect(extractDepRefs({}, 'X.Y.1.var')).toEqual([])
  })

  it('returns empty array for null meta', () => {
    expect(extractDepRefs(null, 'X.Y.1.var')).toEqual([])
  })

  it('returns empty array for undefined meta', () => {
    expect(extractDepRefs(undefined, 'X.Y.1.var')).toEqual([])
  })

  it('skips non-string entries in array', () => {
    const meta = { dependencies: [123, null, 'A.B.1', undefined] }
    expect(extractDepRefs(meta, 'Self.Pkg.1.var')).toEqual(['A.B.1'])
  })

  it('preserves entries with fewer than 3 parts (no validation at this stage)', () => {
    const meta = { dependencies: ['TwoParts', 'A.B.1'] }
    expect(extractDepRefs(meta, 'Self.Pkg.1.var')).toEqual(['TwoParts', 'A.B.1'])
  })

  it('returns empty for empty object dependencies', () => {
    expect(extractDepRefs({ dependencies: {} }, 'X.Y.1.var')).toEqual([])
  })

  it('returns empty for empty array dependencies', () => {
    expect(extractDepRefs({ dependencies: [] }, 'X.Y.1.var')).toEqual([])
  })

  it('does not normalize casing for non-.latest version parts', () => {
    const meta = { dependencies: ['A.B.42'] }
    expect(extractDepRefs(meta, 'X.Y.1.var')).toEqual(['A.B.42'])
  })

  it('extracts keys from nested VaM-style dependencies with licenseType and sub-deps', () => {
    const meta = {
      dependencies: {
        'A.B.3': { licenseType: 'CC BY-SA', dependencies: {} },
        'C.D.latest': {
          licenseType: 'CC BY-NC',
          dependencies: {
            'E.F.latest': { licenseType: 'FC', dependencies: {} },
            'G.H.2': { licenseType: 'CC BY', dependencies: {} },
          },
        },
      },
    }
    const result = extractDepRefs(meta, 'Self.Pkg.1.var')
    expect(result).toContain('A.B.3')
    expect(result).toContain('C.D.latest')
    expect(result).toContain('E.F.latest')
    expect(result).toContain('G.H.2')
    expect(result).toHaveLength(4)
  })

  it('deduplicates deps that appear at both top level and nested', () => {
    const meta = {
      dependencies: {
        'A.B.latest': { licenseType: 'FC', dependencies: {} },
        'C.D.latest': {
          licenseType: 'CC BY-NC',
          dependencies: {
            'A.B.latest': { licenseType: 'FC', dependencies: {} },
          },
        },
      },
    }
    const result = extractDepRefs(meta, 'Self.Pkg.1.var')
    expect(result).toEqual(['A.B.latest', 'C.D.latest'])
  })

  it('handles deeply nested dependencies (3+ levels)', () => {
    const meta = {
      dependencies: {
        'A.B.1': {
          licenseType: 'FC',
          dependencies: {
            'C.D.1': {
              licenseType: 'FC',
              dependencies: {
                'E.F.1': { licenseType: 'FC', dependencies: {} },
              },
            },
          },
        },
      },
    }
    const result = extractDepRefs(meta, 'X.Y.1.var')
    expect(result).toContain('A.B.1')
    expect(result).toContain('C.D.1')
    expect(result).toContain('E.F.1')
    expect(result).toHaveLength(3)
  })

  it('normalizes .LATEST in nested deps', () => {
    const meta = {
      dependencies: {
        'A.B.LATEST': {
          licenseType: 'FC',
          dependencies: {
            'C.D.Latest': { licenseType: 'FC', dependencies: {} },
          },
        },
      },
    }
    const result = extractDepRefs(meta, 'X.Y.1.var')
    expect(result).toEqual(['A.B.latest', 'C.D.latest'])
  })

  it('filters self-reference in nested deps', () => {
    const meta = {
      dependencies: {
        'A.B.1': {
          licenseType: 'FC',
          dependencies: {
            'Self.Pkg.1': { licenseType: 'FC', dependencies: {} },
          },
        },
      },
    }
    const result = extractDepRefs(meta, 'Self.Pkg.1.var')
    expect(result).toEqual(['A.B.1'])
  })

  it('handles nested format with no sub-dependencies field', () => {
    const meta = {
      dependencies: {
        'A.B.1': { licenseType: 'CC BY-SA' },
        'C.D.2': { licenseType: 'FC' },
      },
    }
    const result = extractDepRefs(meta, 'X.Y.1.var')
    expect(result).toEqual(['A.B.1', 'C.D.2'])
  })
})

// ── resolveRef ──────────────────────────────────────────────────

describe('resolveRef', () => {
  it('resolves exact version match', () => {
    const pi = new Map([['A.Pkg.5.var', pkg('A.Pkg.5.var')]])
    const gi = new Map([['A.Pkg', ['A.Pkg.5.var']]])
    expect(resolveRef('A.Pkg.5', pi, gi)).toEqual({ resolved: 'A.Pkg.5.var', resolution: 'exact' })
  })

  it('resolves .latest to the highest numeric version', () => {
    const pi = new Map([
      ['A.Pkg.3.var', pkg('A.Pkg.3.var')],
      ['A.Pkg.10.var', pkg('A.Pkg.10.var')],
      ['A.Pkg.7.var', pkg('A.Pkg.7.var')],
    ])
    const gi = new Map([['A.Pkg', ['A.Pkg.3.var', 'A.Pkg.10.var', 'A.Pkg.7.var']]])
    const result = resolveRef('A.Pkg.latest', pi, gi)
    expect(result.resolution).toBe('latest')
    expect(result.resolved).toBe('A.Pkg.10.var')
  })

  it('falls back to highest version when exact version is missing', () => {
    const pi = new Map([
      ['A.Pkg.3.var', pkg('A.Pkg.3.var')],
      ['A.Pkg.7.var', pkg('A.Pkg.7.var')],
    ])
    const gi = new Map([['A.Pkg', ['A.Pkg.3.var', 'A.Pkg.7.var']]])
    const result = resolveRef('A.Pkg.5', pi, gi)
    expect(result.resolution).toBe('fallback')
    expect(result.resolved).toBe('A.Pkg.7.var')
  })

  it('returns missing when no candidates exist for the group', () => {
    const pi = new Map()
    const gi = new Map()
    expect(resolveRef('A.Pkg.5', pi, gi)).toEqual({ resolved: null, resolution: 'missing' })
  })

  it('returns invalid for unparseable ref', () => {
    const pi = new Map()
    const gi = new Map()
    expect(resolveRef('garbage', pi, gi)).toEqual({ resolved: null, resolution: 'invalid' })
    expect(resolveRef('A.B.beta', pi, gi)).toEqual({ resolved: null, resolution: 'invalid' })
  })

  it('skips candidates with non-numeric versions in pickHighestVersion', () => {
    const pi = new Map([['A.Pkg.nightly.var', pkg('A.Pkg.nightly.var', { version: 'nightly' })]])
    const gi = new Map([['A.Pkg', ['A.Pkg.nightly.var']]])
    const result = resolveRef('A.Pkg.latest', pi, gi)
    expect(result.resolved).toBeNull()
    expect(result.resolution).toBe('missing')
  })

  it('resolves .latest with a single candidate', () => {
    const pi = new Map([['A.Pkg.1.var', pkg('A.Pkg.1.var')]])
    const gi = new Map([['A.Pkg', ['A.Pkg.1.var']]])
    const result = resolveRef('A.Pkg.latest', pi, gi)
    expect(result.resolved).toBe('A.Pkg.1.var')
    expect(result.resolution).toBe('latest')
  })

  it('.latest never resolves to a literal .latest.var file', () => {
    const pi = new Map([
      ['A.Pkg.latest.var', pkg('A.Pkg.latest.var', { version: 'latest' })],
      ['A.Pkg.5.var', pkg('A.Pkg.5.var')],
    ])
    const gi = new Map([['A.Pkg', ['A.Pkg.latest.var', 'A.Pkg.5.var']]])
    const result = resolveRef('A.Pkg.latest', pi, gi)
    expect(result.resolved).toBe('A.Pkg.5.var')
    expect(result.resolution).toBe('latest')
  })

  it('.latest returns missing when only a .latest.var file exists', () => {
    const pi = new Map([['A.Pkg.latest.var', pkg('A.Pkg.latest.var', { version: 'latest' })]])
    const gi = new Map([['A.Pkg', ['A.Pkg.latest.var']]])
    const result = resolveRef('A.Pkg.latest', pi, gi)
    expect(result.resolved).toBeNull()
    expect(result.resolution).toBe('missing')
  })

  it('prefers exact match over group fallback', () => {
    const pi = new Map([
      ['A.Pkg.5.var', pkg('A.Pkg.5.var')],
      ['A.Pkg.10.var', pkg('A.Pkg.10.var')],
    ])
    const gi = new Map([['A.Pkg', ['A.Pkg.5.var', 'A.Pkg.10.var']]])
    const result = resolveRef('A.Pkg.5', pi, gi)
    expect(result.resolution).toBe('exact')
    expect(result.resolved).toBe('A.Pkg.5.var')
  })

  it('resolves .minN to highest version when constraint is satisfied', () => {
    const pi = new Map([
      ['A.Pkg.7.var', pkg('A.Pkg.7.var')],
      ['A.Pkg.9.var', pkg('A.Pkg.9.var')],
    ])
    const gi = new Map([['A.Pkg', ['A.Pkg.7.var', 'A.Pkg.9.var']]])
    const result = resolveRef('A.Pkg.min5', pi, gi)
    expect(result.resolution).toBe('latest')
    expect(result.resolved).toBe('A.Pkg.9.var')
  })

  it('resolves .minN to highest satisfying version, skipping those below floor', () => {
    const pi = new Map([
      ['A.Pkg.3.var', pkg('A.Pkg.3.var')],
      ['A.Pkg.6.var', pkg('A.Pkg.6.var')],
      ['A.Pkg.4.var', pkg('A.Pkg.4.var')],
    ])
    const gi = new Map([['A.Pkg', ['A.Pkg.3.var', 'A.Pkg.6.var', 'A.Pkg.4.var']]])
    const result = resolveRef('A.Pkg.min5', pi, gi)
    expect(result.resolution).toBe('latest')
    expect(result.resolved).toBe('A.Pkg.6.var')
  })

  it('.minN falls back to highest overall when no version meets the floor', () => {
    const pi = new Map([
      ['A.Pkg.3.var', pkg('A.Pkg.3.var')],
      ['A.Pkg.4.var', pkg('A.Pkg.4.var')],
    ])
    const gi = new Map([['A.Pkg', ['A.Pkg.3.var', 'A.Pkg.4.var']]])
    const result = resolveRef('A.Pkg.min5', pi, gi)
    expect(result.resolution).toBe('fallback')
    expect(result.resolved).toBe('A.Pkg.4.var')
  })

  it('.minN returns missing when the group has no candidates', () => {
    const pi = new Map()
    const gi = new Map()
    const result = resolveRef('A.Pkg.min5', pi, gi)
    expect(result.resolved).toBeNull()
    expect(result.resolution).toBe('missing')
  })

  it('.minN never resolves to a literal .minN.var file', () => {
    const pi = new Map([
      ['A.Pkg.min5.var', pkg('A.Pkg.min5.var', { version: 'min5' })],
      ['A.Pkg.8.var', pkg('A.Pkg.8.var')],
    ])
    const gi = new Map([['A.Pkg', ['A.Pkg.min5.var', 'A.Pkg.8.var']]])
    const result = resolveRef('A.Pkg.min5', pi, gi)
    expect(result.resolved).toBe('A.Pkg.8.var')
    expect(result.resolution).toBe('latest')
  })

  it('.min0 behaves like .latest (any version satisfies)', () => {
    const pi = new Map([
      ['A.Pkg.1.var', pkg('A.Pkg.1.var')],
      ['A.Pkg.3.var', pkg('A.Pkg.3.var')],
    ])
    const gi = new Map([['A.Pkg', ['A.Pkg.1.var', 'A.Pkg.3.var']]])
    const result = resolveRef('A.Pkg.min0', pi, gi)
    expect(result.resolution).toBe('latest')
    expect(result.resolved).toBe('A.Pkg.3.var')
  })
})

// ── buildForwardDeps ────────────────────────────────────────────

describe('buildForwardDeps', () => {
  it('resolves deps for each package', () => {
    const pi = new Map([
      ['A.Main.1.var', pkg('A.Main.1.var', { dep_refs: '["B.Lib.1", "C.Missing.1"]' })],
      ['B.Lib.1.var', pkg('B.Lib.1.var')],
    ])
    const gi = buildGroupIndex(pi)
    const forward = buildForwardDeps(pi, gi)

    expect(forward.get('A.Main.1.var')).toEqual([
      { ref: 'B.Lib.1', resolved: 'B.Lib.1.var', resolution: 'exact' },
      { ref: 'C.Missing.1', resolved: null, resolution: 'missing' },
    ])
    expect(forward.get('B.Lib.1.var')).toEqual([])
  })

  it('returns empty deps for packages with no dep_refs', () => {
    const pi = new Map([['A.Pkg.1.var', pkg('A.Pkg.1.var')]])
    const gi = buildGroupIndex(pi)
    const forward = buildForwardDeps(pi, gi)
    expect(forward.get('A.Pkg.1.var')).toEqual([])
  })

  it('creates one entry per package', () => {
    const pi = new Map([
      ['A.Pkg.1.var', pkg('A.Pkg.1.var')],
      ['B.Pkg.1.var', pkg('B.Pkg.1.var')],
      ['C.Pkg.1.var', pkg('C.Pkg.1.var')],
    ])
    const gi = buildGroupIndex(pi)
    const forward = buildForwardDeps(pi, gi)
    expect(forward.size).toBe(3)
  })
})

// ── buildReverseDeps ────────────────────────────────────────────

describe('buildReverseDeps', () => {
  it('maps a dependency back to its dependent', () => {
    const forward = new Map([
      ['A.var', [{ ref: 'B.Lib.1', resolved: 'B.var', resolution: 'exact' }]],
      ['B.var', []],
    ])
    const reverse = buildReverseDeps(forward)
    expect(reverse.get('B.var')).toEqual(new Set(['A.var']))
  })

  it('collects multiple dependents for a shared dependency', () => {
    const forward = new Map([
      ['A.var', [{ ref: 'D.Lib.1', resolved: 'D.var', resolution: 'exact' }]],
      ['B.var', [{ ref: 'D.Lib.1', resolved: 'D.var', resolution: 'exact' }]],
      ['D.var', []],
    ])
    const reverse = buildReverseDeps(forward)
    expect(reverse.get('D.var')).toEqual(new Set(['A.var', 'B.var']))
  })

  it('skips unresolved dependencies', () => {
    const forward = new Map([['A.var', [{ ref: 'Missing.Lib.1', resolved: null, resolution: 'missing' }]]])
    const reverse = buildReverseDeps(forward)
    expect(reverse.size).toBe(0)
  })

  it('does not create entries for packages with no dependents', () => {
    const forward = new Map([
      ['A.var', []],
      ['B.var', []],
    ])
    const reverse = buildReverseDeps(forward)
    expect(reverse.has('A.var')).toBe(false)
    expect(reverse.has('B.var')).toBe(false)
  })
})

// ── buildGroupIndex ─────────────────────────────────────────────

describe('buildGroupIndex', () => {
  it('groups multiple versions of the same package', () => {
    const pi = new Map([
      ['A.Pkg.1.var', pkg('A.Pkg.1.var')],
      ['A.Pkg.2.var', pkg('A.Pkg.2.var')],
    ])
    const gi = buildGroupIndex(pi)
    expect(gi.get('A.Pkg')).toEqual(['A.Pkg.1.var', 'A.Pkg.2.var'])
  })

  it('keeps distinct packages in separate groups', () => {
    const pi = new Map([
      ['A.Foo.1.var', pkg('A.Foo.1.var')],
      ['B.Bar.1.var', pkg('B.Bar.1.var')],
    ])
    const gi = buildGroupIndex(pi)
    expect(gi.get('A.Foo')).toEqual(['A.Foo.1.var'])
    expect(gi.get('B.Bar')).toEqual(['B.Bar.1.var'])
  })

  it('handles a single package', () => {
    const pi = new Map([['X.Y.1.var', pkg('X.Y.1.var')]])
    const gi = buildGroupIndex(pi)
    expect(gi.size).toBe(1)
    expect(gi.get('X.Y')).toEqual(['X.Y.1.var'])
  })

  it('returns empty map for empty index', () => {
    expect(buildGroupIndex(new Map()).size).toBe(0)
  })
})

// ── detectLeaves ────────────────────────────────────────────────

describe('detectLeaves', () => {
  it('identifies packages with no dependents as leaves', () => {
    const pi = new Map([
      ['A.var', pkg('A.var')],
      ['B.var', pkg('B.var')],
      ['C.var', pkg('C.var')],
    ])
    const reverse = new Map([['B.var', new Set(['A.var'])]])
    const leaves = detectLeaves(pi, reverse)
    expect(leaves).toEqual(new Set(['A.var', 'C.var']))
    expect(leaves.has('B.var')).toBe(false)
  })

  it('marks all independent packages as leaves', () => {
    const pi = new Map([
      ['A.var', pkg('A.var')],
      ['B.var', pkg('B.var')],
    ])
    const reverse = new Map()
    expect(detectLeaves(pi, reverse)).toEqual(new Set(['A.var', 'B.var']))
  })

  it('only marks the root of a chain as a leaf', () => {
    const pi = new Map([
      ['A.var', pkg('A.var')],
      ['B.var', pkg('B.var')],
      ['C.var', pkg('C.var')],
    ])
    const reverse = new Map([
      ['B.var', new Set(['A.var'])],
      ['C.var', new Set(['B.var'])],
    ])
    expect(detectLeaves(pi, reverse)).toEqual(new Set(['A.var']))
  })

  it('only marks root in a diamond graph', () => {
    const pi = new Map([
      ['A.var', pkg('A.var')],
      ['B.var', pkg('B.var')],
      ['C.var', pkg('C.var')],
      ['D.var', pkg('D.var')],
    ])
    const reverse = new Map([
      ['B.var', new Set(['A.var'])],
      ['C.var', new Set(['A.var'])],
      ['D.var', new Set(['B.var', 'C.var'])],
    ])
    expect(detectLeaves(pi, reverse)).toEqual(new Set(['A.var']))
  })

  it('returns empty set for empty package index', () => {
    expect(detectLeaves(new Map(), new Map()).size).toBe(0)
  })
})

// ── getTransitiveDeps ───────────────────────────────────────────

describe('getTransitiveDeps', () => {
  it('collects deps along a linear chain', () => {
    const forward = new Map([
      ['A', [{ resolved: 'B', resolution: 'exact' }]],
      ['B', [{ resolved: 'C', resolution: 'exact' }]],
      ['C', []],
    ])
    expect(getTransitiveDeps('A', forward)).toEqual(new Set(['B', 'C']))
  })

  it('collects deps across a diamond', () => {
    const forward = new Map([
      [
        'A',
        [
          { resolved: 'B', resolution: 'exact' },
          { resolved: 'C', resolution: 'exact' },
        ],
      ],
      ['B', [{ resolved: 'D', resolution: 'exact' }]],
      ['C', [{ resolved: 'D', resolution: 'exact' }]],
      ['D', []],
    ])
    expect(getTransitiveDeps('A', forward)).toEqual(new Set(['B', 'C', 'D']))
  })

  it('handles cycles without infinite loop', () => {
    const forward = new Map([
      ['A', [{ resolved: 'B', resolution: 'exact' }]],
      ['B', [{ resolved: 'A', resolution: 'exact' }]],
    ])
    // A is reachable from itself via the cycle — that's expected
    expect(getTransitiveDeps('A', forward)).toEqual(new Set(['B', 'A']))
  })

  it('handles a 3-node cycle', () => {
    const forward = new Map([
      ['A', [{ resolved: 'B', resolution: 'exact' }]],
      ['B', [{ resolved: 'C', resolution: 'exact' }]],
      ['C', [{ resolved: 'A', resolution: 'exact' }]],
    ])
    expect(getTransitiveDeps('A', forward)).toEqual(new Set(['B', 'C', 'A']))
  })

  it('returns empty set when package has no deps', () => {
    const forward = new Map([['A', []]])
    expect(getTransitiveDeps('A', forward).size).toBe(0)
  })

  it('returns empty set for unknown package', () => {
    expect(getTransitiveDeps('X', new Map()).size).toBe(0)
  })

  it('does not include the starting package itself', () => {
    const forward = new Map([
      ['A', [{ resolved: 'B', resolution: 'exact' }]],
      ['B', []],
    ])
    expect(getTransitiveDeps('A', forward).has('A')).toBe(false)
  })

  it('skips unresolved deps in the chain', () => {
    const forward = new Map([
      [
        'A',
        [
          { resolved: 'B', resolution: 'exact' },
          { resolved: null, resolution: 'missing' },
        ],
      ],
      ['B', [{ resolved: 'C', resolution: 'exact' }]],
      ['C', []],
    ])
    expect(getTransitiveDeps('A', forward)).toEqual(new Set(['B', 'C']))
  })
})

// ── getTransitiveDeps + buildForwardDeps integration ────────────

describe('getTransitiveDeps with buildForwardDeps (transitive tree scenarios)', () => {
  it('walks a deep transitive chain A→B→C→D', () => {
    const pi = new Map([
      ['A.Main.1.var', pkg('A.Main.1.var', { is_direct: 1, dep_refs: '["B.Lib.1"]' })],
      ['B.Lib.1.var', pkg('B.Lib.1.var', { dep_refs: '["C.Util.1"]' })],
      ['C.Util.1.var', pkg('C.Util.1.var', { dep_refs: '["D.Core.1"]' })],
      ['D.Core.1.var', pkg('D.Core.1.var')],
    ])
    const gi = buildGroupIndex(pi)
    const forward = buildForwardDeps(pi, gi)
    const transitive = getTransitiveDeps('A.Main.1.var', forward)
    expect(transitive).toEqual(new Set(['B.Lib.1.var', 'C.Util.1.var', 'D.Core.1.var']))
  })

  it('walks a diamond where A→B→D and A→C→D', () => {
    const pi = new Map([
      ['A.Main.1.var', pkg('A.Main.1.var', { is_direct: 1, dep_refs: '["B.Lib.1", "C.Lib.1"]' })],
      ['B.Lib.1.var', pkg('B.Lib.1.var', { dep_refs: '["D.Shared.1"]' })],
      ['C.Lib.1.var', pkg('C.Lib.1.var', { dep_refs: '["D.Shared.1"]' })],
      ['D.Shared.1.var', pkg('D.Shared.1.var')],
    ])
    const gi = buildGroupIndex(pi)
    const forward = buildForwardDeps(pi, gi)
    const transitive = getTransitiveDeps('A.Main.1.var', forward)
    expect(transitive).toEqual(new Set(['B.Lib.1.var', 'C.Lib.1.var', 'D.Shared.1.var']))
  })

  it('does not include missing deps in transitive set', () => {
    const pi = new Map([
      ['A.Main.1.var', pkg('A.Main.1.var', { is_direct: 1, dep_refs: '["B.Lib.1"]' })],
      ['B.Lib.1.var', pkg('B.Lib.1.var', { dep_refs: '["C.Missing.1"]' })],
    ])
    const gi = buildGroupIndex(pi)
    const forward = buildForwardDeps(pi, gi)
    const transitive = getTransitiveDeps('A.Main.1.var', forward)
    expect(transitive).toEqual(new Set(['B.Lib.1.var']))
  })

  it('discovers deps of deps even when root does not declare them', () => {
    const pi = new Map([
      ['A.Main.1.var', pkg('A.Main.1.var', { is_direct: 1, dep_refs: '["B.Lib.1"]' })],
      ['B.Lib.1.var', pkg('B.Lib.1.var', { dep_refs: '["C.Util.1", "D.Core.1"]' })],
      ['C.Util.1.var', pkg('C.Util.1.var')],
      ['D.Core.1.var', pkg('D.Core.1.var')],
    ])
    const gi = buildGroupIndex(pi)
    const forward = buildForwardDeps(pi, gi)
    const transitive = getTransitiveDeps('A.Main.1.var', forward)
    expect(transitive).toEqual(new Set(['B.Lib.1.var', 'C.Util.1.var', 'D.Core.1.var']))
  })

  it('handles a cycle in real dep_refs without infinite loop', () => {
    const pi = new Map([
      ['A.Pkg.1.var', pkg('A.Pkg.1.var', { dep_refs: '["B.Pkg.1"]' })],
      ['B.Pkg.1.var', pkg('B.Pkg.1.var', { dep_refs: '["A.Pkg.1"]' })],
    ])
    const gi = buildGroupIndex(pi)
    const forward = buildForwardDeps(pi, gi)
    const transitive = getTransitiveDeps('A.Pkg.1.var', forward)
    expect(transitive).toEqual(new Set(['B.Pkg.1.var', 'A.Pkg.1.var']))
  })
})

// ── computeRemovableDeps ────────────────────────────────────────

describe('computeRemovableDeps', () => {
  it('marks exclusive transitive deps as removable', () => {
    const pi = new Map([
      ['A.var', pkg('A.var', { is_direct: 1, dep_refs: '["B.Lib.1"]' })],
      ['B.var', pkg('B.var', { dep_refs: '["C.Lib.1"]', size_bytes: 200 })],
      ['C.var', pkg('C.var', { size_bytes: 300 })],
    ])
    const forward = new Map([
      ['A.var', [{ ref: 'B.Lib.1', resolved: 'B.var', resolution: 'exact' }]],
      ['B.var', [{ ref: 'C.Lib.1', resolved: 'C.var', resolution: 'exact' }]],
      ['C.var', []],
    ])
    const reverse = buildReverseDeps(forward)

    const { removableFilenames, removableSize } = computeRemovableDeps('A.var', pi, forward, reverse)
    expect(removableFilenames).toEqual(new Set(['B.var', 'C.var']))
    expect(removableSize).toBe(500)
  })

  it('does not mark shared deps as removable', () => {
    const pi = new Map([
      ['A.var', pkg('A.var', { is_direct: 1 })],
      ['X.var', pkg('X.var', { is_direct: 1 })],
      ['B.var', pkg('B.var', { size_bytes: 200 })],
    ])
    const forward = new Map([
      ['A.var', [{ ref: 'B.Lib.1', resolved: 'B.var', resolution: 'exact' }]],
      ['X.var', [{ ref: 'B.Lib.1', resolved: 'B.var', resolution: 'exact' }]],
      ['B.var', []],
    ])
    const reverse = buildReverseDeps(forward)

    const { removableFilenames, removableSize } = computeRemovableDeps('A.var', pi, forward, reverse)
    expect(removableFilenames.size).toBe(0)
    expect(removableSize).toBe(0)
  })

  it('does not mark direct packages as removable', () => {
    const pi = new Map([
      ['A.var', pkg('A.var', { is_direct: 1 })],
      ['B.var', pkg('B.var', { is_direct: 1, size_bytes: 500 })],
    ])
    const forward = new Map([
      ['A.var', [{ ref: 'B.Lib.1', resolved: 'B.var', resolution: 'exact' }]],
      ['B.var', []],
    ])
    const reverse = buildReverseDeps(forward)

    const { removableFilenames } = computeRemovableDeps('A.var', pi, forward, reverse)
    expect(removableFilenames.size).toBe(0)
  })

  it('returns empty when package has no deps', () => {
    const pi = new Map([['A.var', pkg('A.var', { is_direct: 1 })]])
    const forward = new Map([['A.var', []]])
    const reverse = new Map()

    const { removableFilenames, removableSize } = computeRemovableDeps('A.var', pi, forward, reverse)
    expect(removableFilenames.size).toBe(0)
    expect(removableSize).toBe(0)
  })

  it('does not include the target package in removable set', () => {
    const pi = new Map([
      ['A.var', pkg('A.var', { is_direct: 1, size_bytes: 999 })],
      ['B.var', pkg('B.var', { size_bytes: 50 })],
    ])
    const forward = new Map([
      ['A.var', [{ ref: 'B.Lib.1', resolved: 'B.var', resolution: 'exact' }]],
      ['B.var', []],
    ])
    const reverse = buildReverseDeps(forward)

    const { removableFilenames, removableSize } = computeRemovableDeps('A.var', pi, forward, reverse)
    expect(removableFilenames.has('A.var')).toBe(false)
    expect(removableSize).toBe(50)
  })

  it('handles partial removability (some deps shared, some exclusive)', () => {
    const pi = new Map([
      ['A.var', pkg('A.var', { is_direct: 1 })],
      ['X.var', pkg('X.var', { is_direct: 1 })],
      ['B.var', pkg('B.var', { size_bytes: 100 })],
      ['C.var', pkg('C.var', { size_bytes: 200 })],
      ['D.var', pkg('D.var', { size_bytes: 300 })],
    ])
    // A -> B -> C (exclusive chain), A -> D, X -> D (D is shared)
    const forward = new Map([
      [
        'A.var',
        [
          { ref: 'B.Lib.1', resolved: 'B.var', resolution: 'exact' },
          { ref: 'D.Lib.1', resolved: 'D.var', resolution: 'exact' },
        ],
      ],
      ['X.var', [{ ref: 'D.Lib.1', resolved: 'D.var', resolution: 'exact' }]],
      ['B.var', [{ ref: 'C.Lib.1', resolved: 'C.var', resolution: 'exact' }]],
      ['C.var', []],
      ['D.var', []],
    ])
    const reverse = buildReverseDeps(forward)

    const { removableFilenames, removableSize } = computeRemovableDeps('A.var', pi, forward, reverse)
    expect(removableFilenames).toEqual(new Set(['B.var', 'C.var']))
    expect(removableSize).toBe(300)
  })

  it('sums removable sizes correctly', () => {
    const pi = new Map([
      ['A.var', pkg('A.var', { is_direct: 1 })],
      ['B.var', pkg('B.var', { size_bytes: 111 })],
      ['C.var', pkg('C.var', { size_bytes: 222 })],
      ['D.var', pkg('D.var', { size_bytes: 333 })],
    ])
    const forward = new Map([
      [
        'A.var',
        [
          { ref: 'B.Lib.1', resolved: 'B.var', resolution: 'exact' },
          { ref: 'C.Lib.1', resolved: 'C.var', resolution: 'exact' },
          { ref: 'D.Lib.1', resolved: 'D.var', resolution: 'exact' },
        ],
      ],
      ['B.var', []],
      ['C.var', []],
      ['D.var', []],
    ])
    const reverse = buildReverseDeps(forward)

    const { removableSize } = computeRemovableDeps('A.var', pi, forward, reverse)
    expect(removableSize).toBe(666)
  })

  it('handles deep exclusive chain', () => {
    const pi = new Map([
      ['A.var', pkg('A.var', { is_direct: 1 })],
      ['B.var', pkg('B.var', { size_bytes: 10 })],
      ['C.var', pkg('C.var', { size_bytes: 20 })],
      ['D.var', pkg('D.var', { size_bytes: 30 })],
      ['E.var', pkg('E.var', { size_bytes: 40 })],
    ])
    const forward = new Map([
      ['A.var', [{ ref: 'B.Lib.1', resolved: 'B.var', resolution: 'exact' }]],
      ['B.var', [{ ref: 'C.Lib.1', resolved: 'C.var', resolution: 'exact' }]],
      ['C.var', [{ ref: 'D.Lib.1', resolved: 'D.var', resolution: 'exact' }]],
      ['D.var', [{ ref: 'E.Lib.1', resolved: 'E.var', resolution: 'exact' }]],
      ['E.var', []],
    ])
    const reverse = buildReverseDeps(forward)

    const { removableFilenames, removableSize } = computeRemovableDeps('A.var', pi, forward, reverse)
    expect(removableFilenames).toEqual(new Set(['B.var', 'C.var', 'D.var', 'E.var']))
    expect(removableSize).toBe(100)
  })
})
