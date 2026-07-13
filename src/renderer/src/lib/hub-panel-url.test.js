import { describe, expect, it } from 'vitest'
import { toFullHubUrl } from './hub-panel-url.js'

describe('toFullHubUrl', () => {
  it('maps known resource panel URLs to full pages', () => {
    const slug = 'yavam-yet-another-vam-addon-manager.63748'
    expect(toFullHubUrl(`https://hub.virtamate.com/resources/${slug}/overview-panel`)).toBe(
      `https://hub.virtamate.com/resources/${slug}/`,
    )
    expect(toFullHubUrl(`https://hub.virtamate.com/resources/${slug}/review-panel`)).toBe(
      `https://hub.virtamate.com/resources/${slug}/reviews`,
    )
    expect(toFullHubUrl(`https://hub.virtamate.com/resources/${slug}/history-panel`)).toBe(
      `https://hub.virtamate.com/resources/${slug}/history`,
    )
    expect(toFullHubUrl(`https://hub.virtamate.com/resources/${slug}/updates-panel`)).toBe(
      `https://hub.virtamate.com/resources/${slug}/updates`,
    )
  })

  it('maps discussion panel to the full thread URL', () => {
    const slug = 'yavam-yet-another-vam-addon-manager.73227'
    expect(toFullHubUrl(`https://hub.virtamate.com/threads/${slug}/discussion-panel`)).toBe(
      `https://hub.virtamate.com/threads/${slug}/`,
    )
  })

  it('works with numeric ids before Hub slug-redirect', () => {
    expect(toFullHubUrl('https://hub.virtamate.com/resources/63748/overview-panel')).toBe(
      'https://hub.virtamate.com/resources/63748/',
    )
    expect(toFullHubUrl('https://hub.virtamate.com/resources/63748/review-panel/')).toBe(
      'https://hub.virtamate.com/resources/63748/reviews',
    )
    expect(toFullHubUrl('https://hub.virtamate.com/threads/73227/discussion-panel')).toBe(
      'https://hub.virtamate.com/threads/73227/',
    )
  })

  it('returns non-panel / non-hub URLs unchanged', () => {
    expect(toFullHubUrl('https://hub.virtamate.com/resources/63748/')).toBe(
      'https://hub.virtamate.com/resources/63748/',
    )
    expect(toFullHubUrl('https://hub.virtamate.com/resources/63748/reviews')).toBe(
      'https://hub.virtamate.com/resources/63748/reviews',
    )
    expect(toFullHubUrl('https://hub.virtamate.com/members/foo.1/')).toBe('https://hub.virtamate.com/members/foo.1/')
    expect(toFullHubUrl('https://example.com/overview-panel')).toBe('https://example.com/overview-panel')
  })

  it('passes through empty / invalid input', () => {
    expect(toFullHubUrl('')).toBe('')
    expect(toFullHubUrl(null)).toBe(null)
    expect(toFullHubUrl('not a url')).toBe('not a url')
  })
})
