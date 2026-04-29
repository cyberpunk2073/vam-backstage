import { describe, it, expect } from 'vitest'
import { concreteDepFilename, isFlexibleFilename } from './manager.js'

// ── concreteDepFilename ────────────────────────────────────────────────────────
//
// Hub `getResourceDetail` returns dep entries whose `file.filename` is the
// dep-ref verbatim ("…latest", "…minN", or a concrete numeric); `latest_version`
// is the concrete integer the URL serves. concreteDepFilename builds
// "<packageName>.<latest_version>.var" from those two, returning null when the
// inputs can't produce a numeric on-disk filename. The plan's invariant: no
// flexible-ref tokens (.latest / .minN) ever land in `downloads.package_ref`.

describe('concreteDepFilename', () => {
  it('builds concrete filename from numeric latest_version', () => {
    expect(concreteDepFilename({ packageName: 'Author.Pkg', latest_version: 42 })).toBe('Author.Pkg.42.var')
  })

  it('accepts numeric strings as latest_version', () => {
    expect(concreteDepFilename({ packageName: 'Author.Pkg', latest_version: '42' })).toBe('Author.Pkg.42.var')
  })

  it('returns null when latest_version is missing', () => {
    expect(concreteDepFilename({ packageName: 'Author.Pkg' })).toBeNull()
  })

  it('returns null when packageName is missing', () => {
    expect(concreteDepFilename({ latest_version: 42 })).toBeNull()
  })

  it('returns null when latest_version is non-numeric', () => {
    expect(concreteDepFilename({ packageName: 'Author.Pkg', latest_version: 'latest' })).toBeNull()
    expect(concreteDepFilename({ packageName: 'Author.Pkg', latest_version: 'min5' })).toBeNull()
    expect(concreteDepFilename({ packageName: 'Author.Pkg', latest_version: '' })).toBeNull()
  })

  it('returns null when input itself is null or undefined', () => {
    expect(concreteDepFilename(null)).toBeNull()
    expect(concreteDepFilename(undefined)).toBeNull()
  })

  it('handles multi-dot package names', () => {
    expect(concreteDepFilename({ packageName: 'A.B.C', latest_version: 7 })).toBe('A.B.C.7.var')
  })
})

// ── isFlexibleFilename ─────────────────────────────────────────────────────────
//
// Defensive last-line check before insertDownload. True for ".latest" and
// ".minN" version segments (case-insensitive), false for concrete numeric
// versions. The whole point is to fail loud rather than write a flexible token
// into the downloads table.

describe('isFlexibleFilename', () => {
  it('flags .latest as flexible', () => {
    expect(isFlexibleFilename('Author.Pkg.latest.var')).toBe(true)
  })

  it('does not flag concrete numeric version', () => {
    expect(isFlexibleFilename('Author.Pkg.123.var')).toBe(false)
  })

  it('flags .min5 / .min10 / case variants', () => {
    expect(isFlexibleFilename('Author.Pkg.min5.var')).toBe(true)
    expect(isFlexibleFilename('Author.Pkg.min10.var')).toBe(true)
    expect(isFlexibleFilename('Author.Pkg.MIN3.var')).toBe(true)
  })

  it('returns false for empty / null / non-string input', () => {
    expect(isFlexibleFilename('')).toBe(false)
    expect(isFlexibleFilename(null)).toBe(false)
    expect(isFlexibleFilename(undefined)).toBe(false)
  })

  it('returns false for short non-package names (< 3 segments)', () => {
    expect(isFlexibleFilename('Too.var')).toBe(false)
    expect(isFlexibleFilename('latest.var')).toBe(false)
  })

  it('does not treat ".var" as a flexible "version" token — needs ≥3 stem segments', () => {
    expect(isFlexibleFilename('File.var')).toBe(false)
    expect(isFlexibleFilename('More.var')).toBe(false)
  })
})
