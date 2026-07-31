import { describe, it, expect } from 'vitest'
import { computeInstallTarget, nextStorageStateForIntent, parseDisableBehavior, planResettle } from './storage-state.js'

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

  it('enable from archived → enabled in main (install from archive)', () => {
    expect(nextStorageStateForIntent({ current: 'archived', intent: 'enable' })).toEqual({
      storageState: 'enabled',
      libraryDirId: null,
    })
  })

  it('disable from archived → no-op (already inactive)', () => {
    expect(nextStorageStateForIntent({ current: 'archived', intent: 'disable' })).toBeNull()
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

  it('returns archived when all dependents are archived (bottom tier)', () => {
    const pkgIndex = new Map([
      ['a.var', mkPkg('archived', 8)],
      ['b.var', mkPkg('archived', 8)],
    ])
    expect(computeInstallTarget({ dependents: new Set(['a.var', 'b.var']), packageIndex: pkgIndex })).toEqual({
      storageState: 'archived',
      libraryDirId: 8,
    })
  })

  it('offloaded dominates archived (archive is the least active tier)', () => {
    const pkgIndex = new Map([
      ['a.var', mkPkg('offloaded', 5)],
      ['b.var', mkPkg('archived', 8)],
    ])
    expect(computeInstallTarget({ dependents: new Set(['a.var', 'b.var']), packageIndex: pkgIndex })).toEqual({
      storageState: 'offloaded',
      libraryDirId: 5,
    })
  })

  it('disabled dominates archived', () => {
    const pkgIndex = new Map([
      ['a.var', mkPkg('disabled')],
      ['b.var', mkPkg('archived', 8)],
    ])
    expect(computeInstallTarget({ dependents: new Set(['a.var', 'b.var']), packageIndex: pkgIndex })).toEqual({
      storageState: 'disabled',
      libraryDirId: null,
    })
  })

  it('enabled dominates archived (stay put)', () => {
    const pkgIndex = new Map([
      ['a.var', mkPkg('enabled')],
      ['b.var', mkPkg('archived', 8)],
    ])
    expect(computeInstallTarget({ dependents: new Set(['a.var', 'b.var']), packageIndex: pkgIndex })).toBeNull()
  })
})

