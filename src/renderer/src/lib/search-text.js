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

/** Library chip phrases with no dedicated filter (`no preset` / `extracted` / `corrupted` / `favorite`). */
export function packageSearchExtras(p) {
  const extras = []
  if (p.noLookPresetTag && !p.hasExtractedAppearancePreset) extras.push('no preset')
  if (p.hasExtractedAppearancePreset) extras.push('extracted')
  if (p.isCorrupted) extras.push('corrupted')
  if (p.favoriteContentCount > 0) extras.push('favorite')
  return extras
}

/** Content chip phrases with no dedicated filter (Legacy / Preset / extracted). */
export function contentSearchExtras(c) {
  const extras = []
  if (c.tag?.label) extras.push(c.tag.label)
  if (c.extractedFrom || c.hasExtractedAppearancePreset) extras.push('extracted')
  return extras
}

/** Wishlist chip phrases with no dedicated filter (`unavailable`). */
export function wishlistSearchExtras(r) {
  const extras = []
  if (r._unavailable) extras.push('unavailable')
  return extras
}
