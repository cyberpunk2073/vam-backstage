import { describe, expect, it, vi } from 'vitest'
import {
  sanitizeView,
  sanitizeLastView,
  sanitizeHubState,
  sanitizeLibraryState,
  sanitizeContentState,
  readSettingJson,
  writeSettingJson,
} from './view-state'

describe('view-state sanitizers', () => {
  it('accepts settings for active navigation', () => {
    expect(sanitizeView('settings')).toBe('settings')
    expect(sanitizeView('downloads')).toBe('library')
  })

  it('accepts known app views only', () => {
    expect(sanitizeLastView('hub')).toBe('hub')
    expect(sanitizeLastView('library')).toBe('library')
    expect(sanitizeLastView('content')).toBe('content')
    expect(sanitizeLastView('settings')).toBe('hub')
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
        detailResourceId: 123,
        browseMode: 'paged',
        page: 7,
        perPage: 60,
      }),
    ).toEqual({
      search: 'alice',
      selectedType: 'Looks',
      paidFilter: 'all',
      authorSearch: 'bob',
      selectedHubTags: ['free'],
      sort: 'Latest Update',
      license: 'CC BY',
      detailResourceId: '123',
      browseMode: 'paged',
      page: 7,
      perPage: 60,
    })
    expect(sanitizeHubState({ browseMode: 'bad', page: -3, perPage: 42 })).toMatchObject({
      browseMode: 'infinite',
      page: 1,
      perPage: 30,
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
    await expect(readSettingJson('k', { ok: true }, api)).resolves.toEqual({ ok: true })
  })

  it('writes compact JSON strings', async () => {
    const api = { set: vi.fn().mockResolvedValue({ ok: true }) }
    await writeSettingJson('k', { a: 1 }, api)
    expect(api.set).toHaveBeenCalledWith('k', '{"a":1}')
  })

  it('defaults to the renderer settings API', async () => {
    const api = {
      get: vi.fn().mockResolvedValue('{"hideInstalled":true}'),
      set: vi.fn().mockResolvedValue({ ok: true }),
    }
    vi.stubGlobal('window', { api: { settings: api } })

    try {
      await expect(readSettingJson('ui:hub_state', null)).resolves.toEqual({ hideInstalled: true })
      await writeSettingJson('ui:last_view', 'hub')

      expect(api.get).toHaveBeenCalledWith('ui:hub_state')
      expect(api.set).toHaveBeenCalledWith('ui:last_view', '"hub"')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
