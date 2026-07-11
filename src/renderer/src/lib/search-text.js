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
