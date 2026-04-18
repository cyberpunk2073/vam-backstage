/**
 * License labels aligned with VaM hub / package meta (licenseType).
 * Covers both Creative Commons licenses and VaM-specific license types.
 * Shared by main (hub search filter) and renderer (UI tags + library filter).
 */

export const CC_LICENSE_LABELS = [
  'Public Domain',
  'CC BY',
  'CC BY-SA',
  'CC BY-ND',
  'CC BY-NC',
  'CC BY-NC-SA',
  'CC BY-NC-ND',
]

export const VAM_LICENSE_LABELS = ['FC', 'PC', 'PC EA', 'Questionable']

/** Brief tooltip descriptions for each known license type. */
export const LICENSE_DESCRIPTIONS = {
  'Public Domain': 'No restrictions. Free to use, modify, and distribute for any purpose.',
  'CC BY': 'Distribute, remix, and build upon, even commercially. Must credit the original creator.',
  'CC BY-SA':
    'Distribute, remix, and build upon, even commercially. Must credit and use the same license for derivatives.',
  'CC BY-ND': 'Redistribute commercially or non-commercially, but cannot modify. Must credit the original creator.',
  'CC BY-NC': 'Distribute, remix, and build upon non-commercially only. Must credit the original creator.',
  'CC BY-NC-SA':
    'Distribute, remix, and build upon non-commercially only. Must credit and use the same license for derivatives.',
  'CC BY-NC-ND':
    'Most restrictive CC license. Share unchanged only, non-commercially, with credit to the original creator.',
  FC: 'Free Content: distribute, remix, and build upon, even commercially. No credit required.',
  PC: 'Paid Content: cannot distribute, remix, tweak, or build upon.',
  'PC EA':
    'Paid Content Early Access: same restrictions as PC until the EA end date, then the secondary license applies.',
  Questionable: 'Content origin cannot be determined. Should not distribute.',
}

/** Synthetic hub/library license filter: Public Domain, CC BY, CC BY-SA, CC BY-ND, FC (excludes *-NC*, PC, Questionable). */
export const COMMERCIAL_USE_ALLOWED_LICENSE_FILTER = 'Commercial use allowed'

export const LICENSE_FILTER_OPTIONS = [
  'Any',
  COMMERCIAL_USE_ALLOWED_LICENSE_FILTER,
  ...CC_LICENSE_LABELS,
  ...VAM_LICENSE_LABELS,
]

const ALL_KNOWN_LABELS = [...CC_LICENSE_LABELS, ...VAM_LICENSE_LABELS]

const COMMERCIAL_ALLOWED = new Set(['Public Domain', 'CC BY', 'CC BY-SA', 'CC BY-ND', 'FC'])
const COMMERCIAL_DENIED = new Set(['PC', 'PC EA', 'Questionable'])

const CANONICAL_BY_COMPACT_KEY = (() => {
  const m = new Map()
  for (const label of ALL_KNOWN_LABELS) {
    m.set(label.replace(/\s/g, '').toLowerCase(), label)
  }
  m.set('cc0', 'Public Domain')
  m.set('cc-0', 'Public Domain')
  m.set('pcea', 'PC EA')
  m.set('pc-ea', 'PC EA')
  return m
})()

export function canonicalizeLicense(raw) {
  if (raw == null) return null
  const s = String(raw).trim().replace(/\s+/g, ' ')
  if (!s) return null
  const fromMap = CANONICAL_BY_COMPACT_KEY.get(s.replace(/\s/g, '').toLowerCase())
  if (fromMap) return fromMap
  for (const label of ALL_KNOWN_LABELS) {
    if (s.toLowerCase() === label.toLowerCase()) return label
  }
  return s
}

export function isCommercialUseAllowed(raw) {
  const c = canonicalizeLicense(raw)
  if (!c) return null
  if (COMMERCIAL_ALLOWED.has(c)) return true
  if (COMMERCIAL_DENIED.has(c)) return false
  if (c.startsWith('CC BY-NC') || (c.startsWith('CC ') && c.includes('-NC'))) return false
  if (CC_LICENSE_LABELS.includes(c)) return !c.includes('-NC')
  if (/non-?commercial/i.test(c)) return false
  return null
}

export function getLicenseDescription(raw) {
  const c = canonicalizeLicense(raw)
  return (c && LICENSE_DESCRIPTIONS[c]) || null
}

export function getHubResourceLicense(resource) {
  if (!resource) return null
  const t = resource.hubFiles?.[0]?.licenseType ?? resource.licenseType
  return t ? String(t).trim() : null
}
