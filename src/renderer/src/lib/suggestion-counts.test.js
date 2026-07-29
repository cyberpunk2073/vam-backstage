import { describe, it, expect } from 'vitest'
import { parseCommaTags, suggestionCounts, packageSuggestionCounts } from './suggestion-counts.js'

describe('parseCommaTags', () => {
  it('splits, trims, lowercases, and drops empties', () => {
    expect(parseCommaTags(' NSFW , Clothing,,Female ')).toEqual(['nsfw', 'clothing', 'female'])
  })

  it('returns [] for empty input', () => {
    expect(parseCommaTags(null)).toEqual([])
    expect(parseCommaTags('')).toEqual([])
  })
})

describe('suggestionCounts', () => {
  const pkgs = [
    { creator: 'Alice', hubTags: 'NSFW,Clothing' },
    { creator: 'Alice', hubTags: 'Clothing' },
    { creator: ' Bob ', hubTags: null },
    { creator: '', hubTags: 'Solo' },
  ]

  it('counts authors and tags over the full collection', () => {
    expect(
      suggestionCounts(pkgs, {
        author: (p) => p.creator,
        tags: (p) => p.hubTags,
      }),
    ).toEqual({
      authors: { Alice: 2, Bob: 1 },
      tags: { nsfw: 1, clothing: 2, solo: 1 },
    })
  })

  it('lowercases pre-parsed tag lists', () => {
    expect(
      suggestionCounts([{ username: 'X', tags: ['NSFW', 'Clothing'] }], {
        author: (r) => r.username,
        tags: (r) => r.tags,
      }),
    ).toEqual({ authors: { X: 1 }, tags: { nsfw: 1, clothing: 1 } })
  })

  it('tolerates missing getters', () => {
    expect(suggestionCounts([{ creator: 'A' }])).toEqual({ authors: {}, tags: {} })
  })
})

describe('packageSuggestionCounts', () => {
  it('uses creator + hubTags', () => {
    expect(
      packageSuggestionCounts([
        { creator: 'Alice', hubTags: 'Foo' },
        { creator: 'Bob', hubTags: 'Foo,Bar' },
      ]),
    ).toEqual({
      authors: { Alice: 1, Bob: 1 },
      tags: { foo: 2, bar: 1 },
    })
  })
})
