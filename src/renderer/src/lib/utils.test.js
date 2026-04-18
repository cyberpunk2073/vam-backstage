import { describe, it, expect } from 'vitest'
import {
  formatBytes,
  formatStarRating,
  formatNumber,
  formatDate,
  compareContentTypes,
  compareLibraryPackageTypes,
  displayName,
  getAuthorInitials,
  getAuthorColor,
  getGradient,
  getTypeColor,
  CONTENT_TYPES,
  TYPE_COLORS,
  isCoreLibraryCategory,
  libraryTypeBadgeLabel,
} from './utils'

const NBSP = '\u00A0'

describe('formatBytes', () => {
  it('formats zero', () => {
    expect(formatBytes(0)).toBe(`0${NBSP}B`)
  })

  it('formats small byte values', () => {
    expect(formatBytes(100)).toBe(`100${NBSP}B`)
    expect(formatBytes(1)).toBe(`1${NBSP}B`)
    expect(formatBytes(1023)).toBe(`1023${NBSP}B`)
  })

  it('formats KB', () => {
    expect(formatBytes(1024)).toBe(`1${NBSP}KB`)
    expect(formatBytes(1536)).toBe(`1.5${NBSP}KB`)
  })

  it('formats MB', () => {
    expect(formatBytes(1048576)).toBe(`1${NBSP}MB`)
    expect(formatBytes(1572864)).toBe(`1.5${NBSP}MB`)
  })

  it('formats GB', () => {
    expect(formatBytes(1073741824)).toBe(`1${NBSP}GB`)
  })

  it('formats TB', () => {
    expect(formatBytes(1099511627776)).toBe(`1${NBSP}TB`)
  })

  it('rounds large values within a unit (>= 100) to integer', () => {
    expect(formatBytes(500 * 1024 * 1024)).toBe(`500${NBSP}MB`)
  })

  it('returns 0 B for negative numbers', () => {
    expect(formatBytes(-1)).toBe(`0${NBSP}B`)
  })

  it('returns 0 B for NaN / non-finite', () => {
    expect(formatBytes(NaN)).toBe(`0${NBSP}B`)
    expect(formatBytes(Infinity)).toBe(`0${NBSP}B`)
    expect(formatBytes('garbage')).toBe(`0${NBSP}B`)
  })

  it('handles string number input', () => {
    expect(formatBytes('1024')).toBe(`1${NBSP}KB`)
  })
})

describe('formatStarRating', () => {
  it('formats integer ratings without decimal', () => {
    expect(formatStarRating(4)).toBe('4')
    expect(formatStarRating(5)).toBe('5')
    expect(formatStarRating(0)).toBe('0')
  })

  it('formats fractional ratings to one decimal', () => {
    expect(formatStarRating(4.5)).toBe('4.5')
    expect(formatStarRating(3.7)).toBe('3.7')
  })

  it('rounds to one decimal place', () => {
    expect(formatStarRating(4.93)).toBe('4.9')
    expect(formatStarRating(4.95)).toBe('5')
    expect(formatStarRating(4.96)).toBe('5')
  })

  it('handles string input', () => {
    expect(formatStarRating('3.7')).toBe('3.7')
    expect(formatStarRating('5')).toBe('5')
  })

  it('returns "0" for non-finite input', () => {
    expect(formatStarRating(NaN)).toBe('0')
    expect(formatStarRating('abc')).toBe('0')
    expect(formatStarRating(Infinity)).toBe('0')
  })
})

describe('formatNumber', () => {
  it('formats numbers below 1000 as-is', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(999)).toBe('999')
  })

  it('formats thousands with k suffix', () => {
    expect(formatNumber(1000)).toBe('1.0k')
    expect(formatNumber(1500)).toBe('1.5k')
    expect(formatNumber(999999)).toBe('1000.0k')
  })

  it('formats millions with M suffix', () => {
    expect(formatNumber(1_000_000)).toBe('1.0M')
    expect(formatNumber(2_500_000)).toBe('2.5M')
  })
})

describe('formatDate', () => {
  it('returns dash for falsy input', () => {
    expect(formatDate(0)).toBe('—')
    expect(formatDate(null)).toBe('—')
    expect(formatDate(undefined)).toBe('—')
  })

  it('formats unix timestamp to readable date', () => {
    // 1704067200 = Jan 1, 2024 00:00:00 UTC
    const result = formatDate(1704067200)
    expect(result).toMatch(/Jan/)
    expect(result).toMatch(/2024/)
  })
})

