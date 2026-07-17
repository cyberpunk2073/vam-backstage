import { describe, it, expect } from 'vitest'
import { parseSmartQuery, tokenAtCaret, spliceToken, matchesSmartQuery, highlightSegments } from './smart-search.js'

describe('parseSmartQuery', () => {
  it('parses plain AND terms', () => {
    expect(parseSmartQuery('foo bar')).toEqual({
      tokens: [
        { field: 'text', value: 'foo', negate: false },
        { field: 'text', value: 'bar', negate: false },
      ],
      hasSyntax: false,
    })
  })

  it('parses sigils and negation', () => {
    expect(parseSmartQuery('-@bob #nsfw !%wip -preview')).toEqual({
      tokens: [
        { field: 'author', value: 'bob', negate: true },
        { field: 'tag', value: 'nsfw', negate: false },
        { field: 'label', value: 'wip', negate: true },
        { field: 'text', value: 'preview', negate: true },
      ],
      hasSyntax: true,
    })
  })

  it('parses type sigil and is:/pkg: keys', () => {
    expect(parseSmartQuery('^Scenes -is:broken pkg:Other')).toEqual({
      tokens: [
        { field: 'type', value: 'scenes', negate: false },
        { field: 'is', value: 'broken', negate: true },
        { field: 'pkg', value: 'other', negate: false },
      ],
      hasSyntax: true,
    })
  })

  it('accepts key: long forms as aliases of sigils', () => {
    expect(parseSmartQuery('author:bob tag:nsfw label:wip type:scenes')).toEqual({
      tokens: [
        { field: 'author', value: 'bob', negate: false },
        { field: 'tag', value: 'nsfw', negate: false },
        { field: 'label', value: 'wip', negate: false },
        { field: 'type', value: 'scenes', negate: false },
      ],
      hasSyntax: true,
    })
  })

  it('falls back to text for unknown keys and bare colons in names', () => {
    expect(parseSmartQuery('http://x Author.Thing:2')).toEqual({
      tokens: [
        { field: 'text', value: 'http://x', negate: false },
        { field: 'text', value: 'author.thing:2', negate: false },
      ],
      hasSyntax: false,
    })
  })

  it('skips bare prefixes but still flags syntax', () => {
    expect(parseSmartQuery('# @ - ^ is:')).toEqual({ tokens: [], hasSyntax: true })
  })

  it('treats empty / whitespace as no tokens', () => {
    expect(parseSmartQuery('')).toEqual({ tokens: [], hasSyntax: false })
    expect(parseSmartQuery('   ')).toEqual({ tokens: [], hasSyntax: false })
  })

  it('flags syntax for negate and sigil tokens', () => {
    expect(parseSmartQuery('hello').hasSyntax).toBe(false)
    expect(parseSmartQuery('#tag').hasSyntax).toBe(true)
    expect(parseSmartQuery('^Scenes').hasSyntax).toBe(true)
    expect(parseSmartQuery('is:broken').hasSyntax).toBe(true)
    expect(parseSmartQuery('-foo').hasSyntax).toBe(true)
    expect(parseSmartQuery('a !b').hasSyntax).toBe(true)
  })
})

describe('tokenAtCaret', () => {
  it('finds the token under the caret, including mid-token edits', () => {
    const text = 'foo #clo bar'
    // caret inside #clo
    expect(tokenAtCaret(text, 6)).toMatchObject({
      start: 4,
      end: 8,
      field: 'tag',
      query: 'clo',
      prefix: '#',
      completable: true,
    })
  })

  it('treats caret after a token (before space) as that token', () => {
    expect(tokenAtCaret('@mac ', 4)).toMatchObject({
      field: 'author',
      query: 'mac',
      completable: true,
    })
  })

  it('returns null between tokens', () => {
    expect(tokenAtCaret('a  b', 2)).toBe(null)
  })

  it('strips negate + sigil for the query', () => {
    expect(tokenAtCaret('-%wip', 5)).toMatchObject({
      negate: true,
      field: 'label',
      query: 'wip',
      prefix: '-%',
      completable: true,
    })
  })

  it('preserves key: prefix when completing long forms', () => {
    expect(tokenAtCaret('-is:bro', 7)).toMatchObject({
      negate: true,
      field: 'is',
      query: 'bro',
      prefix: '-is:',
      completable: true,
    })
    expect(tokenAtCaret('type:Sce', 8)).toMatchObject({
      field: 'type',
      query: 'sce',
      prefix: 'type:',
      completable: true,
    })
  })

  it('marks plain tokens as not completable', () => {
    expect(tokenAtCaret('hello', 3)).toMatchObject({ field: 'text', completable: false })
  })
})

