/** Whitespace-separated query tokens for AND-style matching (each must match somewhere). */
export function searchAndTerms(search) {
  return String(search || '')
    .trim()
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)
}

/** Each term must occur as a substring of at least one haystack string (case-insensitive). */
export function haystacksMatchAllTerms(haystacks, termsLower) {
  if (!termsLower.length) return true
  const lowered = haystacks.map((s) => (s || '').toLowerCase())
  return termsLower.every((term) => lowered.some((h) => h.includes(term)))
}

/** Autocomplete values for Library `is:` flags. */
export const LIBRARY_IS_FLAGS = [
  'favorite',
  'wishlist',
  'extracted',
  'corrupted',
  'broken',
  'orphan',
  'local',
  'disabled',
  'offloaded',
  'nopreset',
]

/**
 * Lowercased `is:` flags for a library package.
 * Caller may set `broken` / `wishlisted` (computed outside).
 */
export function libraryFlags(p) {
  const flags = []
  if (p.favoriteContentCount > 0) flags.push('favorite')
  if (p.wishlisted) flags.push('wishlist')
  if (p.hasExtractedAppearancePreset) flags.push('extracted')
  if (p.isCorrupted) flags.push('corrupted')
  if (p.broken) flags.push('broken')
  if (p.isOrphan) flags.push('orphan')
  if (p.isLocalOnly) flags.push('local')
  if (p.storageState === 'disabled') flags.push('disabled')
  if (p.storageState === 'offloaded') flags.push('offloaded')
  if (p.noLookPresetTag && !p.hasExtractedAppearancePreset) flags.push('nopreset')
  return flags
}

/** Autocomplete values for Content `is:` flags. */
export const CONTENT_IS_FLAGS = ['favorite', 'hidden', 'extracted', 'legacy', 'preset']

/** Lowercased `is:` flags for a content item. */
export function contentFlags(c) {
  const flags = []
  if (c.favorite) flags.push('favorite')
  if (c.hidden) flags.push('hidden')
  if (c.extractedFrom || c.hasExtractedAppearancePreset) flags.push('extracted')
  const tag = (c.tag?.label || '').toLowerCase().replace(/\s+/g, '')
  if (tag) flags.push(tag)
  return flags
}

/** Autocomplete values for Hub wishlist `is:` flags. */
export const WISHLIST_IS_FLAGS = ['unavailable', 'installed']

/** Lowercased `is:` flags for a wishlist hub resource. */
export function wishlistFlags(r) {
  const flags = []
  if (r._unavailable) flags.push('unavailable')
  // Direct library install ("View in Library") — deps alone don't count.
  if (r._installed && r._isDirect) flags.push('installed')
  return flags
}
