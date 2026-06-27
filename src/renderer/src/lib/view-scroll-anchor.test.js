import { describe, expect, it } from 'vitest'
import {
  resolveContentRestoreIndex,
  resolveLibraryRestoreIndex,
  shouldIgnoreTransientTop,
  shouldRestoreOnActivate,
} from './view-scroll-anchor'

describe('view scroll anchors', () => {
  it('restores library scroll from anchor before selection', () => {
    const items = [{ filename: 'A.var' }, { filename: 'B.var' }, { filename: 'C.var' }]

    expect(resolveLibraryRestoreIndex(items, 'C.var', 'A.var')).toBe(2)
    expect(resolveLibraryRestoreIndex(items, 'missing.var', 'B.var')).toBe(1)
    expect(resolveLibraryRestoreIndex(items, null, 'missing.var')).toBe(0)
  })

  it('restores content scroll from item and package anchor before selection', () => {
    const items = [
      { id: 1, packageFilename: 'A.var' },
      { id: 2, packageFilename: 'B.var' },
      { id: 2, packageFilename: 'C.var' },
    ]

    expect(resolveContentRestoreIndex(items, 2, 'C.var', 1)).toBe(2)
    expect(resolveContentRestoreIndex(items, 9, 'missing.var', 2)).toBe(1)
    expect(resolveContentRestoreIndex(items, null, null, 9)).toBe(0)
  })

  it('replays restore on page activation and ignores transient top reports', () => {
    expect(shouldRestoreOnActivate(false, true, 'A.var')).toBe(true)
    expect(shouldRestoreOnActivate(true, true, 'A.var')).toBe(false)
    expect(shouldRestoreOnActivate(false, true, null)).toBe(false)

    expect(shouldIgnoreTransientTop(true, 0, 25)).toBe(true)
    expect(shouldIgnoreTransientTop(true, 5, 25)).toBe(false)
    expect(shouldIgnoreTransientTop(true, 0, 0)).toBe(false)
  })
})
