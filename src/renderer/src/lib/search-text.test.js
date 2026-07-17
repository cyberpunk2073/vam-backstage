import { describe, expect, it } from 'vitest'
import { contentFlags, libraryFlags, wishlistFlags } from './search-text.js'

describe('libraryFlags', () => {
  it('splits nopreset vs extracted by checkmark state', () => {
    expect(
      libraryFlags({
        noLookPresetTag: true,
        hasExtractedAppearancePreset: false,
      }),
    ).toEqual(['nopreset'])
    expect(
      libraryFlags({
        noLookPresetTag: true,
        hasExtractedAppearancePreset: true,
      }),
    ).toEqual(['extracted'])
  })

  it('includes corrupted / broken / wishlist / favorite when set', () => {
    expect(libraryFlags({ isCorrupted: true })).toEqual(['corrupted'])
    expect(libraryFlags({ broken: true })).toEqual(['broken'])
    expect(libraryFlags({ wishlisted: true })).toEqual(['wishlist'])
    expect(libraryFlags({ favoriteContentCount: 1 })).toEqual(['favorite'])
    expect(libraryFlags({ favoriteContentCount: 0 })).toEqual([])
  })

  it('includes storage and status flags', () => {
    expect(libraryFlags({ storageState: 'disabled' })).toEqual(['disabled'])
    expect(libraryFlags({ storageState: 'offloaded' })).toEqual(['offloaded'])
    expect(libraryFlags({ isOrphan: true })).toEqual(['orphan'])
    expect(libraryFlags({ isLocalOnly: true })).toEqual(['local'])
  })

  it('returns nothing for an ordinary package', () => {
    expect(libraryFlags({})).toEqual([])
  })
})

describe('contentFlags', () => {
  it('includes favorite / hidden / extracted', () => {
    expect(contentFlags({ favorite: true })).toEqual(['favorite'])
    expect(contentFlags({ hidden: true })).toEqual(['hidden'])
    expect(contentFlags({ extractedFrom: 'Author.Pkg.1.var' })).toEqual(['extracted'])
    expect(contentFlags({ hasExtractedAppearancePreset: true })).toEqual(['extracted'])
  })

  it('normalizes subtype tag labels to single-token flags', () => {
    expect(contentFlags({ tag: { label: 'Legacy' } })).toEqual(['legacy'])
    expect(contentFlags({ tag: { label: 'Preset' } })).toEqual(['preset'])
    expect(contentFlags({ tag: { label: 'Skin Preset' } })).toEqual(['skinpreset'])
  })

  it('combines tag + extracted without duplicating', () => {
    expect(
      contentFlags({
        tag: { label: 'Legacy' },
        hasExtractedAppearancePreset: true,
      }),
    ).toEqual(['extracted', 'legacy'])
  })
})

describe('wishlistFlags', () => {
  it('includes unavailable when the hub snapshot is gone', () => {
    expect(wishlistFlags({ _unavailable: true })).toEqual(['unavailable'])
    expect(wishlistFlags({})).toEqual([])
  })

  it('includes installed only for direct library installs', () => {
    expect(wishlistFlags({ _installed: true, _isDirect: true })).toEqual(['installed'])
    expect(wishlistFlags({ _installed: true, _isDirect: false })).toEqual([])
    expect(wishlistFlags({ _installed: false, _isDirect: false })).toEqual([])
  })
})
