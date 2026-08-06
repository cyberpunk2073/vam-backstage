import { describe, it, expect } from 'vitest'
import { hubPackageBaseName, resourceDetailMatchesPackageName } from './client.js'

describe('hubPackageBaseName', () => {
  it('strips .var and numeric version', () => {
    expect(hubPackageBaseName('Author.Pkg.12.var')).toBe('Author.Pkg')
    expect(hubPackageBaseName('Author.Pkg.12')).toBe('Author.Pkg')
  })

  it('strips .latest and .minN', () => {
    expect(hubPackageBaseName('Author.Pkg.latest')).toBe('Author.Pkg')
    expect(hubPackageBaseName('AcidBubbles.Timeline.min178')).toBe('AcidBubbles.Timeline')
  })

  it('keeps a bare package base', () => {
    expect(hubPackageBaseName('Author.Pkg')).toBe('Author.Pkg')
  })

  it('keeps multi-dot package names', () => {
    expect(hubPackageBaseName('A.B.C.123.var')).toBe('A.B.C')
  })
})

describe('resourceDetailMatchesPackageName', () => {
  it('accepts when hubFiles lists the package', () => {
    const detail = {
      resource_id: '1975',
      hubFiles: [{ filename: 'MacGruber.LogicBricks.14.var' }, { filename: 'MacGruber.LogicBricksDemo.14.var' }],
      dependencies: { 'MacGruber.LogicBricksDemo': [] },
    }
    expect(resourceDetailMatchesPackageName(detail, 'MacGruber.LogicBricks')).toBe(true)
    expect(resourceDetailMatchesPackageName(detail, 'MacGruber.LogicBricksDemo')).toBe(true)
  })

  it('accepts paid co-packaged mains via dependencies outer keys', () => {
    const detail = {
      resource_id: '64053',
      title: 'Valerie',
      hubFiles: undefined,
      dependencies: {
        'MonsterShinkai.Hair_Long14': [{ packageName: 'MonsterShinkai.Hair_Long6' }],
        'MonsterShinkai.Valerie': [{ packageName: 'MonsterShinkai.Hair_Long14' }],
      },
    }
    expect(resourceDetailMatchesPackageName(detail, 'MonsterShinkai.Valerie')).toBe(true)
    expect(resourceDetailMatchesPackageName(detail, 'MonsterShinkai.Hair_Long14')).toBe(true)
    // Nested unpaid dep is listed inside Valerie's array, not as an outer key.
    expect(resourceDetailMatchesPackageName(detail, 'MonsterShinkai.Hair_Long6')).toBe(false)
  })

  it('rejects a look that only depends on the queried package', () => {
    const detail = {
      resource_id: '48867',
      title: 'Rumi',
      hubFiles: [],
      dependencies: {
        'MonsterShinkai.Rumi': [
          { packageName: 'MonsterShinkai.Hair_Long6', filename: 'MonsterShinkai.Hair_Long6.latest', resource_id: null },
        ],
      },
    }
    expect(resourceDetailMatchesPackageName(detail, 'MonsterShinkai.Hair_Long6')).toBe(false)
    expect(resourceDetailMatchesPackageName(detail, 'MonsterShinkai.Rumi')).toBe(true)
  })

  it('accepts renamed packages when Hub echoes the old name as a deps key', () => {
    // Jackaroo.Eyes → Eyes! Lips! Nails!; hubFiles only has the new name, but
    // the dependencies key echoes the queried ref (with .latest / .N).
    const detail = {
      resource_id: '4933',
      hubFiles: [{ filename: 'Jackaroo.Eyes_Lips_Nails!.5.var' }],
      dependencies: { 'Jackaroo.Eyes.latest': [] },
    }
    expect(resourceDetailMatchesPackageName(detail, 'Jackaroo.Eyes')).toBe(true)
    expect(resourceDetailMatchesPackageName(detail, 'Jackaroo.Eyes_Lips_Nails!')).toBe(true)
  })

  it('accepts deps keys that echo a concrete version', () => {
    const detail = {
      resource_id: '20883',
      hubFiles: [{ filename: 'everlaster.FloatParamRandomizerEE.5.var' }],
      dependencies: { 'everlaster.FloatParamRandomizerEE.5': [] },
    }
    expect(resourceDetailMatchesPackageName(detail, 'everlaster.FloatParamRandomizerEE')).toBe(true)
  })

  it('matches deps keys / hubFiles case-insensitively', () => {
    // Paid listing: no hubFiles; Hub keeps creator casing on the deps key while
    // the local .var (and package_name query) may be all-lowercase.
    const detail = {
      resource_id: '67307',
      title: 'Skallet Jo',
      hubFiles: undefined,
      dependencies: {
        'caelryn.Skallet': [{ packageName: 'AcidBubbles.ColliderEditor' }],
      },
    }
    expect(resourceDetailMatchesPackageName(detail, 'caelryn.skallet')).toBe(true)
    expect(resourceDetailMatchesPackageName(detail, 'Caelryn.Skallet')).toBe(true)
    expect(resourceDetailMatchesPackageName(detail, 'caelryn.Skallet')).toBe(true)

    const withFiles = {
      resource_id: '1',
      hubFiles: [{ filename: 'Author.MyPkg.3.var' }],
      dependencies: {},
    }
    expect(resourceDetailMatchesPackageName(withFiles, 'author.mypkg')).toBe(true)
  })

  it('returns false without a resource_id', () => {
    expect(resourceDetailMatchesPackageName(null, 'A.B')).toBe(false)
    expect(resourceDetailMatchesPackageName({}, 'A.B')).toBe(false)
  })
})