describe('planResettle', () => {
  const mkPkg = (state, { dir = null, direct = false } = {}) => ({
    storage_state: state,
    library_dir_id: dir,
    is_direct: direct ? 1 : 0,
  })

  it('prunes a redownloadable dep whose only remaining dependent is archived', () => {
    const packageIndex = new Map([
      ['A.var', mkPkg('archived', { dir: 9 })],
      ['B.var', mkPkg('enabled')],
    ])
    const reverseDeps = new Map([['B.var', new Set(['A.var'])]])
    const { toPrune, decisions } = planResettle({
      candidates: ['B.var'],
      packageIndex,
      reverseDeps,
      replaceableSet: new Set(['B.var']),
    })
    expect(toPrune).toEqual(new Set(['B.var']))
    expect(decisions.size).toBe(0)
  })

  it('relocates a local-only dep into the archive instead of pruning it', () => {
    const packageIndex = new Map([
      ['A.var', mkPkg('archived', { dir: 9 })],
      ['B.var', mkPkg('enabled')],
    ])
    const reverseDeps = new Map([['B.var', new Set(['A.var'])]])
    const { toPrune, decisions } = planResettle({
      candidates: ['B.var'],
      packageIndex,
      reverseDeps,
      replaceableSet: new Set(), // B is local-only (irreplaceable)
    })
    expect(toPrune.size).toBe(0)
    expect(decisions.get('B.var')).toEqual({ storageState: 'archived', libraryDirId: 9 })
  })

  it('stores (relocates) a redownloadable dep when prune is disabled', () => {
    const packageIndex = new Map([
      ['A.var', mkPkg('archived', { dir: 9 })],
      ['B.var', mkPkg('enabled')],
    ])
    const reverseDeps = new Map([['B.var', new Set(['A.var'])]])
    const { toPrune, decisions } = planResettle({
      candidates: ['B.var'],
      packageIndex,
      reverseDeps,
      replaceableSet: new Set(['B.var']),
      prune: false,
    })
    expect(toPrune.size).toBe(0)
    expect(decisions.get('B.var')).toEqual({ storageState: 'archived', libraryDirId: 9 })
  })

  it('settles an enabled dep down to its remaining offloaded dependents', () => {
    const packageIndex = new Map([
      ['A.var', mkPkg('offloaded', { dir: 5 })],
      ['B.var', mkPkg('enabled')],
    ])
    const reverseDeps = new Map([['B.var', new Set(['A.var'])]])
    const { toPrune, decisions } = planResettle({
      candidates: ['B.var'],
      packageIndex,
      reverseDeps,
      replaceableSet: new Set(['B.var']),
    })
    expect(toPrune.size).toBe(0)
    expect(decisions.get('B.var')).toEqual({ storageState: 'offloaded', libraryDirId: 5 })
  })

  it('never touches direct packages', () => {
    const packageIndex = new Map([
      ['A.var', mkPkg('archived', { dir: 9 })],
      ['B.var', mkPkg('enabled', { direct: true })],
    ])
    const reverseDeps = new Map([['B.var', new Set(['A.var'])]])
    const { toPrune, decisions } = planResettle({
      candidates: ['B.var'],
      packageIndex,
      reverseDeps,
      replaceableSet: new Set(['B.var']),
    })
    expect(toPrune.size).toBe(0)
    expect(decisions.size).toBe(0)
  })

  it('leaves a dep with a surviving enabled dependent in place', () => {
    const packageIndex = new Map([
      ['A.var', mkPkg('enabled')],
      ['B.var', mkPkg('enabled')],
    ])
    const reverseDeps = new Map([['B.var', new Set(['A.var'])]])
    const { toPrune, decisions } = planResettle({
      candidates: ['B.var'],
      packageIndex,
      reverseDeps,
      replaceableSet: new Set(['B.var']),
    })
    expect(toPrune.size).toBe(0)
    expect(decisions.size).toBe(0)
  })

  it('leaves a dep with no remaining dependents to orphan cleanup (never pruned here)', () => {
    const packageIndex = new Map([['B.var', mkPkg('enabled')]])
    const reverseDeps = new Map()
    const { toPrune, decisions } = planResettle({
      candidates: ['B.var'],
      packageIndex,
      reverseDeps,
      replaceableSet: new Set(['B.var']),
    })
    expect(toPrune.size).toBe(0)
    expect(decisions.size).toBe(0)
  })

  // Order-independence: archive-then-lose-other-owner ≡ lose-other-owner-then-archive
  // for a shared redownloadable dep — both paths prune it.
  it('order-independence: shared redownloadable dep is pruned whether archive or uninstall comes first', () => {
    const mk = () => ({
      packageIndex: new Map([
        ['A.var', mkPkg('enabled', { direct: true })],
        ['B.var', mkPkg('enabled', { direct: true })],
        ['C.var', mkPkg('enabled')],
      ]),
      reverseDeps: new Map([['C.var', new Set(['A.var', 'B.var'])]]),
      replaceableSet: new Set(['C.var']),
    })

    // Path 1: archive A first (overlay), then B is gone → C pruned
    {
      const { packageIndex, reverseDeps, replaceableSet } = mk()
      packageIndex.set('A.var', mkPkg('archived', { dir: 9, direct: true }))
      // After archiving A, C still has B pinning it — stay put
      let r = planResettle({ candidates: ['C.var'], packageIndex, reverseDeps, replaceableSet })
      expect(r.toPrune.size).toBe(0)
      // Then B is uninstalled (removed from reverse deps)
      reverseDeps.set('C.var', new Set(['A.var']))
      r = planResettle({ candidates: ['C.var'], packageIndex, reverseDeps, replaceableSet })
      expect(r.toPrune).toEqual(new Set(['C.var']))
    }

    // Path 2: uninstall B first, then archive A → C pruned
    {
      const { packageIndex, reverseDeps, replaceableSet } = mk()
      reverseDeps.set('C.var', new Set(['A.var'])) // B already gone
      let r = planResettle({ candidates: ['C.var'], packageIndex, reverseDeps, replaceableSet })
      expect(r.toPrune.size).toBe(0) // A still enabled pins C
      packageIndex.set('A.var', mkPkg('archived', { dir: 9, direct: true }))
      r = planResettle({ candidates: ['C.var'], packageIndex, reverseDeps, replaceableSet })
      expect(r.toPrune).toEqual(new Set(['C.var']))
    }
  })

  it('propagates down a dep chain regardless of candidate order', () => {
    // A(archived) → B → C, both deps local-only. C is visited first, while B is
    // still enabled and pins it; B's own relocation must bring C along.
    const packageIndex = new Map([
      ['A.var', mkPkg('archived', { dir: 9, direct: true })],
      ['B.var', mkPkg('enabled')],
      ['C.var', mkPkg('enabled')],
    ])
    const reverseDeps = new Map([
      ['B.var', new Set(['A.var'])],
      ['C.var', new Set(['B.var'])],
    ])
    const { toPrune, decisions } = planResettle({
      candidates: ['C.var', 'B.var'],
      packageIndex,
      reverseDeps,
      replaceableSet: new Set(),
    })
    expect(toPrune.size).toBe(0)
    expect(decisions.get('B.var')).toEqual({ storageState: 'archived', libraryDirId: 9 })
    expect(decisions.get('C.var')).toEqual({ storageState: 'archived', libraryDirId: 9 })
  })

  // A(archived) demands B; C is a dep of both A and B. C is evaluated first while B
  // still pins it (decision: settle to B's offload dir); B is then pruned and C
  // re-evaluates to an archived target → prune. The stale settle-down decision must
  // be dropped, not applied alongside the prune.
  it('prune supersedes a settle-down decision recorded on an earlier pass', () => {
    const packageIndex = new Map([
      ['A.var', mkPkg('archived', { dir: 9, direct: true })],
      ['B.var', mkPkg('offloaded', { dir: 5 })],
      ['C.var', mkPkg('enabled')],
    ])
    const reverseDeps = new Map([
      ['B.var', new Set(['A.var'])],
      ['C.var', new Set(['A.var', 'B.var'])],
    ])
    const { toPrune, decisions } = planResettle({
      candidates: ['C.var', 'B.var'], // C first, so it decides against pre-prune B
      packageIndex,
      reverseDeps,
      replaceableSet: new Set(['B.var', 'C.var']),
    })
    expect(toPrune).toEqual(new Set(['B.var', 'C.var']))
    expect(decisions.size).toBe(0)
  })

  // Same shape but C's only dependent is B: after B is pruned C has no dependents
  // left, so its earlier settle-down decision is reverted (left to orphan cleanup).
  it('reverts a settle-down decision when every driving dependent is pruned', () => {
    const packageIndex = new Map([
      ['A.var', mkPkg('archived', { dir: 9, direct: true })],
      ['B.var', mkPkg('offloaded', { dir: 5 })],
      ['C.var', mkPkg('enabled')],
    ])
    const reverseDeps = new Map([
      ['B.var', new Set(['A.var'])],
      ['C.var', new Set(['B.var'])],
    ])
    const { toPrune, decisions } = planResettle({
      candidates: ['C.var', 'B.var'],
      packageIndex,
      reverseDeps,
      replaceableSet: new Set(['B.var', 'C.var']),
    })
    expect(toPrune).toEqual(new Set(['B.var']))
    expect(decisions.size).toBe(0) // C: no dependents remain — orphan cleanup's job
  })

  it('order-independence: shared local-only dep relocates into archive either order', () => {
    const mk = () => ({
      packageIndex: new Map([
        ['A.var', mkPkg('enabled', { direct: true })],
        ['B.var', mkPkg('enabled', { direct: true })],
        ['C.var', mkPkg('enabled')],
      ]),
      reverseDeps: new Map([['C.var', new Set(['A.var', 'B.var'])]]),
      replaceableSet: new Set(), // C irreplaceable
    })

    // Path 1: archive A, then lose B
    {
      const { packageIndex, reverseDeps, replaceableSet } = mk()
      packageIndex.set('A.var', mkPkg('archived', { dir: 9, direct: true }))
      reverseDeps.set('C.var', new Set(['A.var']))
      const r = planResettle({ candidates: ['C.var'], packageIndex, reverseDeps, replaceableSet })
      expect(r.toPrune.size).toBe(0)
      expect(r.decisions.get('C.var')).toEqual({ storageState: 'archived', libraryDirId: 9 })
    }

    // Path 2: lose B, then archive A
    {
      const { packageIndex, reverseDeps, replaceableSet } = mk()
      reverseDeps.set('C.var', new Set(['A.var']))
      packageIndex.set('A.var', mkPkg('archived', { dir: 9, direct: true }))
      const r = planResettle({ candidates: ['C.var'], packageIndex, reverseDeps, replaceableSet })
      expect(r.toPrune.size).toBe(0)
      expect(r.decisions.get('C.var')).toEqual({ storageState: 'archived', libraryDirId: 9 })
    }
  })
})
