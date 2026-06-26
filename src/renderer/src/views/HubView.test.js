import { describe, expect, it } from 'vitest'
import { hubPageForVisibleResourceIndex, shouldFetchHubResources } from './HubView'

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
})
