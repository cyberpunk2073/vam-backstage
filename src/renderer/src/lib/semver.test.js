import { describe, it, expect } from 'vitest'
import { parseVersionCore, compareVersions, selectUnseen } from './semver.js'

describe('parseVersionCore', () => {
  it('parses M.m.p', () => {
    expect(parseVersionCore('1.2.3')).toEqual([1, 2, 3])
  })
  it('strips v prefix and pre-release', () => {
    expect(parseVersionCore('v0.1.10-beta.1')).toEqual([0, 1, 10])
  })
  it('allows two segments with patch 0', () => {
    expect(parseVersionCore('1.0')).toEqual([1, 0, 0])
  })
  it('returns null for empty or invalid', () => {
    expect(parseVersionCore('')).toBeNull()
    expect(parseVersionCore(null)).toBeNull()
    expect(parseVersionCore('nope')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('compares in semver order', () => {
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1)
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })
  it('returns NaN when a side is invalid', () => {
    expect(compareVersions('1.0.0', 'x')).toBeNaN()
  })
})

describe('selectUnseen', () => {
  const log = [
    { version: '0.1.2', date: 'a', notes: ['n2'] },
    { version: '0.1.1', date: 'b', notes: ['n1'] },
    { version: '0.1.0', date: 'c', notes: ['n0'] },
  ]
  it('selects versions after lastSeen up to current inclusive, newest first order preserved', () => {
    const out = selectUnseen(log, '0.1.0', '0.1.2')
    expect(out.map((e) => e.version)).toEqual(['0.1.2', '0.1.1'])
  })
  it('returns empty when no gap', () => {
    expect(selectUnseen(log, '0.1.2', '0.1.2')).toEqual([])
  })
})
