import { create } from 'zustand'
import { toast } from '@/components/Toast'
import { HUB_PER_PAGE_OPTIONS, sanitizeHubState } from '@/lib/view-state'
import { useInstalledStore } from './useInstalledStore'

let fetchSeq = 0

function syncInstalledFromResources(resources) {
  useInstalledStore.getState().applyBatch(
    resources.map((r) => ({
      hubResourceId: r.resource_id,
      installed: r._installed,
      isDirect: r._isDirect,
      filename: r._localFilename,
    })),
  )
}

function syncInstalledFromDetail(detail) {
  if (!detail?.resource_id) return
  useInstalledStore.getState().update(detail.resource_id, detail._installed, detail._isDirect, detail._localFilename)
}

export const useHubStore = create((set, get) => ({
  resources: [],
  totalFound: 0,
  totalPages: 0,
  page: 1,
  startPage: 1,
  restorePage: 1,
  trackInfiniteRestorePage: true,
  perPage: HUB_PER_PAGE_OPTIONS[0],
  browseMode: 'infinite',
  loading: false,
  error: null,

  search: '',
  selectedType: 'All',
  paidFilter: 'all',
  authorSearch: '',
  /** Hub tag filter — joined with comma for `getResources` */
  selectedHubTags: [],
  sort: '',
  license: 'Any',

  detailResource: null,
  detailData: null,
  detailLoading: false,
  pendingDetailResourceId: null,
  // Resource id whose detail followDetail is fetching in the background; dedupes
  // concurrent follows and lets stale responses be discarded after a newer
  // follow/open supersedes them.
  followingDetailId: null,
  cardMode: 'medium',
  cardWidth: 220,

  filterOptions: null,

  setSearch: (search) => set({ search }),
  setSelectedType: (selectedType) => set({ selectedType }),
  setPaidFilter: (paidFilter) => set({ paidFilter }),
  setAuthorSearch: (authorSearch) => set({ authorSearch }),
  setSelectedHubTags: (selectedHubTags) => set({ selectedHubTags }),
  setSort: (sort) => {
    set({ sort })
    void window.api.settings.set('hub_last_sort', sort)
  },
  setLicense: (license) => set({ license }),
  setCardMode: (cardMode) => {
    set({ cardMode })
    void window.api.settings.set('hub_card_mode', cardMode)
  },
  setCardWidth: (cardWidth) => {
    set({ cardWidth })
    void window.api.settings.set('hub_card_width', String(cardWidth))
  },
  setPage: (page) => set({ page }),
  setBrowseMode: (browseMode) => set({ browseMode: browseMode === 'paged' ? 'paged' : 'infinite' }),
  setPerPage: (perPage) => {
    const nextPerPage = HUB_PER_PAGE_OPTIONS.includes(Number(perPage)) ? Number(perPage) : HUB_PER_PAGE_OPTIONS[0]
    const state = get()
    if (nextPerPage === state.perPage) return
    const basePage = state.browseMode === 'infinite' ? state.restorePage : state.page
    const nextPage = Math.floor(((basePage - 1) * state.perPage) / nextPerPage) + 1
    set({ perPage: nextPerPage, page: nextPage, startPage: nextPage, restorePage: nextPage })
    void get().fetchResources(true, { page: nextPage })
  },
  goToPage: (page) => get().fetchResources(true, { page }),
  startInfiniteAtPage: (page) => {
    const max = Math.max(get().totalPages || 1, 1)
    const nextPage = Math.min(Math.max(1, Number(page) || 1), max)
    set({ startPage: nextPage, restorePage: nextPage })
    return get().fetchResources(true, { page: nextPage })
  },
  setInfiniteRestorePage: (page) => {
    const state = get()
    if (!state.trackInfiniteRestorePage) return
    const max = Math.max(state.totalPages || 1, 1)
    const restorePage = Math.min(Math.max(1, Number(page) || 1), max)
    if (restorePage !== state.restorePage) set({ restorePage })
  },

  getPersistedState: () => {
    const s = get()
    return {
      search: s.search,
      selectedType: s.selectedType,
      paidFilter: s.paidFilter,
      authorSearch: s.authorSearch,
      selectedHubTags: s.selectedHubTags,
      sort: s.sort,
      license: s.license,
      browseMode: s.browseMode,
      page: s.browseMode === 'infinite' ? s.restorePage : s.page,
      perPage: s.perPage,
      detailResourceId: s.detailData?.resource_id ?? s.detailResource?.resource_id ?? s.pendingDetailResourceId ?? null,
    }
  },

  applyPersistedState: (raw) => {
    const saved = sanitizeHubState(raw)
    set({
      search: saved.search,
      selectedType: saved.selectedType,
      paidFilter: saved.paidFilter,
      authorSearch: saved.authorSearch,
      selectedHubTags: saved.selectedHubTags,
      sort: saved.sort,
      license: saved.license,
      browseMode: saved.browseMode,
      page: saved.page,
      startPage: saved.page,
      restorePage: saved.page,
      perPage: saved.perPage,
      pendingDetailResourceId: saved.detailResourceId,
    })
  },

  openDetailById: async (resourceId) => {
    const rid = String(resourceId || '')
    if (!rid) return
    const known = get().resources.find((r) => String(r.resource_id) === rid)
    if (known) {
      await get().openDetail(known)
      return
    }
    set({ detailResource: { resource_id: rid }, detailData: null, detailLoading: true, followingDetailId: null })
    try {
      const detail = await window.api.hub.detail(rid)
      syncInstalledFromDetail(detail)
      set({ detailResource: detail, detailData: detail, detailLoading: false, pendingDetailResourceId: null })
    } catch (err) {
      toast(`Failed to restore hub detail: ${err.message}`)
      set({ detailResource: null, detailData: null, detailLoading: false, pendingDetailResourceId: null })
    }
  },

  fetchFilters: async (force) => {
    if (!force && get().filterOptions) return
    if (!get().resources.length) set({ loading: true })
    try {
      const options = await window.api.hub.filters()
      const list = options.sort || []
      let nextSort = get().sort
      if (!nextSort && list.length) nextSort = list[0]
      else if (nextSort && !list.includes(nextSort)) nextSort = list[0] || ''
      set({ filterOptions: options, sort: nextSort })
      if (nextSort) void window.api.settings.set('hub_last_sort', nextSort)
    } catch (err) {
      console.error('Failed to fetch hub filters:', err)
    }
  },

  /** Restore Hub UI preferences from disk (sort + gallery card size/mode) */
  hydrateHubFilterPreferences: async () => {
    try {
      const [last, mode, widthStr] = await Promise.all([
        window.api.settings.get('hub_last_sort'),
        window.api.settings.get('hub_card_mode'),
        window.api.settings.get('hub_card_width'),
      ])
      const patch = {}
      if (last) patch.sort = last
      if (mode === 'minimal' || mode === 'medium') patch.cardMode = mode
      const w = parseInt(String(widthStr ?? ''), 10)
      if (!Number.isNaN(w) && w >= 100 && w <= 500) patch.cardWidth = w
      if (Object.keys(patch).length) set(patch)
    } catch {}
  },

  fetchResources: async (resetPage, opts) => {
    const seq = ++fetchSeq
    const state = get()
    const requestedPage = Math.max(1, Number(opts?.page ?? (resetPage ? 1 : state.page)) || 1)
    const append = opts?.append === true
    if (state.page !== requestedPage) set({ page: requestedPage })
    if (
      !append &&
      state.browseMode === 'infinite' &&
      (state.startPage !== requestedPage || state.restorePage !== requestedPage)
    )
      set({ startPage: requestedPage, restorePage: requestedPage })
    set({ loading: true, error: null, ...(append ? {} : { resources: [] }) })
    try {
      if (opts?.forceRefresh) {
        await window.api.hub.invalidateCaches()
        await get().fetchFilters(true)
      }
      const q = get()
      const params = { page: requestedPage, perpage: q.perPage }
      if (q.sort) params.sort = q.sort
      if (q.search) params.search = q.search
      if (q.selectedType !== 'All') params.type = q.selectedType
      if (q.paidFilter === 'free') params.category = 'Free'
      else if (q.paidFilter === 'paid') params.category = 'Paid'
      if (q.authorSearch) params.username = q.authorSearch
      if (q.selectedHubTags?.length) params.tags = q.selectedHubTags.join(',')
      if (q.license && q.license !== 'Any') params.license = q.license

      const result = await window.api.hub.search(params)
      if (seq !== fetchSeq) return
      const incoming = result.resources || []
      syncInstalledFromResources(incoming)
      set({
        resources: append ? [...get().resources, ...incoming] : incoming,
        totalFound: result.totalFound || 0,
        totalPages: result.totalPages || 0,
        loading: false,
      })
    } catch (err) {
      if (seq !== fetchSeq) return
      set({ error: err.message, loading: false, ...(append ? {} : { resources: [] }) })
    }
  },

  fetchNextPage: () => {
    const { page, totalPages, loading } = get()
    if (loading || page >= totalPages) return
    void get().fetchResources(false, { page: page + 1, append: true })
  },

  openDetail: async (resource) => {
    set({
      detailResource: resource,
      detailData: null,
      detailLoading: true,
      followingDetailId: null,
      pendingDetailResourceId: null,
    })
    try {
      const detail = await window.api.hub.detail(resource.resource_id)
      syncInstalledFromDetail(detail)
      const rid = String(detail.resource_id)
      set((s) => ({
        detailData: detail,
        detailLoading: false,
        resources:
          detail._installSizeBytes != null
            ? s.resources.map((r) =>
                String(r.resource_id) === rid ? { ...r, _installSizeBytes: detail._installSizeBytes } : r,
              )
            : s.resources,
      }))
    } catch (err) {
      toast(`Failed to load hub detail: ${err.message}`)
      set({ detailLoading: false })
    }
  },

  /**
   * Load a different resource while keeping the currently displayed detail on
   * screen, then swap atomically once the new detail is ready (no skeleton flash).
   * Used when following in-browser navigation. Self-dedupes concurrent follows and
   * discards stale responses superseded by a newer follow or by openDetail/closeDetail.
   */
  followDetail: async (resource) => {
    const rid = String(resource.resource_id)
    if (String(get().detailData?.resource_id) === rid || get().followingDetailId === rid) return
    set({ followingDetailId: rid, pendingDetailResourceId: null })
    try {
      const detail = await window.api.hub.detail(resource.resource_id)
      if (get().followingDetailId !== rid) return
      syncInstalledFromDetail(detail)
      set((s) => ({
        detailResource: resource,
        detailData: detail,
        detailLoading: false,
        followingDetailId: null,
        resources:
          detail._installSizeBytes != null
            ? s.resources.map((r) =>
                String(r.resource_id) === rid ? { ...r, _installSizeBytes: detail._installSizeBytes } : r,
              )
            : s.resources,
      }))
    } catch (err) {
      if (get().followingDetailId !== rid) return
      toast(`Failed to load hub detail: ${err.message}`)
      set({ followingDetailId: null })
    }
  },

  closeDetail: () =>
    set({ detailResource: null, detailData: null, followingDetailId: null, pendingDetailResourceId: null }),

  refreshDetail: async () => {
    const { detailResource } = get()
    if (!detailResource) return
    try {
      const detail = await window.api.hub.detail(detailResource.resource_id)
      syncInstalledFromDetail(detail)
      const rid = String(detail.resource_id)
      set((s) => ({
        detailData: detail,
        resources:
          detail._installSizeBytes != null
            ? s.resources.map((r) =>
                String(r.resource_id) === rid ? { ...r, _installSizeBytes: detail._installSizeBytes } : r,
              )
            : s.resources,
      }))
    } catch (err) {
      toast(`Failed to refresh hub detail: ${err.message}`)
    }
  },

  resetFilters: () => {
    const sortOptions = get().filterOptions?.sort
    const nextSort = sortOptions?.[0] || ''
    set({
      search: '',
      selectedType: 'All',
      paidFilter: 'all',
      authorSearch: '',
      selectedHubTags: [],
      sort: nextSort,
      license: 'Any',
      pendingDetailResourceId: null,
      page: 1,
      startPage: 1,
      restorePage: 1,
    })
    if (nextSort) void window.api.settings.set('hub_last_sort', nextSort)
  },
}))
