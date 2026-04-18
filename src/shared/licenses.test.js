import { describe, it, expect } from 'vitest'
import {
  canonicalizeLicense,
  isCommercialUseAllowed,
  getLicenseDescription,
  getHubResourceLicense,
  CC_LICENSE_LABELS,
  VAM_LICENSE_LABELS,
  LICENSE_DESCRIPTIONS,
  COMMERCIAL_USE_ALLOWED_LICENSE_FILTER,
  LICENSE_FILTER_OPTIONS,
} from './licenses'

describe('canonicalizeLicense', () => {
  it('returns null for null/undefined', () => {
    expect(canonicalizeLicense(null)).toBeNull()
    expect(canonicalizeLicense(undefined)).toBeNull()
  })

  it('returns null for empty/whitespace-only strings', () => {
    expect(canonicalizeLicense('')).toBeNull()
    expect(canonicalizeLicense('   ')).toBeNull()
  })

  it('passes through exact CC labels unchanged', () => {
    for (const label of CC_LICENSE_LABELS) {
      expect(canonicalizeLicense(label)).toBe(label)
    }
  })

  it('normalizes case variations', () => {
    expect(canonicalizeLicense('cc by')).toBe('CC BY')
    expect(canonicalizeLicense('CC BY-NC-SA')).toBe('CC BY-NC-SA')
    expect(canonicalizeLicense('Cc By-Nd')).toBe('CC BY-ND')
  })

  it('normalizes compact (no-space) variants', () => {
    expect(canonicalizeLicense('CCBY')).toBe('CC BY')
    expect(canonicalizeLicense('ccby-nc-sa')).toBe('CC BY-NC-SA')
    expect(canonicalizeLicense('CCBY-ND')).toBe('CC BY-ND')
  })

  it('passes through fully compacted forms without hyphens as unrecognized', () => {
    expect(canonicalizeLicense('ccbyncsa')).toBe('ccbyncsa')
  })

  it('normalizes cc0 / CC-0 to Public Domain', () => {
    expect(canonicalizeLicense('cc0')).toBe('Public Domain')
    expect(canonicalizeLicense('CC0')).toBe('Public Domain')
    expect(canonicalizeLicense('CC-0')).toBe('Public Domain')
    expect(canonicalizeLicense('cc-0')).toBe('Public Domain')
  })

  it('collapses extra whitespace', () => {
    expect(canonicalizeLicense('  CC   BY  ')).toBe('CC BY')
  })

  it('passes through unrecognized licenses as-is (trimmed)', () => {
    expect(canonicalizeLicense('MIT')).toBe('MIT')
    expect(canonicalizeLicense('  Custom License  ')).toBe('Custom License')
  })

  it('normalizes VaM-specific license labels', () => {
    expect(canonicalizeLicense('FC')).toBe('FC')
    expect(canonicalizeLicense('fc')).toBe('FC')
    expect(canonicalizeLicense('PC')).toBe('PC')
    expect(canonicalizeLicense('pc')).toBe('PC')
    expect(canonicalizeLicense('PC EA')).toBe('PC EA')
    expect(canonicalizeLicense('pcea')).toBe('PC EA')
    expect(canonicalizeLicense('pc-ea')).toBe('PC EA')
    expect(canonicalizeLicense('Questionable')).toBe('Questionable')
    expect(canonicalizeLicense('questionable')).toBe('Questionable')
  })

  it('coerces non-string input to string', () => {
    expect(canonicalizeLicense(42)).toBe('42')
  })
})

describe('isCommercialUseAllowed', () => {
  it('returns null for null/empty input', () => {
    expect(isCommercialUseAllowed(null)).toBeNull()
    expect(isCommercialUseAllowed('')).toBeNull()
  })

  it('returns true for commercial-friendly licenses', () => {
    expect(isCommercialUseAllowed('Public Domain')).toBe(true)
    expect(isCommercialUseAllowed('CC BY')).toBe(true)
    expect(isCommercialUseAllowed('CC BY-SA')).toBe(true)
    expect(isCommercialUseAllowed('CC BY-ND')).toBe(true)
    expect(isCommercialUseAllowed('FC')).toBe(true)
  })

  it('returns false for non-commercial CC licenses', () => {
    expect(isCommercialUseAllowed('CC BY-NC')).toBe(false)
    expect(isCommercialUseAllowed('CC BY-NC-SA')).toBe(false)
    expect(isCommercialUseAllowed('CC BY-NC-ND')).toBe(false)
  })

  it('returns false for restricted VaM-specific licenses', () => {
    expect(isCommercialUseAllowed('PC')).toBe(false)
    expect(isCommercialUseAllowed('PC EA')).toBe(false)
    expect(isCommercialUseAllowed('Questionable')).toBe(false)
  })

  it('works with non-canonical input (delegates to canonicalize)', () => {
    expect(isCommercialUseAllowed('cc0')).toBe(true)
    expect(isCommercialUseAllowed('ccby-nc-sa')).toBe(false)
    expect(isCommercialUseAllowed('CCBY')).toBe(true)
  })

  it('returns false for freeform "non-commercial" text', () => {
    expect(isCommercialUseAllowed('non-commercial')).toBe(false)
    expect(isCommercialUseAllowed('Noncommercial')).toBe(false)
  })

  it('returns null for unknown licenses', () => {
    expect(isCommercialUseAllowed('MIT')).toBeNull()
    expect(isCommercialUseAllowed('All Rights Reserved')).toBeNull()
  })
})

