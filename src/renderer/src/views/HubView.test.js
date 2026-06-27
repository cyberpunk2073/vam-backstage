import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  hubInfiniteOffsetLabel,
  hubPageCountLabel,
  hubPageForVisibleResourceIndex,
  shouldFetchHubResources,
  shouldRenderHubPageNav,
  shouldRenderHubPageSummary,
} from './HubView'

const hubView = readFileSync(resolve(import.meta.dirname, 'HubView.jsx'), 'utf8')

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

  it('keeps infinite page label neutral', () => {
    expect(hubInfiniteOffsetLabel({ startPage: 1, restorePage: 20 })).toBe('Page')
    expect(hubInfiniteOffsetLabel({ startPage: 20, restorePage: 20 })).toBe('Page')
  })

  it('formats reported total pages without approximation', () => {
    expect(hubPageCountLabel(300)).toBe('300')
    expect(hubPageCountLabel(190)).toBe('190')
  })

  it('uses compact page size wording', () => {
    expect(hubView).toContain('Page size')
    expect(hubView).toContain('aria-label="Hub page size"')
    expect(hubView).not.toContain('/ page')
  })

  it('keeps page controls in the sticky toolbar', () => {
    expect(shouldRenderHubPageNav('toolbar', 'infinite', 2)).toBe(true)
    expect(shouldRenderHubPageNav('toolbar', 'paged', 2)).toBe(true)
    expect(shouldRenderHubPageNav('toolbar', 'infinite', 2, false)).toBe(false)
    expect(shouldRenderHubPageNav('toolbar', 'paged', 2, false)).toBe(true)
    expect(shouldRenderHubPageNav('top', 'infinite', 2)).toBe(false)
    expect(shouldRenderHubPageNav('bottom', 'infinite', 2)).toBe(false)
    expect(shouldRenderHubPageNav('bottom', 'paged', 2)).toBe(true)
    expect(shouldRenderHubPageNav('toolbar', 'paged', 1)).toBe(false)
  })

  it('hides infinite page summary with infinite page controls', () => {
    expect(shouldRenderHubPageSummary('infinite', false)).toBe(false)
    expect(shouldRenderHubPageSummary('infinite', true)).toBe(true)
    expect(shouldRenderHubPageSummary('paged', false)).toBe(true)
  })

  it('wires infinite scrolling to start on the last page', () => {
    expect(hubView).toContain('onClick={() => goInfiniteStartPage(maxHubPage)}')
    expect(hubView).toContain("'Start on last page'")
    expect(hubView).toContain("'Check for last Hub page'")
  })

  it('wires wheel-up loading for earlier infinite pages', () => {
    expect(hubView).toContain('fetchPreviousPage')
    expect(hubView).toContain('onWheel={handleGalleryWheel}')
    expect(hubView).toContain('restoreHubScrollAnchor')
  })
})
