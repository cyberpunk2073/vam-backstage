import { describe, expect, it } from 'vitest'
import {
  hubInfiniteOffsetLabel,
  hubPageForVisibleResourceIndex,
  shouldFetchHubResources,
  shouldRenderHubPageNav,
} from './HubView'

describe('HubView resource fetch gate', () => {
  it('waits for filter options before the first resource fetch', () => {
    expect(
      shouldFetchHubResources({
        active: true,
        sort: 'Latest Update',
        filterOptions: null,
        fetchedFilterKey: null,
        hubFetchKey: 'looks',
      }),
    ).toBe(false)
  })

  it('allows the first resource fetch after filters load', () => {
    expect(
      shouldFetchHubResources({
        active: true,
        sort: 'Latest Update',
        filterOptions: { sort: ['Latest Update'] },
        fetchedFilterKey: null,
        hubFetchKey: 'looks',
      }),
    ).toBe(true)
  })
})

describe('HubView infinite page tracking', () => {
  it('uses the API page containing the first visible resource', () => {
    expect(hubPageForVisibleResourceIndex(0, 60, 1)).toBe(1)
    expect(hubPageForVisibleResourceIndex(59, 60, 1)).toBe(1)
    expect(hubPageForVisibleResourceIndex(60, 60, 1)).toBe(2)
    expect(hubPageForVisibleResourceIndex(119, 60, 1)).toBe(2)
  })

  it('labels non-zero infinite offsets', () => {
    expect(hubInfiniteOffsetLabel(1)).toBeNull()
    expect(hubInfiniteOffsetLabel(20)).toBe('Earlier results hidden')
  })

  it('keeps page controls in the sticky toolbar', () => {
    expect(shouldRenderHubPageNav('toolbar', 'infinite', 2)).toBe(true)
    expect(shouldRenderHubPageNav('toolbar', 'paged', 2)).toBe(true)
    expect(shouldRenderHubPageNav('top', 'infinite', 2)).toBe(false)
    expect(shouldRenderHubPageNav('bottom', 'infinite', 2)).toBe(false)
    expect(shouldRenderHubPageNav('bottom', 'paged', 2)).toBe(true)
    expect(shouldRenderHubPageNav('toolbar', 'paged', 1)).toBe(false)
  })
})
