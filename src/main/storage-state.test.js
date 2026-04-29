import { describe, it, expect } from 'vitest'
import { computeInstallTarget, nextStorageStateForIntent, parseDisableBehavior } from './storage-state.js'

describe('parseDisableBehavior', () => {
  it('returns suffix for falsy', () => {
    expect(parseDisableBehavior(null)).toEqual({ kind: 'suffix' })
    expect(parseDisableBehavior(undefined)).toEqual({ kind: 'suffix' })
    expect(parseDisableBehavior('')).toEqual({ kind: 'suffix' })
  })

  it('returns suffix for "suffix"', () => {
    expect(parseDisableBehavior('suffix')).toEqual({ kind: 'suffix' })
  })

  it('parses "move-to:N" with valid id', () => {
    expect(parseDisableBehavior('move-to:7')).toEqual({ kind: 'move-to', auxDirId: 7 })
    expect(parseDisableBehavior('move-to:1')).toEqual({ kind: 'move-to', auxDirId: 1 })
  })

  it('falls back to suffix for malformed move-to refs', () => {
    expect(parseDisableBehavior('move-to:abc')).toEqual({ kind: 'suffix' })
    expect(parseDisableBehavior('move-to:')).toEqual({ kind: 'suffix' })
    expect(parseDisableBehavior('move-to')).toEqual({ kind: 'suffix' })
    expect(parseDisableBehavior('garbage')).toEqual({ kind: 'suffix' })
  })
})

describe('nextStorageStateForIntent', () => {
  const suffixTarget = { storageState: 'disabled', libraryDirId: null }
  const offloadTarget = { storageState: 'offloaded', libraryDirId: 3 }

  it('enable from disabled → enabled in main', () => {
    expect(nextStorageStateForIntent({ current: 'disabled', intent: 'enable' })).toEqual({
      storageState: 'enabled',
      libraryDirId: null,
    })
  })

  it('enable from offloaded → enabled in main', () => {
    expect(nextStorageStateForIntent({ current: 'offloaded', intent: 'enable' })).toEqual({
      storageState: 'enabled',
      libraryDirId: null,
    })
  })

  it('enable from enabled → no-op (null)', () => {
    expect(nextStorageStateForIntent({ current: 'enabled', intent: 'enable' })).toBeNull()
  })

  it('disable from enabled with suffix target → disabled', () => {
    expect(nextStorageStateForIntent({ current: 'enabled', intent: 'disable', disableTarget: suffixTarget })).toEqual(
      suffixTarget,
    )
  })

  it('disable from enabled with omitted target → defaults to suffix', () => {
    expect(nextStorageStateForIntent({ current: 'enabled', intent: 'disable' })).toEqual(suffixTarget)
  })

  it('disable from enabled with offload target → offloaded', () => {
    expect(nextStorageStateForIntent({ current: 'enabled', intent: 'disable', disableTarget: offloadTarget })).toEqual(
      offloadTarget,
    )
  })

  it('disable from disabled → no-op', () => {
    expect(nextStorageStateForIntent({ current: 'disabled', intent: 'disable' })).toBeNull()
  })

  it('disable from offloaded → no-op', () => {
    expect(nextStorageStateForIntent({ current: 'offloaded', intent: 'disable' })).toBeNull()
  })

  it('returns null for unknown intent', () => {
    expect(nextStorageStateForIntent({ current: 'enabled', intent: 'whatever' })).toBeNull()
  })
})

describe('computeInstallTarget', () => {
  const mkPkg = (state, dir = null) => ({ storage_state: state, library_dir_id: dir })

  it('returns null when there are no dependents (default enabled in main)', () => {
    expect(computeInstallTarget({ dependents: null, packageIndex: new Map() })).toBeNull()
    expect(computeInstallTarget({ dependents: new Set(), packageIndex: new Map() })).toBeNull()
  })

  it('returns null when any dependent is enabled (already in correct state)', () => {
    const pkgIndex = new Map([
      ['a.var', mkPkg('enabled')],
      ['b.var', mkPkg('disabled')],
      ['c.var', mkPkg('offloaded', 1)],
    ])
    const dependents = new Set(['a.var', 'b.var', 'c.var'])
    expect(computeInstallTarget({ dependents, packageIndex: pkgIndex })).toBeNull()
  })

  it('returns disabled when all dependents are disabled (none enabled)', () => {
    const pkgIndex = new Map([
      ['a.var', mkPkg('disabled')],
      ['b.var', mkPkg('disabled')],
    ])
    expect(computeInstallTarget({ dependents: new Set(['a.var', 'b.var']), packageIndex: pkgIndex })).toEqual({
      storageState: 'disabled',
      libraryDirId: null,
    })
  })

  it('returns disabled when dependents mix disabled + offloaded (no enabled)', () => {
    const pkgIndex = new Map([
      ['a.var', mkPkg('disabled')],
      ['b.var', mkPkg('offloaded', 1)],
    ])
    expect(computeInstallTarget({ dependents: new Set(['a.var', 'b.var']), packageIndex: pkgIndex })).toEqual({
      storageState: 'disabled',
      libraryDirId: null,
    })
  })

  it('returns offloaded when all dependents are offloaded', () => {
    const pkgIndex = new Map([
      ['a.var', mkPkg('offloaded', 5)],
      ['b.var', mkPkg('offloaded', 5)],
    ])
    expect(computeInstallTarget({ dependents: new Set(['a.var', 'b.var']), packageIndex: pkgIndex })).toEqual({
      storageState: 'offloaded',
      libraryDirId: 5,
    })
  })

  it('prefers disable_behavior target dir when it matches a dependent dir', () => {
    const pkgIndex = new Map([
      ['a.var', mkPkg('offloaded', 1)],
      ['b.var', mkPkg('offloaded', 2)],
    ])
    expect(
      computeInstallTarget({
        dependents: new Set(['a.var', 'b.var']),
        packageIndex: pkgIndex,
        disableBehaviorTargetId: 2,
      }),
    ).toEqual({ storageState: 'offloaded', libraryDirId: 2 })
  })

  it('falls back to first dependent dir when disable_behavior target is unrelated', () => {
    const pkgIndex = new Map([['a.var', mkPkg('offloaded', 7)]])
    expect(
      computeInstallTarget({
        dependents: new Set(['a.var']),
        packageIndex: pkgIndex,
        disableBehaviorTargetId: 99,
      }),
    ).toEqual({ storageState: 'offloaded', libraryDirId: 7 })
  })

  it('ignores dependents missing from package index', () => {
    const pkgIndex = new Map([['present.var', mkPkg('disabled')]])
    expect(
      computeInstallTarget({
        dependents: new Set(['ghost.var', 'present.var']),
        packageIndex: pkgIndex,
      }),
    ).toEqual({ storageState: 'disabled', libraryDirId: null })
  })
})
