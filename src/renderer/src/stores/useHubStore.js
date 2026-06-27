import { create } from 'zustand'
import { toast } from '@/components/Toast'
import { HUB_PER_PAGE_OPTIONS, readSettingJson, sanitizeHubState, writeSettingJson } from '@/lib/view-state'
import { useInstalledStore } from './useInstalledStore'

let fetchSeq = 0
let tailResolveSeq = 0
const HUB_SHOW_INFINITE_PAGER_KEY = 'hub_show_infinite_pager'
const HUB_REMEMBER_INFINITE_PAGE_KEY = 'hub_remember_infinite_page'
const HUB_TAIL_CACHE_KEY = 'hub_tail_page_cache_v1'

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

function hubResources(result) {
  return Array.isArray(result?.resources) ? result.resources : []
}

function hubSearchParams(state, page) {
  const params = { page, perpage: state.perPage }
  if (state.sort) params.sort = state.sort
  if (state.search) params.search = state.search
  if (state.selectedType !== 'All') params.type = state.selectedType
  if (state.paidFilter === 'free') params.category = 'Free'
  else if (state.paidFilter === 'paid') params.category = 'Paid'
  if (state.authorSearch) params.username = state.authorSearch
  if (state.selectedHubTags?.length) params.tags = state.selectedHubTags.join(',')
  if (state.license && state.license !== 'Any') params.license = state.license
  return params
}

export function hubTailCacheKey(state) {
  return JSON.stringify({
    search: state.search || '',
    selectedType: state.selectedType || 'All',
    paidFilter: state.paidFilter || 'all',
    authorSearch: state.authorSearch || '',
    selectedHubTags: state.selectedHubTags || [],
    sort: state.sort || '',
    license: state.license || 'Any',
    perPage: state.perPage,
  })
}

function cachedTailPage(cache, key) {
  const entry = cache?.[key]
  const n = typeof entry === 'number' ? entry : entry?.totalPages
  return Number.isInteger(n) && n > 0 ? n : null
}

async function loadTailCache(set, get) {
  if (get().tailCacheLoaded) return get().tailCache
  const cache = await readSettingJson(HUB_TAIL_CACHE_KEY, {})
  const next = cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {}
  set({ tailCache: next, tailCacheLoaded: true })
  return next
}

async function saveTailCache(cache) {
  await writeSettingJson(HUB_TAIL_CACHE_KEY, cache)
}

async function resolveTailPage(params, reportedPage, isCurrent) {
  const page = Math.max(1, Number(reportedPage) || 1)
  const result = await window.api.hub.search({ ...params, page })
  if (!isCurrent()) return null
  if (hubResources(result).length) return { page, result }
  return resolveEmptyTailPage(params, page, isCurrent)
}

async function resolveEmptyTailPage(params, requestedPage, isCurrent) {
  let emptyUpper = requestedPage
  let lowerPage = 0
  let lowerResult = null
  let pageOneResult = null
  let step = 1

  while (requestedPage - step > 0) {
    const page = Math.max(1, requestedPage - step)
    const result = await window.api.hub.search({ ...params, page })
    if (!isCurrent()) return null
    if (hubResources(result).length) {
      lowerPage = page
      lowerResult = result
      break
    }
    if (page === 1) pageOneResult = result
    emptyUpper = page
    step *= 2
  }

  if (!lowerResult) {
    const result = pageOneResult || (await window.api.hub.search({ ...params, page: 1 }))
    if (!isCurrent()) return null
    return { page: 1, result }
  }

  while (lowerPage + 1 < emptyUpper) {
    const page = Math.floor((lowerPage + emptyUpper) / 2)
    const result = await window.api.hub.search({ ...params, page })
    if (!isCurrent()) return null
    if (hubResources(result).length) {
      lowerPage = page
      lowerResult = result
    } else {
      emptyUpper = page
    }
  }

  return { page: lowerPage, result: lowerResult }
}

