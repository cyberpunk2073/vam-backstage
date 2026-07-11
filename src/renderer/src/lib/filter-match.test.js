import { describe, it, expect } from 'vitest'
import { matchesPolarityList, matchesAuthorFilter, matchesLicenseFilter, polarityScrollKey } from './filter-match.js'
import { COMMERCIAL_USE_ALLOWED_LICENSE_FILTER, NONCOMMERCIAL_USE_ALLOWED_LICENSE_FILTER } from './licenses.js'

describe('matchesPolarityList', () => {
  it('passes when selection is empty', () => {
    expect(matchesPolarityList([], ['a'])).toBe(true)
    expect(matchesPolarityList(null, ['a'])).toBe(true)
  })

  it('requires all includes to be present', () => {
    expect(matchesPolarityList(['a', 'b'], ['a', 'b', 'c'])).toBe(true)
    expect(matchesPolarityList(['a', 'b'], ['a'])).toBe(false)
  })

  it('excludes when negate matches', () => {
    expect(matchesPolarityList([{ value: 'nsfw', negate: true }], ['clothing'])).toBe(true)
    expect(matchesPolarityList([{ value: 'nsfw', negate: true }], ['nsfw'])).toBe(false)
  })

  it('mixes include and exclude', () => {
    const sel = ['clothing', { value: 'nsfw', negate: true }]
    expect(matchesPolarityList(sel, ['clothing', 'female'])).toBe(true)
    expect(matchesPolarityList(sel, ['clothing', 'nsfw'])).toBe(false)
    expect(matchesPolarityList(sel, ['female'])).toBe(false)
  })

  it('normalizes case when requested', () => {
    expect(matchesPolarityList(['NSFW'], ['nsfw'])).toBe(false)
    expect(matchesPolarityList(['NSFW'], ['nsfw'], { normalize: true })).toBe(true)
    expect(matchesPolarityList([{ value: 'NSFW', negate: true }], ['nsfw'], { normalize: true })).toBe(false)
  })
})

describe('matchesAuthorFilter', () => {
  it('passes with empty query and excludes', () => {
    expect(matchesAuthorFilter('Alice', '', [])).toBe(true)
    expect(matchesAuthorFilter('Alice', null, [])).toBe(true)
  })

  it('includes by case-insensitive substring', () => {
    expect(matchesAuthorFilter('Alice', 'ali')).toBe(true)
    expect(matchesAuthorFilter('Alice', 'bob')).toBe(false)
  })

  it('excludes by case-insensitive substring', () => {
    expect(matchesAuthorFilter('Alice', '', ['bob'])).toBe(true)
    expect(matchesAuthorFilter('Alice', '', ['ALI'])).toBe(false)
    expect(matchesAuthorFilter('Alice', 'ali', ['bob'])).toBe(true)
    expect(matchesAuthorFilter('Alice', 'ali', ['ice'])).toBe(false)
  })

  it('handles missing subject', () => {
    expect(matchesAuthorFilter(null, 'a')).toBe(false)
    expect(matchesAuthorFilter(undefined, '', ['x'])).toBe(true)
  })
})

describe('matchesLicenseFilter', () => {
  it('passes Any', () => {
    expect(matchesLicenseFilter('CC BY', 'Any')).toBe(true)
    expect(matchesLicenseFilter(null, 'Any')).toBe(true)
  })

  it('matches commercial / noncommercial specials', () => {
    // CC BY allows commercial use; CC BY-NC does not.
    expect(matchesLicenseFilter('CC BY', COMMERCIAL_USE_ALLOWED_LICENSE_FILTER)).toBe(true)
    expect(matchesLicenseFilter('CC BY-NC', COMMERCIAL_USE_ALLOWED_LICENSE_FILTER)).toBe(false)
    expect(matchesLicenseFilter('CC BY-NC', NONCOMMERCIAL_USE_ALLOWED_LICENSE_FILTER)).toBe(true)
  })

  it('matches exact canonical license', () => {
    expect(matchesLicenseFilter('CC BY', 'CC BY')).toBe(true)
    expect(matchesLicenseFilter('CC BY', 'CC BY-NC')).toBe(false)
  })
})

describe('polarityScrollKey', () => {
  it('encodes plain and polarity items', () => {
    expect(polarityScrollKey(['a', { value: 'b', negate: true }, { value: 'c', negate: false }])).toBe('a,b:1,c:0')
  })
})