describe('spliceToken', () => {
  it('replaces the active token and adds a trailing space at EOS', () => {
    const text = 'x #clo'
    const tok = tokenAtCaret(text, 5)
    expect(spliceToken(text, tok, 'clothing')).toBe('x #clothing ')
  })

  it('preserves negate + sigil prefix', () => {
    const text = '-@mac'
    const tok = tokenAtCaret(text, 5)
    expect(spliceToken(text, tok, 'MacGruber')).toBe('-@MacGruber ')
  })

  it('preserves key: prefix when splicing', () => {
    const text = 'is:bro'
    const tok = tokenAtCaret(text, 6)
    expect(spliceToken(text, tok, 'broken')).toBe('is:broken ')
  })
})

describe('highlightSegments', () => {
  it('reconstructs the original text exactly', () => {
    const text = '  cool -@bob   #nsfw -preview '
    expect(
      highlightSegments(text)
        .map((s) => s.text)
        .join(''),
    ).toBe(text)
  })

  it('classifies negate, sigil, value, text and spaces', () => {
    expect(highlightSegments('-@bob plain')).toEqual([
      { text: '-', kind: 'negate' },
      { text: '@', kind: 'sigil', field: 'author', negate: true },
      { text: 'bob', kind: 'value', field: 'author', negate: true },
      { text: ' ', kind: 'space' },
      { text: 'plain', kind: 'text', negate: false },
    ])
  })

  it('classifies key: segments', () => {
    expect(highlightSegments('-is:broken type:Scenes')).toEqual([
      { text: '-', kind: 'negate' },
      { text: 'is:', kind: 'key', field: 'is', negate: true },
      { text: 'broken', kind: 'value', field: 'is', negate: true },
      { text: ' ', kind: 'space' },
      { text: 'type:', kind: 'key', field: 'type', negate: false },
      { text: 'Scenes', kind: 'value', field: 'type', negate: false },
    ])
  })

  it('emits partial tokens while typing (sigil with no value, bare negate)', () => {
    expect(highlightSegments('#')).toEqual([{ text: '#', kind: 'sigil', field: 'tag', negate: false }])
    expect(highlightSegments('^')).toEqual([{ text: '^', kind: 'sigil', field: 'type', negate: false }])
    expect(highlightSegments('-')).toEqual([{ text: '-', kind: 'negate' }])
    expect(highlightSegments('-%')).toEqual([
      { text: '-', kind: 'negate' },
      { text: '%', kind: 'sigil', field: 'label', negate: true },
    ])
    expect(highlightSegments('is:')).toEqual([{ text: 'is:', kind: 'key', field: 'is', negate: false }])
  })

  it('returns nothing for empty input', () => {
    expect(highlightSegments('')).toEqual([])
  })
})

describe('matchesSmartQuery', () => {
  const item = {
    text: () => ['Cool Scene', 'Author.Pkg'],
    author: () => 'MacGruber',
    tags: () => ['clothing', 'nsfw'],
    labels: () => ['WIP', 'Favorite'],
    types: () => ['Scenes'],
    pkgTypes: () => ['Looks'],
    flags: () => ['broken', 'wishlist'],
  }

  it('ANDs positive tokens across fields', () => {
    const { tokens } = parseSmartQuery('cool @mac #clothing %wip ^Scenes is:broken')
    expect(matchesSmartQuery(tokens, item)).toBe(true)
  })

  it('matches key: long forms the same as sigils', () => {
    expect(matchesSmartQuery(parseSmartQuery('type:scenes author:mac').tokens, item)).toBe(true)
    expect(matchesSmartQuery(parseSmartQuery('pkg:looks').tokens, item)).toBe(true)
  })

  it('rejects when an include misses', () => {
    const { tokens } = parseSmartQuery('#missing')
    expect(matchesSmartQuery(tokens, item)).toBe(false)
    expect(matchesSmartQuery(parseSmartQuery('^Looks').tokens, item)).toBe(false)
    expect(matchesSmartQuery(parseSmartQuery('is:orphan').tokens, item)).toBe(false)
  })

  it('rejects when an exclude hits', () => {
    expect(matchesSmartQuery(parseSmartQuery('-@mac').tokens, item)).toBe(false)
    expect(matchesSmartQuery(parseSmartQuery('-#nsfw').tokens, item)).toBe(false)
    expect(matchesSmartQuery(parseSmartQuery('-%wip').tokens, item)).toBe(false)
    expect(matchesSmartQuery(parseSmartQuery('-cool').tokens, item)).toBe(false)
    expect(matchesSmartQuery(parseSmartQuery('-^Scenes').tokens, item)).toBe(false)
    expect(matchesSmartQuery(parseSmartQuery('-is:broken').tokens, item)).toBe(false)
  })

  it('passes when an exclude misses', () => {
    expect(matchesSmartQuery(parseSmartQuery('-@bob -#other -%gone -zzz -^Looks -is:orphan').tokens, item)).toBe(true)
  })

  it('matches empty query', () => {
    expect(matchesSmartQuery([], item)).toBe(true)
  })
})
