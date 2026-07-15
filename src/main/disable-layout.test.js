import { describe, it, expect } from 'vitest'
import { classifyMainVar } from './disable-layout.js'

describe('classifyMainVar', () => {
  it('bare only → enabled', () => {
    expect(classifyMainVar({ bareSize: 1000, disabledSize: null })).toEqual({
      present: true,
      storageState: 'enabled',
      contentInDisabled: false,
    })
  })

  it('bare + empty marker → disabled marker layout (content in bare)', () => {
    expect(classifyMainVar({ bareSize: 1000, disabledSize: 0 })).toEqual({
      present: true,
      storageState: 'disabled',
      contentInDisabled: false,
    })
  })

  it('bare + non-empty .disabled → still marker layout (bare holds content)', () => {
    expect(classifyMainVar({ bareSize: 1000, disabledSize: 1000 })).toEqual({
      present: true,
      storageState: 'disabled',
      contentInDisabled: false,
    })
  })

  it('.disabled only (non-empty) → legacy suffix layout (content in .disabled)', () => {
    expect(classifyMainVar({ bareSize: null, disabledSize: 1000 })).toEqual({
      present: true,
      storageState: 'disabled',
      contentInDisabled: true,
    })
  })

  it('empty marker only → not present (no content anywhere)', () => {
    expect(classifyMainVar({ bareSize: null, disabledSize: 0 })).toEqual({ present: false })
  })

  it('empty bare + empty marker → not present', () => {
    expect(classifyMainVar({ bareSize: 0, disabledSize: 0 })).toEqual({ present: false })
  })

  it('empty bare + content .disabled → suffix layout (the .disabled holds content)', () => {
    expect(classifyMainVar({ bareSize: 0, disabledSize: 1000 })).toEqual({
      present: true,
      storageState: 'disabled',
      contentInDisabled: true,
    })
  })

  it('nothing on disk → not present', () => {
    expect(classifyMainVar({ bareSize: null, disabledSize: null })).toEqual({ present: false })
  })
})
