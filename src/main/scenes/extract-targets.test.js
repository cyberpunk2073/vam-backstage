import { describe, it, expect } from 'vitest'
import { sanitizeFsSegment, sceneStem, extractedPresetFileBase, extractedPresetBasename } from './extract-targets.js'

describe('sanitizeFsSegment', () => {
  it('maps `/` to `-` and strips filesystem-invalid characters', () => {
    expect(sanitizeFsSegment('a/b')).toBe('a-b')
    expect(sanitizeFsSegment('a\\:*?"<>|#b')).toBe('ab')
  })

  it('trims and coerces nullish to empty', () => {
    expect(sanitizeFsSegment('  x  ')).toBe('x')
    expect(sanitizeFsSegment(null)).toBe('')
    expect(sanitizeFsSegment(undefined)).toBe('')
  })
})

describe('sceneStem', () => {
  it('drops directory + extension and sanitizes', () => {
    expect(sceneStem('Saves/scene/My Scene.json')).toBe('My Scene')
    expect(sceneStem('Custom/a/b/Look.vap')).toBe('Look')
  })
})

describe('extractedPresetFileBase', () => {
  it('single-atom name has no atom suffix', () => {
    const { name, fileBase } = extractedPresetFileBase({
      creator: 'Author',
      internalPath: 'Saves/scene/Demo.json',
      atomId: 'Person',
      singleAtom: true,
    })
    expect(name).toBe('Demo')
    expect(fileBase).toBe('Preset_Author - Demo')
  })

  it('multi-atom name appends a sanitized atom suffix', () => {
    const { name, fileBase } = extractedPresetFileBase({
      creator: 'Author',
      internalPath: 'Saves/scene/Demo.json',
      atomId: 'Person/2',
      singleAtom: false,
    })
    expect(name).toBe('Demo_Person-2')
    expect(fileBase).toBe('Preset_Author - Demo_Person-2')
  })

  it('falls back to !local for missing creator', () => {
    expect(
      extractedPresetFileBase({ creator: '', internalPath: 'Saves/scene/X.json', atomId: 'P', singleAtom: true })
        .fileBase,
    ).toBe('Preset_!local - X')
  })
})

describe('extractedPresetBasename', () => {
  it('appends .vap to the file base (same for both kinds)', () => {
    expect(
      extractedPresetBasename({
        creator: 'Author',
        internalPath: 'Saves/scene/Demo.json',
        atomId: 'Person',
        singleAtom: true,
      }),
    ).toBe('Preset_Author - Demo.vap')
  })
})
