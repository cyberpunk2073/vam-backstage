import { describe, expect, it } from 'vitest'
import { activeBreakingDependents, packageNeedsDisableConfirmation } from './package-disable-confirm.js'

describe('activeBreakingDependents', () => {
  it('keeps only enabled dependents', () => {
    expect(
      activeBreakingDependents({
        dependents: [
          { filename: 'A.var', storageState: 'enabled' },
          { filename: 'B.var', storageState: 'disabled' },
          { filename: 'C.var', storageState: 'offloaded' },
        ],
      }).map((d) => d.filename),
    ).toEqual(['A.var'])
  })

  it('treats missing storageState as enabled', () => {
    expect(activeBreakingDependents({ dependents: [{ filename: 'A.var' }] })).toHaveLength(1)
  })
})

describe('packageNeedsDisableConfirmation', () => {
  it('is false when the only dependents are already inactive', () => {
    expect(
      packageNeedsDisableConfirmation({
        storageState: 'enabled',
        dependents: [{ filename: 'B.var', storageState: 'disabled' }],
        cascadeDisableDeps: [],
      }),
    ).toBe(false)
  })

  it('is true when an enabled dependent would break', () => {
    expect(
      packageNeedsDisableConfirmation({
        storageState: 'enabled',
        dependents: [{ filename: 'B.var', storageState: 'enabled' }],
        cascadeDisableDeps: [],
      }),
    ).toBe(true)
  })

  it('is true for cascade deps even with no active dependents', () => {
    expect(
      packageNeedsDisableConfirmation({
        storageState: 'enabled',
        dependents: [{ filename: 'B.var', storageState: 'disabled' }],
        cascadeDisableDeps: [{ filename: 'Dep.var' }],
      }),
    ).toBe(true)
  })
})
