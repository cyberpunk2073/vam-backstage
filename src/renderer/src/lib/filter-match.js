import {
  COMMERCIAL_USE_ALLOWED_LICENSE_FILTER,
  NONCOMMERCIAL_USE_ALLOWED_LICENSE_FILTER,
  canonicalizeLicense,
  isCommercialUseAllowed,
  isNonCommercialUseAllowed,
} from '@/lib/licenses'

/**
 * Polarity (include / exclude) list match. Every selected item must pass:
 * include requires presence, exclude (negate) requires absence.
 *
 * @param {Array<string|{value: string, negate?: boolean}>} selected
 * @param {string[]} haystack values on the item (tags, label ids, …)
 * @param {{ normalize?: boolean }} [opts] when true, compare case-insensitively
 */
export function matchesPolarityList(selected, haystack, { normalize = false } = {}) {
  if (!selected?.length) return true
  const hay = normalize ? haystack.map((h) => String(h).toLowerCase()) : haystack
  for (const item of selected) {
    let value = typeof item === 'object' ? item.value : item
    if (normalize) value = String(value).toLowerCase()
    const negate = typeof item === 'object' && !!item.negate
    const has = hay.includes(value)
    if (negate ? has : !has) return false
  }
  return true
}

/** Author include (substring) + exclude-list filter. Case-insensitive. */
export function matchesAuthorFilter(subject, query, excluded = []) {
  const s = (subject || '').toLowerCase()
  if (query && !s.includes(String(query).toLowerCase())) return false
  if (excluded.some((a) => s.includes(String(a).toLowerCase()))) return false
  return true
}

/**
 * License filter: 'Any', commercial/noncommercial specials, or exact canonical match.
 * @param {string|null|undefined} license item's license string
 * @param {string} wanted filter value (LICENSE_FILTER_OPTIONS)
 */
export function matchesLicenseFilter(license, wanted) {
  if (wanted === 'Any') return true
  if (wanted === COMMERCIAL_USE_ALLOWED_LICENSE_FILTER) return isCommercialUseAllowed(license) === true
  if (wanted === NONCOMMERCIAL_USE_ALLOWED_LICENSE_FILTER) return isNonCommercialUseAllowed(license) === true
  return canonicalizeLicense(license) === canonicalizeLicense(wanted)
}

/** Stable scroll-reset key for polarity chip lists. */
export function polarityScrollKey(list) {
  return list.map((item) => (typeof item === 'object' ? `${item.value}:${item.negate ? 1 : 0}` : item)).join(',')
}
