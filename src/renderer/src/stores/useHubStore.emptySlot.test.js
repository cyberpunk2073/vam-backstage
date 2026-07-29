import { describe, it, expect } from 'vitest'
import { HUB_EMPTY_SLOT, isHubEmptySlot, applyPageToIndex } from './useHubStore.js'
import { HUB_PER_PAGE } from '@shared/hub-http.js'

describe('isHubEmptySlot', () => {
  it('recognises the sentinel', () => {
    expect(isHubEmptySlot(HUB_EMPTY_SLOT)).toBe(true)
    expect(isHubEmptySlot({ _hubEmpty: true })).toBe(true)
    expect(isHubEmptySlot(null)).toBe(false)
    expect(isHubEmptySlot({ resource_id: '1' })).toBe(false)
  })
})

describe('applyPageToIndex', () => {
  it('places resources and fills the rest of the page with empty slots', () => {
    const byIndex = {}
    const resources = [{ resource_id: 'a' }, { resource_id: 'b' }]
    applyPageToIndex(byIndex, 1, resources, 100, 5)
    expect(byIndex[0]).toEqual({ resource_id: 'a' })
    expect(byIndex[1]).toEqual({ resource_id: 'b' })
    expect(isHubEmptySlot(byIndex[2])).toBe(true)
    expect(isHubEmptySlot(byIndex[3])).toBe(true)
    expect(isHubEmptySlot(byIndex[4])).toBe(true)
    expect(byIndex[5]).toBeUndefined()
  })

  it('marks a fully empty page as empty slots only', () => {
    const byIndex = {}
    applyPageToIndex(byIndex, 2, [], 100, 5)
    expect(
      Object.keys(byIndex)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([5, 6, 7, 8, 9])
    for (let i = 5; i < 10; i++) expect(isHubEmptySlot(byIndex[i])).toBe(true)
  })

  it('clips the last page to itemCount', () => {
    const byIndex = {}
    applyPageToIndex(byIndex, 1, [], 3, 5)
    expect(
      Object.keys(byIndex)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([0, 1, 2])
  })

  it('uses HUB_PER_PAGE by default', () => {
    const byIndex = {}
    applyPageToIndex(byIndex, 1, [{ resource_id: 'x' }], HUB_PER_PAGE)
    expect(byIndex[0]).toEqual({ resource_id: 'x' })
    expect(isHubEmptySlot(byIndex[HUB_PER_PAGE - 1])).toBe(true)
    expect(byIndex[HUB_PER_PAGE]).toBeUndefined()
  })
})