describe('compareContentTypes', () => {
  it('sorts known types by CONTENT_TYPES order', () => {
    expect(compareContentTypes('Scenes', 'Looks')).toBeLessThan(0)
    expect(compareContentTypes('Hairstyles', 'Scenes')).toBeGreaterThan(0)
    expect(compareContentTypes('Scenes', 'Scenes')).toBe(0)
  })

  it('sorts unknown types after all known types', () => {
    expect(compareContentTypes('Scenes', 'Unknown')).toBeLessThan(0)
    expect(compareContentTypes('Unknown', 'Hairstyles')).toBeGreaterThan(0)
  })

  it('sorts two unknown types alphabetically', () => {
    expect(compareContentTypes('Alpha', 'Beta')).toBeLessThan(0)
    expect(compareContentTypes('Zebra', 'Alpha')).toBeGreaterThan(0)
  })
})

describe('displayName', () => {
  it('returns title when present', () => {
    expect(displayName({ title: 'Cool Scene', packageName: 'Author.Cool', filename: 'Author.Cool.1.var' })).toBe(
      'Cool Scene',
    )
  })

  it('strips author prefix from packageName', () => {
    expect(displayName({ packageName: 'Author.CoolScene', filename: 'Author.CoolScene.1.var' })).toBe('CoolScene')
  })

  it('falls back to filename when no packageName', () => {
    expect(displayName({ filename: 'Author.Thing.2.var' })).toBe('Thing.2.var')
  })

  it('returns full name when no dot present', () => {
    expect(displayName({ packageName: 'NoDot' })).toBe('NoDot')
  })
})

describe('getAuthorInitials', () => {
  it('takes first letter of each word for multi-word names', () => {
    expect(getAuthorInitials('John Doe')).toBe('JD')
  })

  it('handles hyphenated names', () => {
    expect(getAuthorInitials('Mary-Jane')).toBe('MJ')
  })

  it('handles underscore-separated names', () => {
    expect(getAuthorInitials('cool_author')).toBe('CA')
  })

  it('takes first two chars for single-word names', () => {
    expect(getAuthorInitials('Alice')).toBe('AL')
  })

  it('uppercases the result', () => {
    expect(getAuthorInitials('ab cd')).toBe('AC')
  })
})

describe('getAuthorColor', () => {
  it('returns a stable hsl string', () => {
    const c = getAuthorColor('TestAuthor')
    expect(c).toMatch(/^hsl\(\d+ 45% 35%\)$/)
  })

  it('returns same color for same input', () => {
    expect(getAuthorColor('Foo')).toBe(getAuthorColor('Foo'))
  })
})

describe('getGradient', () => {
  it('returns a CSS gradient string', () => {
    const g = getGradient('test-id')
    expect(g).toContain('radial-gradient')
    expect(g).toContain('linear-gradient')
  })

  it('is deterministic', () => {
    expect(getGradient('x')).toBe(getGradient('x'))
  })
})

describe('getTypeColor', () => {
  it('returns curated color for known types', () => {
    expect(getTypeColor('Scenes')).toBe('#3b82f6')
    expect(getTypeColor('Looks')).toBe('#ec4899')
  })

  it('returns procedural hsl for unknown types', () => {
    const c = getTypeColor('UnknownType')
    expect(c).toMatch(/^hsl\(\d+ 45% 50%\)$/)
  })
})

describe('library package type helpers', () => {
  it('isCoreLibraryCategory is true only for the five categories', () => {
    expect(isCoreLibraryCategory('Scenes')).toBe(true)
    expect(isCoreLibraryCategory('Plugins')).toBe(false)
    expect(isCoreLibraryCategory(null)).toBe(false)
    expect(isCoreLibraryCategory('')).toBe(false)
  })

  it('libraryTypeBadgeLabel maps unknown to Other', () => {
    expect(libraryTypeBadgeLabel('Scenes')).toBe('Scenes')
    expect(libraryTypeBadgeLabel('Plugins')).toBe('Other')
    expect(libraryTypeBadgeLabel(null)).toBe('Other')
  })

  it('compareLibraryPackageTypes sorts core before Other, then raw string', () => {
    expect(compareLibraryPackageTypes('Plugins', 'Scenes')).toBeGreaterThan(0)
    expect(compareLibraryPackageTypes('Scenes', 'Plugins')).toBeLessThan(0)
    expect(compareLibraryPackageTypes('Assets', 'Plugins')).toBeLessThan(0)
    expect(compareLibraryPackageTypes('Scenes', 'Looks')).toBeLessThan(0)
  })
})

describe('exported constants', () => {
  it('CONTENT_TYPES has 5 visible categories', () => {
    expect(CONTENT_TYPES).toHaveLength(5)
  })

  it('TYPE_COLORS covers all CONTENT_TYPES and Other', () => {
    for (const t of CONTENT_TYPES) {
      expect(TYPE_COLORS[t]).toBeDefined()
    }
    expect(TYPE_COLORS.Other).toBeDefined()
  })
})
