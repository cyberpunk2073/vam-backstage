import { describe, expect, it, vi } from 'vitest'
import {
  sanitizeLastView,
  sanitizeHubState,
  sanitizeLibraryState,
  sanitizeContentState,
  readSettingJson,
  writeSettingJson,
} from './view-state'

describe('view-state sanitizers', () => {
  it('accepts known app views only', () => {
    expect(sanitizeLastView('hub')).toBe('hub')
    expect(sanitizeLastView('library')).toBe('library')
    expect(sanitizeLastView('content')).toBe('content')
    expect(sanitizeLastView('settings')).toBe('settings')
    expect(sanitizeLastView('downloads')).toBe('library')
    expect(sanitizeLastView(null)).toBe('library')
  })

  it('normalizes hub state', () => {
    expect(
      sanitizeHubState({
        v: 1,
        search: 'alice',
        selectedType: 'Looks',
        paidFilter: 'bad',
        authorSearch: 'bob',
        selectedHubTags: ['free', 7],
        sort: 'Latest Update',
        license: 'CC BY',
        hideInstalled: true,
        detailResourceId: 123,
      }),
    ).toEqual({
      search: 'alice',
      selectedType: 'Looks',
      paidFilter: 'all',
      authorSearch: 'bob',
      selectedHubTags: ['free'],
      sort: 'Latest Update',
      license: 'CC BY',
      hideInstalled: true,
      detailResourceId: '123',
    })
  })

  it('normalizes library and content restore ids', () => {
    expect(
      sanitizeLibraryState({ selectedFilename: 'A.B.1.var', selectedTypes: ['Looks'], selectedLabelIds: [1, 'x'] }),
    ).toMatchObject({ selectedFilename: 'A.B.1.var', selectedTypes: ['Looks'], selectedLabelIds: [1] })
    expect(
      sanitizeContentState({ selectedItemId: 42, selectedPackageFilename: 'A.B.1.var', visibilityFilter: 'hidden' }),
    ).toMatchObject({ selectedItemId: 42, selectedPackageFilename: 'A.B.1.var', visibilityFilter: 'hidden' })
  })
})

describe('view-state settings helpers', () => {
  it('returns fallback for invalid JSON', async () => {
    const api = { get: vi.fn().mockResolvedValue('{bad') }
    await expect(readSettingJson(api, 'k', { ok: true })).resolves.toEqual({ ok: true })
  })

  it('writes compact JSON strings', async () => {
    const api = { set: vi.fn().mockResolvedValue({ ok: true }) }
    await writeSettingJson(api, 'k', { a: 1 })
    expect(api.set).toHaveBeenCalledWith('k', '{"a":1}')
  })
})