describe('getHubResourceLicense', () => {
  it('returns null for null/undefined resource', () => {
    expect(getHubResourceLicense(null)).toBeNull()
    expect(getHubResourceLicense(undefined)).toBeNull()
  })

  it('extracts licenseType from hubFiles[0]', () => {
    const r = { hubFiles: [{ licenseType: 'CC BY' }], licenseType: 'CC BY-NC' }
    expect(getHubResourceLicense(r)).toBe('CC BY')
  })

  it('falls back to top-level licenseType', () => {
    const r = { hubFiles: [{}], licenseType: 'CC BY-SA' }
    expect(getHubResourceLicense(r)).toBe('CC BY-SA')
  })

  it('falls back when hubFiles is missing', () => {
    expect(getHubResourceLicense({ licenseType: 'CC BY-ND' })).toBe('CC BY-ND')
  })

  it('returns null when no license field exists', () => {
    expect(getHubResourceLicense({})).toBeNull()
    expect(getHubResourceLicense({ hubFiles: [] })).toBeNull()
  })

  it('trims whitespace from the result', () => {
    expect(getHubResourceLicense({ licenseType: '  CC BY  ' })).toBe('CC BY')
  })
})

describe('getLicenseDescription', () => {
  it('returns description for known CC licenses', () => {
    expect(getLicenseDescription('CC BY')).toBe(LICENSE_DESCRIPTIONS['CC BY'])
    expect(getLicenseDescription('CC BY-NC-ND')).toBe(LICENSE_DESCRIPTIONS['CC BY-NC-ND'])
  })

  it('returns description for VaM-specific licenses', () => {
    expect(getLicenseDescription('FC')).toBe(LICENSE_DESCRIPTIONS['FC'])
    expect(getLicenseDescription('PC')).toBe(LICENSE_DESCRIPTIONS['PC'])
    expect(getLicenseDescription('PC EA')).toBe(LICENSE_DESCRIPTIONS['PC EA'])
    expect(getLicenseDescription('Questionable')).toBe(LICENSE_DESCRIPTIONS['Questionable'])
  })

  it('works with non-canonical input', () => {
    expect(getLicenseDescription('cc by-sa')).toBe(LICENSE_DESCRIPTIONS['CC BY-SA'])
    expect(getLicenseDescription('fc')).toBe(LICENSE_DESCRIPTIONS['FC'])
    expect(getLicenseDescription('pcea')).toBe(LICENSE_DESCRIPTIONS['PC EA'])
  })

  it('returns null for unknown licenses', () => {
    expect(getLicenseDescription('MIT')).toBeNull()
    expect(getLicenseDescription(null)).toBeNull()
    expect(getLicenseDescription('')).toBeNull()
  })
})

describe('exported constants', () => {
  it('CC_LICENSE_LABELS has 7 entries', () => {
    expect(CC_LICENSE_LABELS).toHaveLength(7)
  })

  it('VAM_LICENSE_LABELS has 4 entries', () => {
    expect(VAM_LICENSE_LABELS).toHaveLength(4)
  })

  it('LICENSE_FILTER_OPTIONS starts with Any then commercial-use synthetic', () => {
    expect(LICENSE_FILTER_OPTIONS[0]).toBe('Any')
    expect(LICENSE_FILTER_OPTIONS[1]).toBe(COMMERCIAL_USE_ALLOWED_LICENSE_FILTER)
    expect(LICENSE_FILTER_OPTIONS).toHaveLength(2 + CC_LICENSE_LABELS.length + VAM_LICENSE_LABELS.length)
  })
})
