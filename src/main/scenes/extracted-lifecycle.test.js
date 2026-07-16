import { describe, it, expect } from 'vitest'
import {
  liveExtractedPath,
  extractedRenamePlan,
  extractedDeletePaths,
  extractedShouldDisable,
  extractedHasSurvivor,
} from './extracted-lifecycle.js'

const APP = 'Custom/Atom/Person/Appearance/extracted/Preset_A - Look.vap'

describe('liveExtractedPath', () => {
  it('strips a trailing .disabled, leaves live paths untouched', () => {
    expect(liveExtractedPath(APP + '.disabled')).toBe(APP)
    expect(liveExtractedPath(APP)).toBe(APP)
  })
})

describe('extractedRenamePlan', () => {
  it('disable: only the .vap moves — sidecars stay on the canonical live stem', () => {
    expect(extractedRenamePlan(APP, true)).toEqual([{ from: APP, to: APP + '.disabled', optional: false }])
  })

  it('enable: .disabled -> live regardless of the input form', () => {
    const fromDisabled = extractedRenamePlan(APP + '.disabled', false)
    const fromLive = extractedRenamePlan(APP, false)
    expect(fromDisabled).toEqual(fromLive)
    expect(fromLive).toEqual([{ from: APP + '.disabled', to: APP, optional: false }])
  })

  it('does not rename the .jpg thumbnail or the .hide/.fav sidecars', () => {
    const froms = extractedRenamePlan(APP, true).map((p) => p.from)
    expect(froms).toEqual([APP])
  })
})

describe('extractedDeletePaths', () => {
  it('covers both .vap forms, both .jpg forms, and sidecars — from either input form', () => {
    const expected = [
      APP,
      APP + '.disabled',
      APP.replace(/\.vap$/, '.jpg'),
      APP.replace(/\.vap$/, '.jpg') + '.disabled',
      APP + '.hide',
      APP + '.fav',
      APP + '.disabled.hide',
      APP + '.disabled.fav',
    ]
    expect(extractedDeletePaths(APP)).toEqual(expected)
    expect(extractedDeletePaths(APP + '.disabled')).toEqual(expected)
  })
})

describe('extractedShouldDisable', () => {
  const isActive = (fn) => fn === 'active.var'

  it('disables when no candidate is active', () => {
    expect(extractedShouldDisable(['a.var', 'b.var'], isActive)).toBe(true)
  })

  it('stays enabled when any candidate is active', () => {
    expect(extractedShouldDisable(['a.var', 'active.var'], isActive)).toBe(false)
  })

  it('treats empty/undefined candidates as should-disable', () => {
    expect(extractedShouldDisable([], isActive)).toBe(true)
    expect(extractedShouldDisable(undefined, isActive)).toBe(true)
  })
})

describe('extractedHasSurvivor', () => {
  const survives = (fn) => fn === 'kept.var'

  it('true when a candidate survives removal', () => {
    expect(extractedHasSurvivor(['gone.var', 'kept.var'], survives)).toBe(true)
  })

  it('false when every candidate is removed', () => {
    expect(extractedHasSurvivor(['gone.var'], survives)).toBe(false)
    expect(extractedHasSurvivor(undefined, survives)).toBe(false)
  })
})
