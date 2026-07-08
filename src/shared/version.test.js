import { describe, it, expect } from 'vitest'
import { isDevVersion } from './version'

describe('isDevVersion', () => {
  it('is true for -dev.N prerelease builds', () => {
    expect(isDevVersion('0.3.1-dev.61')).toBe(true)
    expect(isDevVersion('1.0.0-dev.1')).toBe(true)
  })

  it('is false for stable releases', () => {
    expect(isDevVersion('0.3.0')).toBe(false)
    expect(isDevVersion('1.2.3')).toBe(false)
  })

  it('is false for other prerelease tags', () => {
    expect(isDevVersion('0.3.1-beta.1')).toBe(false)
    expect(isDevVersion('0.3.1-rc.2')).toBe(false)
  })

  it('is false for non-string / empty input', () => {
    expect(isDevVersion(null)).toBe(false)
    expect(isDevVersion(undefined)).toBe(false)
    expect(isDevVersion(42)).toBe(false)
    expect(isDevVersion('')).toBe(false)
  })
})