export const useHubStore = create((set, get) => ({
  resources: [],
  totalFound: 0,
  totalPages: 0,
  page: 1,
  startPage: 1,
  restorePage: 1,
  showInfinitePagerControls: true,
  trackInfiniteRestorePage: true,
  perPage: HUB_PER_PAGE_OPTIONS[0],
  browseMode: 'infinite',
  loading: false,
  loadingPrevious: false,
  tailResolving: false,
  error: null,
  tailCache: {},
  tailCacheLoaded: false,
  tailCacheKey: '',
  resolvedTotalPages: null,

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
    return get().fetchResources(true, { page: nextPage })
  },
  goToPage: async (page) => {
    const state = get()
    const target = Number(page) || 1
    if (state.resolvedTotalPages && target >= state.resolvedTotalPages) {
      const resolved = await get().resolveTailPages({ force: true })
      return get().fetchResources(true, { page: resolved || target })
    }
    return get().fetchResources(true, { page: target })
  },
  startInfiniteAtPage: async (page) => {
    const max = Math.max(get().totalPages || 1, 1)
    const nextPage = Math.min(Math.max(1, Number(page) || 1), max)
    if (get().resolvedTotalPages && nextPage >= get().resolvedTotalPages) {
      const resolved = await get().resolveTailPages({ force: true })
      const resolvedPage = Math.max(1, Number(resolved) || nextPage)
      set({ startPage: resolvedPage, restorePage: resolvedPage })
      return get().fetchResources(true, { page: resolvedPage })
    }
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
  setShowInfinitePagerControls: (showInfinitePagerControls) => {
    set({ showInfinitePagerControls })
    void window.api.settings.set(HUB_SHOW_INFINITE_PAGER_KEY, showInfinitePagerControls ? '1' : '0')
  },
  setTrackInfiniteRestorePage: (trackInfiniteRestorePage) => {
    set({ trackInfiniteRestorePage })
    void window.api.settings.set(HUB_REMEMBER_INFINITE_PAGE_KEY, trackInfiniteRestorePage ? '1' : '0')
  },
  loadTailCache: () => loadTailCache(set, get),
  clearCurrentTailCache: async () => {
    const cache = await loadTailCache(set, get)
    const key = hubTailCacheKey(get())
    if (!cache[key]) {
      set({ resolvedTotalPages: null, tailCacheKey: key })
      return
    }
    const next = { ...cache }
    delete next[key]
    set({ tailCache: next, resolvedTotalPages: null, tailCacheKey: key })
    await saveTailCache(next)
  },
  resolveTailPages: async ({ force = false } = {}) => {
    const cache = await loadTailCache(set, get)
    const state = get()
    const key = hubTailCacheKey(state)
    const cached = cachedTailPage(cache, key)
    if (cached && !force) {
      set({ tailCacheKey: key, resolvedTotalPages: cached, totalPages: cached, tailResolving: false })
      return cached
    }

    const seq = ++tailResolveSeq
    set({ tailCacheKey: key, tailResolving: true })
    try {
      const current = get()
      const baseParams = hubSearchParams(current, 1)
      let resolvedPage = cached || Math.max(1, Number(current.totalPages) || 1)

      if (force && cached) {
        const nextPage = cached + 1
        const nextResult = await window.api.hub.search({ ...baseParams, page: nextPage })
        if (seq !== tailResolveSeq || key !== hubTailCacheKey(get())) return null
        if (hubResources(nextResult).length) {
          resolvedPage = Math.max(nextPage, Number(nextResult.totalPages) || nextPage)
        } else {
          resolvedPage = cached
        }
      }

      if (!cached || resolvedPage > cached) {
        const resolved = await resolveTailPage(
          baseParams,
          resolvedPage,
          () => seq === tailResolveSeq && key === hubTailCacheKey(get()),
        )
        if (!resolved) return null
        resolvedPage = hubResources(resolved.result).length ? resolved.page : Number(resolved.result.totalPages) || 1
      }

      const nextCache = { ...get().tailCache, [key]: { totalPages: resolvedPage, resolvedAt: Date.now() } }
      set({
        tailCache: nextCache,
        tailCacheLoaded: true,
        tailCacheKey: key,
        resolvedTotalPages: resolvedPage,
        totalPages: resolvedPage,
        tailResolving: false,
      })
      await saveTailCache(nextCache)
      return resolvedPage
    } catch {
      if (seq === tailResolveSeq) set({ tailResolving: false })
      return null
    }
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

  /** Restore Hub UI preferences from disk (sort, gallery card size/mode, page controls/memory) */
  hydrateHubFilterPreferences: async () => {
    try {
      const [last, mode, widthStr, showInfinitePager, rememberInfinitePage] = await Promise.all([
        window.api.settings.get('hub_last_sort'),
        window.api.settings.get('hub_card_mode'),
        window.api.settings.get('hub_card_width'),
        window.api.settings.get(HUB_SHOW_INFINITE_PAGER_KEY),
        window.api.settings.get(HUB_REMEMBER_INFINITE_PAGE_KEY),
      ])
      const patch = {}
      if (last) patch.sort = last
      if (mode === 'minimal' || mode === 'medium') patch.cardMode = mode
      if (showInfinitePager === '0' || showInfinitePager === '1') {
        patch.showInfinitePagerControls = showInfinitePager === '1'
      }
      if (rememberInfinitePage === '0' || rememberInfinitePage === '1') {
        patch.trackInfiniteRestorePage = rememberInfinitePage === '1'
      }
      const w = parseInt(String(widthStr ?? ''), 10)
      if (!Number.isNaN(w) && w >= 100 && w <= 500) patch.cardWidth = w
      if (Object.keys(patch).length) set(patch)
    } catch {}
  },

  fetchResources: async (resetPage, opts) => {
    const seq = ++fetchSeq
    const state = get()
    let requestedPage = Math.max(1, Number(opts?.page ?? (resetPage ? 1 : state.page)) || 1)
    const append = opts?.append === true
    set({ loading: true, loadingPrevious: false, error: null, ...(append ? {} : { resources: [] }) })
    try {
      if (opts?.forceRefresh) {
        await get().clearCurrentTailCache()
        await window.api.hub.invalidateCaches()
        await get().fetchFilters(true)
      }
      const cache = await loadTailCache(set, get)
      const key = hubTailCacheKey(get())
      const cachedTotalPages = cachedTailPage(cache, key)
      if (cachedTotalPages && requestedPage > cachedTotalPages) requestedPage = cachedTotalPages
      if (seq !== fetchSeq) return
      const beforeSearch = get()
      if (beforeSearch.page !== requestedPage) set({ page: requestedPage })
      set({ tailCacheKey: key, resolvedTotalPages: cachedTotalPages })
      if (
        !append &&
        beforeSearch.browseMode === 'infinite' &&
        (beforeSearch.startPage !== requestedPage || beforeSearch.restorePage !== requestedPage)
      )
        set({ startPage: requestedPage, restorePage: requestedPage })
      const q = get()
      const params = hubSearchParams(q, requestedPage)

      const result = await window.api.hub.search(params)
      if (seq !== fetchSeq) return
      let incoming = hubResources(result)
      let totalFound = result.totalFound || 0
      let totalPages = cachedTotalPages || result.totalPages || 0
      let page = requestedPage
      if (!append && requestedPage > 1 && incoming.length === 0 && totalPages >= requestedPage) {
        const resolved = await resolveEmptyTailPage(params, requestedPage, () => seq === fetchSeq)
        if (!resolved || seq !== fetchSeq) return
        incoming = hubResources(resolved.result)
        totalFound = resolved.result.totalFound || totalFound
        totalPages = incoming.length ? resolved.page : resolved.result.totalPages || 0
        page = resolved.page
        const nextCache = { ...get().tailCache, [key]: { totalPages, resolvedAt: Date.now() } }
        set({ tailCache: nextCache, tailCacheLoaded: true, resolvedTotalPages: totalPages })
        void saveTailCache(nextCache)
      }
      const patch = {
        resources: append ? [...get().resources, ...incoming] : incoming,
        totalFound,
        totalPages,
        page,
        loading: false,
        tailCacheKey: key,
        resolvedTotalPages: cachedTotalPages || get().resolvedTotalPages,
      }
      if (!append && q.browseMode === 'infinite') {
        patch.startPage = page
        patch.restorePage = page
      }
      syncInstalledFromResources(incoming)
      set(patch)
    } catch (err) {
      if (seq !== fetchSeq) return
      set({ error: err.message, loading: false, loadingPrevious: false, ...(append ? {} : { resources: [] }) })
    }
  },

  fetchNextPage: async () => {
    const { page, totalPages, loading, resolvedTotalPages } = get()
    if (loading) return
    if (resolvedTotalPages && page >= resolvedTotalPages) {
      const resolved = await get().resolveTailPages({ force: true })
      if (!resolved || page >= resolved) return
    } else if (page >= totalPages) {
      return
    }
    void get().fetchResources(false, { page: get().page + 1, append: true })
  },

  fetchPreviousPage: async () => {
    const state = get()
    if (state.loading || state.browseMode !== 'infinite' || state.startPage <= 1) return false
    const seq = ++fetchSeq
    const requestedPage = state.startPage - 1
    set({ loading: true, loadingPrevious: true, error: null })
    try {
      const result = await window.api.hub.search(hubSearchParams(get(), requestedPage))
      if (seq !== fetchSeq) return false
      const incoming = hubResources(result)
      syncInstalledFromResources(incoming)
      set({
        resources: [...incoming, ...get().resources],
        totalFound: result.totalFound || get().totalFound,
        totalPages: get().resolvedTotalPages || result.totalPages || get().totalPages,
        startPage: requestedPage,
        loading: false,
        loadingPrevious: false,
      })
      return incoming.length > 0
    } catch (err) {
      if (seq !== fetchSeq) return false
      set({ error: err.message, loading: false, loadingPrevious: false })
      return false
    }
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
