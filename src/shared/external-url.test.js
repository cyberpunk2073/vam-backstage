import { describe, it, expect } from 'vitest'
import { normalizeExternalUrl } from './external-url'

describe('normalizeExternalUrl', () => {
  it('returns null for non-string / empty input', () => {
    expect(normalizeExternalUrl(null)).toBeNull()
    expect(normalizeExternalUrl(undefined)).toBeNull()
    expect(normalizeExternalUrl(42)).toBeNull()
    expect(normalizeExternalUrl('')).toBeNull()
    expect(normalizeExternalUrl('   ')).toBeNull()
  })

  it('passes through full http(s) links, trimmed', () => {
    expect(normalizeExternalUrl('https://www.patreon.com/molmark')).toBe('https://www.patreon.com/molmark')
    expect(normalizeExternalUrl('http://ko-fi.com/x')).toBe('http://ko-fi.com/x')
    expect(normalizeExternalUrl('  https://x.com/y  ')).toBe('https://x.com/y')
  })

  it('assumes https:// for scheme-less links (the reported bug)', () => {
    expect(normalizeExternalUrl('Patreon.com/foo')).toBe('https://patreon.com/foo')
    expect(normalizeExternalUrl('www.patreon.com/foo')).toBe('https://www.patreon.com/foo')
    expect(normalizeExternalUrl('patreon.com/foo')).toBe('https://patreon.com/foo')
  })

  it('handles protocol-relative links', () => {
    expect(normalizeExternalUrl('//patreon.com/x')).toBe('https://patreon.com/x')
  })

  it('rejects disallowed schemes', () => {
    expect(normalizeExternalUrl('mailto:a@b.com')).toBeNull()
    expect(normalizeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeExternalUrl('file:///etc/passwd')).toBeNull()
  })

  it('rejects scheme-less garbage without a dotted host', () => {
    expect(normalizeExternalUrl('not a url')).toBeNull()
    expect(normalizeExternalUrl('localhost')).toBeNull()
  })
})
