import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHubStore } from './useHubStore'
import { useInstalledStore } from './useInstalledStore'

function resource(id) {
  return { resource_id: id, title: `Resource ${id}` }
}

describe('useHubStore', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        hub: {
          search: vi
            .fn()
            .mockImplementation(({ page }) =>
              Promise.resolve({ resources: [resource(page)], totalFound: 300, totalPages: 10 }),
            ),
          invalidateCaches: vi.fn(),
          filters: vi.fn().mockResolvedValue({ sort: ['Latest Update'] }),
        },
        settings: {
          get: vi.fn(),
          set: vi.fn(),
        },
      },
    })
    useHubStore.setState({
      resources: [],
      totalFound: 0,
      totalPages: 10,
      page: 3,
      startPage: 3,
      restorePage: 3,
      showInfinitePagerControls: true,
      trackInfiniteRestorePage: true,
      perPage: 60,
      browseMode: 'infinite',
      loading: false,
      loadingPrevious: false,
      error: null,
      search: '',
      selectedType: 'All',
      paidFilter: 'all',
      authorSearch: '',
      selectedHubTags: [],
      sort: '',
      license: 'Any',
      filterOptions: null,
    })
    useInstalledStore.setState({ byHubResourceId: new Map() })
  })

  it('restarts infinite scrolling from a requested page', async () => {
    await useHubStore.getState().startInfiniteAtPage(2)

    expect(window.api.hub.search).toHaveBeenCalledWith(expect.objectContaining({ page: 2, perpage: 60 }))
    expect(useHubStore.getState().page).toBe(2)
  })

  it('persists infinite restore page instead of last loaded page', () => {
    useHubStore.setState({ browseMode: 'infinite', startPage: 1, restorePage: 3, page: 5 })

    expect(useHubStore.getState().getPersistedState()).toMatchObject({ browseMode: 'infinite', page: 3 })
  })

  it('prepends the previous infinite page without changing the loaded tail page', async () => {
    useHubStore.setState({
      resources: [resource(3)],
      page: 3,
      startPage: 3,
      restorePage: 3,
      totalFound: 300,
      totalPages: 10,
      sort: 'Latest Update',
    })

    const loaded = await useHubStore.getState().fetchPreviousPage()

    expect(loaded).toBe(true)
    expect(window.api.hub.search).toHaveBeenCalledWith(expect.objectContaining({ page: 2, perpage: 60 }))
    expect(useHubStore.getState()).toMatchObject({
      resources: [resource(2), resource(3)],
      page: 3,
      startPage: 2,
      restorePage: 3,
      loading: false,
      loadingPrevious: false,
    })
  })

  it('resizes infinite start page from the restore page', () => {
    useHubStore.setState({ browseMode: 'infinite', startPage: 1, restorePage: 3, page: 5, perPage: 60 })

    useHubStore.getState().setPerPage(120)

    expect(window.api.hub.search).toHaveBeenCalledWith(expect.objectContaining({ page: 2, perpage: 120 }))
  })

  it('tracks infinite restore page when enabled', () => {
    useHubStore.setState({ browseMode: 'infinite', startPage: 1, restorePage: 1, page: 5 })

    useHubStore.getState().setInfiniteRestorePage(4)

    expect(useHubStore.getState().startPage).toBe(1)
    expect(useHubStore.getState().getPersistedState()).toMatchObject({ page: 4 })
  })

  it('can disable infinite restore tracking later', () => {
    useHubStore.setState({
      browseMode: 'infinite',
      startPage: 1,
      restorePage: 1,
      page: 5,
      trackInfiniteRestorePage: false,
    })

    useHubStore.getState().setInfiniteRestorePage(4)

    expect(useHubStore.getState().getPersistedState()).toMatchObject({ page: 1 })
  })

  it('hydrates the infinite page memory setting', async () => {
    window.api.settings.get.mockImplementation((key) =>
      Promise.resolve(key === 'hub_remember_infinite_page' ? '0' : null),
    )

    await useHubStore.getState().hydrateHubFilterPreferences()

    expect(useHubStore.getState().trackInfiniteRestorePage).toBe(false)
  })

  it('persists the infinite page memory setting', () => {
    useHubStore.getState().setTrackInfiniteRestorePage(false)

    expect(useHubStore.getState().trackInfiniteRestorePage).toBe(false)
    expect(window.api.settings.set).toHaveBeenCalledWith('hub_remember_infinite_page', '0')
  })

  it('hydrates the infinite pager controls setting', async () => {
    window.api.settings.get.mockImplementation((key) => Promise.resolve(key === 'hub_show_infinite_pager' ? '0' : null))

    await useHubStore.getState().hydrateHubFilterPreferences()

    expect(useHubStore.getState().showInfinitePagerControls).toBe(false)
  })

  it('persists the infinite pager controls setting', () => {
    useHubStore.getState().setShowInfinitePagerControls(false)

    expect(useHubStore.getState().showInfinitePagerControls).toBe(false)
    expect(window.api.settings.set).toHaveBeenCalledWith('hub_show_infinite_pager', '0')
  })

  it('normalizes hub sort before exposing loaded filter options', async () => {
    const snapshots = []
    const unsubscribe = useHubStore.subscribe((state) => {
      snapshots.push({ filterOptions: state.filterOptions, sort: state.sort })
    })

    useHubStore.setState({ filterOptions: null, sort: 'Missing Sort', resources: [] })
    await useHubStore.getState().fetchFilters(true)
    unsubscribe()

    expect(snapshots).not.toContainEqual({ filterOptions: { sort: ['Latest Update'] }, sort: 'Missing Sort' })
  })

  it('keeps page 1 empty without probing lower pages', async () => {
    window.api.hub.search.mockResolvedValueOnce({ resources: [], totalFound: 0, totalPages: 0 })

    await useHubStore.getState().fetchResources(true, { page: 1 })

    expect(window.api.hub.search).toHaveBeenCalledTimes(1)
    expect(useHubStore.getState()).toMatchObject({ resources: [], page: 1, totalPages: 0, loading: false })
  })

  it('keeps non-empty requested pages unchanged', async () => {
    window.api.hub.search.mockResolvedValueOnce({ resources: [resource(3)], totalFound: 90, totalPages: 3 })

    await useHubStore.getState().fetchResources(true, { page: 3 })

    expect(window.api.hub.search).toHaveBeenCalledTimes(1)
    expect(window.api.hub.search).toHaveBeenCalledWith(expect.objectContaining({ page: 3 }))
    expect(useHubStore.getState()).toMatchObject({ resources: [resource(3)], page: 3, totalPages: 3 })
  })

  it('resolves an empty tail page to the last non-empty page', async () => {
    window.api.hub.search.mockImplementation(({ page }) => {
      const resources = page <= 6 ? [resource(page)] : []
      return Promise.resolve({ resources, totalFound: 300, totalPages: 10 })
    })

    await useHubStore.getState().fetchResources(true, { page: 10 })

    expect(window.api.hub.search.mock.calls.length).toBeLessThanOrEqual(5)
    expect(useHubStore.getState()).toMatchObject({
      resources: [resource(6)],
      page: 6,
      startPage: 6,
      restorePage: 6,
      totalPages: 6,
    })
  })
})
