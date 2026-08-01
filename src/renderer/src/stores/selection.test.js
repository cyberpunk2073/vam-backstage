import { describe, expect, it, vi } from 'vitest'
import { isBulk, soleSelected, selectionMutators } from './selection'

function makeStore({ liveKeys } = {}) {
  let state = {
    selection: [],
    selectionAnchor: null,
    selectionLead: null,
  }
  const loadSingle = vi.fn(() => Promise.resolve())
  const set = (patch) => {
    state = { ...state, ...patch }
  }
  const get = () => state
  const isLive = liveKeys ? () => (key) => liveKeys.includes(key) : undefined
  const api = selectionMutators(set, get, loadSingle, { isLive })
  return { state: () => state, loadSingle, ...api }
}

describe('selection helpers', () => {
  it('isBulk / soleSelected', () => {
    expect(isBulk([])).toBe(false)
    expect(isBulk(['a'])).toBe(false)
    expect(isBulk(['a', 'b'])).toBe(true)
    expect(soleSelected(['a'])).toBe('a')
    expect(soleSelected(['a', 'b'])).toBe(null)
  })
})

describe('selectionMutators', () => {
  it('single select sets both positions and loads detail', async () => {
    const s = makeStore()
    await s.setSelection('a')
    expect(s.state()).toMatchObject({ selection: ['a'], selectionAnchor: 'a', selectionLead: 'a' })
    expect(s.loadSingle).toHaveBeenCalledWith('a')
  })

  it('setLead moves focus only', async () => {
    const s = makeStore()
    await s.setSelection('a')
    s.setLead('b')
    expect(s.state()).toMatchObject({ selection: ['a'], selectionAnchor: 'a', selectionLead: 'b' })
  })

  it('Space/toggle on a different lead enters bulk with both positions on the toggled item', async () => {
    const s = makeStore()
    await s.setSelection('a')
    s.setLead('b')
    await s.toggleSelected('b')
    expect(s.state()).toMatchObject({ selection: ['a', 'b'], selectionAnchor: 'b', selectionLead: 'b' })
  })

  it('toggle refuses to empty the last pick', async () => {
    const s = makeStore()
    await s.setSelection('a')
    await s.toggleSelected('a')
    expect(s.state().selection).toEqual(['a'])
  })

  it('toggle off keeps both positions on the toggled item when still multi', async () => {
    const s = makeStore()
    await s.setSelection(['a', 'b', 'c'], { anchor: 'a', lead: 'b' })
    await s.toggleSelected('b')
    expect(s.state()).toMatchObject({
      selection: ['a', 'c'],
      selectionAnchor: 'b',
      selectionLead: 'b',
    })
  })

  it('toggle off down to one pick promotes that pick (both positions follow)', async () => {
    const s = makeStore()
    await s.setSelection(['a', 'b'], { anchor: 'a', lead: 'b' })
    await s.toggleSelected('b')
    expect(s.state()).toMatchObject({ selection: ['a'], selectionAnchor: 'a', selectionLead: 'a' })
  })

  it('selectRange replaces with anchor→endpoint and moves lead', async () => {
    const s = makeStore()
    await s.setSelection('b')
    const ordered = ['a', 'b', 'c', 'd']
    await s.selectRange('d', ordered)
    expect(s.state()).toMatchObject({
      selection: ['b', 'c', 'd'],
      selectionAnchor: 'b',
      selectionLead: 'd',
    })
  })

  it('selectRange shrinks when shifting back toward the anchor', async () => {
    const s = makeStore()
    await s.setSelection(['b', 'c', 'd'], { anchor: 'b', lead: 'd' })
    await s.selectRange('c', ['a', 'b', 'c', 'd'])
    expect(s.state()).toMatchObject({
      selection: ['b', 'c'],
      selectionAnchor: 'b',
      selectionLead: 'c',
    })
  })

  it('selectAll sets anchor=first and lead=last', async () => {
    const s = makeStore()
    await s.selectAll(['a', 'b', 'c'])
    expect(s.state()).toMatchObject({
      selection: ['a', 'b', 'c'],
      selectionAnchor: 'a',
      selectionLead: 'c',
    })
  })

  it('collapseSelection collapses to the lead', async () => {
    const s = makeStore()
    await s.setSelection(['a', 'b', 'c'], { anchor: 'a', lead: 'c' })
    await s.collapseSelection()
    expect(s.state()).toMatchObject({ selection: ['c'], selectionAnchor: 'c', selectionLead: 'c' })
  })

  it('collapseSelection skips keys that no longer exist', async () => {
    const s = makeStore({ liveKeys: ['a', 'b'] })
    await s.setSelection(['a', 'b'], { anchor: 'a', lead: 'b' })
    s.setLead('gone')
    await s.collapseSelection()
    expect(s.state()).toMatchObject({ selection: ['a'], selectionLead: 'a' })
  })
})
