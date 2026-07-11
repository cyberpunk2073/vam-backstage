import { describe, expect, it } from 'vitest'
import { contentSearchExtras, packageSearchExtras, wishlistSearchExtras } from './search-text.js'

describe('packageSearchExtras', () => {
  it('splits no preset vs extracted by checkmark state', () => {
    expect(
      packageSearchExtras({
        noLookPresetTag: true,
        hasExtractedAppearancePreset: false,
      }),
    ).toEqual(['no preset'])
    expect(
      packageSearchExtras({
        noLookPresetTag: true,
        hasExtractedAppearancePreset: true,
      }),
    ).toEqual(['extracted'])
  })

  it('includes corrupted when the package is corrupted', () => {
    expect(packageSearchExtras({ isCorrupted: true })).toEqual(['corrupted'])
  })

  it('returns nothing for an ordinary package', () => {
    expect(packageSearchExtras({})).toEqual([])
  })
})

describe('contentSearchExtras', () => {
  it('includes subtype tag labels', () => {
    expect(contentSearchExtras({ tag: { label: 'Legacy' } })).toEqual(['Legacy'])
    expect(contentSearchExtras({ tag: { label: 'Preset' } })).toEqual(['Preset'])
    expect(contentSearchExtras({ tag: { label: 'Skin Preset' } })).toEqual(['Skin Preset'])
  })

  it('includes extracted for loose extracted presets and legacy looks with a checkmark', () => {
    expect(contentSearchExtras({ extractedFrom: 'Author.Pkg.1.var' })).toEqual(['extracted'])
    expect(contentSearchExtras({ hasExtractedAppearancePreset: true })).toEqual(['extracted'])
  })

  it('combines tag + extracted without duplicating', () => {
    expect(
      contentSearchExtras({
        tag: { label: 'Legacy' },
        hasExtractedAppearancePreset: true,
      }),
    ).toEqual(['Legacy', 'extracted'])
  })
})

describe('wishlistSearchExtras', () => {
  it('includes unavailable when the hub snapshot is gone', () => {
    expect(wishlistSearchExtras({ _unavailable: true })).toEqual(['unavailable'])
    expect(wishlistSearchExtras({})).toEqual([])
  })
})
