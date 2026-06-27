import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  getMousePageDirection,
  isMousePageBackButton,
  isMousePageForwardButton,
  shouldIgnoreMousePageTargetName,
} from './mouse-page-nav'

const hubView = readFileSync(resolve(import.meta.dirname, '../views/HubView.jsx'), 'utf8')
const libraryView = readFileSync(resolve(import.meta.dirname, '../views/LibraryView.jsx'), 'utf8')
const contentView = readFileSync(resolve(import.meta.dirname, '../views/ContentView.jsx'), 'utf8')
const virtualGrid = readFileSync(resolve(import.meta.dirname, '../components/VirtualGrid.jsx'), 'utf8')

describe('mouse page navigation buttons', () => {
  it('maps standard side buttons to page directions', () => {
    expect(isMousePageBackButton(3)).toBe(true)
    expect(isMousePageForwardButton(4)).toBe(true)
    expect(getMousePageDirection(3)).toBe(-1)
    expect(getMousePageDirection(4)).toBe(1)
    expect(getMousePageDirection(0)).toBe(0)
  })

  it('ignores editable controls', () => {
    expect(shouldIgnoreMousePageTargetName('input')).toBe(true)
    expect(shouldIgnoreMousePageTargetName('textarea')).toBe(true)
    expect(shouldIgnoreMousePageTargetName('select')).toBe(true)
    expect(shouldIgnoreMousePageTargetName('div')).toBe(false)
  })
})

describe('mouse page navigation wiring', () => {
  it('wires Hub, Library, Content, and virtual scrollers', () => {
    expect(hubView).toContain('onMouseUp={handleMousePageButton}')
    expect(libraryView).toContain('onMouseUp={handleMousePageButton}')
    expect(contentView).toContain('onMouseUp={handleMousePageButton}')
    expect(virtualGrid).toContain('data-page-nav-scroll')
  })
})
