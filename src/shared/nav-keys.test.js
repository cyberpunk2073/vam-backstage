import { describe, it, expect } from 'vitest'
import { matchNavShortcut } from './nav-keys'

const press = (over) => ({ alt: false, control: false, meta: false, shift: false, ...over })

describe('matchNavShortcut', () => {
  it('maps Alt+arrows on Windows/Linux only', () => {
    expect(matchNavShortcut(press({ key: 'ArrowLeft', code: 'ArrowLeft', alt: true }), false)).toBe('back')
    expect(matchNavShortcut(press({ key: 'ArrowRight', code: 'ArrowRight', alt: true }), false)).toBe('forward')
    expect(matchNavShortcut(press({ key: 'ArrowLeft', code: 'ArrowLeft', alt: true }), true)).toBeNull()
  })

  it('maps Cmd+brackets on macOS only', () => {
    expect(matchNavShortcut(press({ key: '[', code: 'BracketLeft', meta: true }), true)).toBe('back')
    expect(matchNavShortcut(press({ key: ']', code: 'BracketRight', meta: true }), true)).toBe('forward')
    expect(matchNavShortcut(press({ key: '[', code: 'BracketLeft', meta: true }), false)).toBeNull()
  })

  it('leaves macOS text-editing keys alone (guest focus is unknowable)', () => {
    expect(matchNavShortcut(press({ key: 'ArrowLeft', code: 'ArrowLeft', meta: true }), true)).toBeNull()
    expect(matchNavShortcut(press({ key: 'ArrowRight', code: 'ArrowRight', meta: true }), true)).toBeNull()
  })

  it('maps the dedicated browser keys on every platform', () => {
    for (const isMac of [true, false]) {
      expect(matchNavShortcut(press({ key: 'BrowserBack' }), isMac)).toBe('back')
      expect(matchNavShortcut(press({ key: 'BrowserForward' }), isMac)).toBe('forward')
    }
  })

  it('maps Ctrl(+Shift)+Tab to the pager', () => {
    expect(matchNavShortcut(press({ key: 'Tab', code: 'Tab', control: true }), false)).toBe('pager-next')
    expect(matchNavShortcut(press({ key: 'Tab', code: 'Tab', control: true, shift: true }), false)).toBe('pager-prev')
    expect(matchNavShortcut(press({ key: 'Tab', code: 'Tab', control: true, alt: true }), false)).toBeNull()
  })

  it('ignores bare and over-modified keys', () => {
    expect(matchNavShortcut(press({ key: 'ArrowLeft', code: 'ArrowLeft' }), false)).toBeNull()
    expect(matchNavShortcut(press({ key: 'ArrowLeft', code: 'ArrowLeft', alt: true, control: true }), false)).toBeNull()
    expect(matchNavShortcut(press({ key: '[', code: 'BracketLeft', meta: true, alt: true }), true)).toBeNull()
  })
})
