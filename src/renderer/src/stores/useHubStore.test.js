import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useHubStore } from './useHubStore'

describe('useHubStore', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        hub: {
          search: vi.fn().mockResolvedValue({ resources: [], totalFound: 0, totalPages: 10 }),
          filters: vi.fn().mockResolvedValue({ sort: ['Latest Update'] }),
        },
        settings: {
          get: vi.fn(),
          set: vi.fn(),
        },
      },
    })
    useHubStore.setState({
      page: 3,
      startPage: 3,
      restorePage: 3,
      trackInfiniteRestorePage: true,
      browseMode: 'infinite',
      perPage: 60,
      resources: [],
      totalFound: 0,
      totalPages: 10,
      loading: false,
    })
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
})
