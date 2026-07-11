import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from '@/components/Toast'
import { useInstalledStore } from './useInstalledStore'
import { persistViewState, oneOf, asArray, asPolarityList, asString, asCardWidth } from './persistViewState'

/** Gallery data sources. Extend this (and the toolbar segmented control) to add future modes. */
export const GALLERY_MODES = ['hub', 'wishlist']

/**
 * Freshness key over the hub-query fields, so returning to Hub doesn't refetch
 * page 1 when nothing changed. Excludes wishlist filters (client-side, no fetch).
 */
export function hubFilterSignature(state) {
  return [
    state.search,
    state.selectedType,
    state.paidFilter,
    state.authorSearch,
    state.selectedHubTags.join(','),
    state.sort,
    state.license,
  ].join('\u0000')
}

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

// Renderer-side detail cache (insertion-order LRU). The main process already
// caches detail payloads, but every `openDetail` still clears `detailData` and
// awaits an async IPC round-trip — so without this the panel always flashes a
// skeleton for a frame even on a cache hit. Seeding from here lets openDetail
// render the known detail synchronously and revalidate in the background.
const MAX_DETAIL_CACHE = 60
const detailCache = new Map()
function cacheDetail(detail) {
  if (!detail?.resource_id) return
  const key = String(detail.resource_id)
  detailCache.delete(key)
  detailCache.set(key, detail)
  if (detailCache.size > MAX_DETAIL_CACHE) detailCache.delete(detailCache.keys().next().value)
}

export const useHubStore = create(
  persist(
    (set, get) => ({
      resources: [],
      totalFound: 0,
      totalPages: 0,
      page: 1,
      loading: false,
      error: null,
      // Hub filter signature at the last reset-fetch; lets HubView skip a redundant
      // reset+fetch on reveal. Not persisted (nor are resources), so launch refetches.
      lastFetchedKey: null,

      search: '',
      selectedType: 'All',
      paidFilter: 'all',
      authorSearch: '',
      /** Hub tag filter — joined with comma for `getResources` */
      selectedHubTags: [],
      sort: '',
      license: 'Any',

      // Wishlist gallery filters/sort — client-side only (the wishlist is a local
      // list, never a hub query), independent from the hub search filters above so
      // the two modes never clobber each other. `wlSort` values are the local sort
      // keys defined in HubView (WISHLIST_SORTS); default 'added' = created_at DESC.
      wlSearch: '',
      wlType: 'All',
      wlTags: [],
      wlPaid: 'all',
      wlAuthor: '',
      wlExcludedAuthors: [],
      wlLicense: 'Any',
      wlSort: 'added',

      detailResource: null,
      detailData: null,
      detailLoading: false,
      // Bumped on every explicit detail open (gallery click, cross-view nav, prev/next
      // jump) so HubDetail can be keyed on it and remount for a fresh load. Deliberately
      // NOT changed by followDetail, which must keep the webview mounted while the user
      // browses inside the guest page.
      detailNonce: 0,
      // Resource id whose detail followDetail is fetching in the background; dedupes
      // concurrent follows and lets stale responses be discarded after a newer
      // follow/open supersedes them.
      followingDetailId: null,
      cardMode: 'medium',
      cardWidth: 220,

      // Gallery data source (see GALLERY_MODES): 'hub' search or local 'wishlist'.
      // Persisted so the mode restores across restarts; switching it never touches
      // hub search state (filters/results/page), so switching back is lossless.
      galleryMode: 'hub',

      filterOptions: null,

      setSearch: (search) => set({ search }),
      setSelectedType: (selectedType) => set({ selectedType }),
      setPaidFilter: (paidFilter) => set({ paidFilter }),
      setAuthorSearch: (authorSearch) => set({ authorSearch }),
      setSelectedHubTags: (selectedHubTags) => set({ selectedHubTags }),
      setSort: (sort) => set({ sort }),
      setLicense: (license) => set({ license }),
      setWlSearch: (wlSearch) => set({ wlSearch }),
      setWlType: (wlType) => set({ wlType }),
      setWlTags: (wlTags) => set({ wlTags }),
      setWlPaid: (wlPaid) => set({ wlPaid }),
      setWlAuthor: (wlAuthor) => set({ wlAuthor }),
      setWlExcludedAuthors: (wlExcludedAuthors) => set({ wlExcludedAuthors }),
      setWlLicense: (wlLicense) => set({ wlLicense }),
      setWlSort: (wlSort) => set({ wlSort }),
      setCardMode: (cardMode) => set({ cardMode }),
      setCardWidth: (cardWidth) => set({ cardWidth }),
      setGalleryMode: (galleryMode) => set({ galleryMode }),
      setPage: (page) => set({ page }),

      fetchFilters: async (force) => {
        if (!force && get().filterOptions) return
        if (!get().resources.length) set({ loading: true })
        try {
          const options = await window.api.hub.filters()
          set({ filterOptions: options })
          const list = options?.sort || []
          let nextSort = get().sort
          // Only adopt/repair sort from a non-empty option list; never wipe a
          // valid persisted sort just because the list came back empty (that
          // would stall the search effect, which bails on an empty sort).
          if (list.length && (!nextSort || !list.includes(nextSort))) nextSort = list[0]
          set({ sort: nextSort })
        } catch (err) {
          console.error('Failed to fetch hub filters:', err)
        }
      },

      fetchResources: async (resetPage, opts) => {
        const seq = ++fetchSeq
        const state = get()
        const page = resetPage ? 1 : state.page
        if (resetPage && state.page !== 1) set({ page: 1 })
        set({ loading: true, error: null, ...(resetPage ? { resources: [] } : {}) })
        try {
          if (opts?.forceRefresh) {
            await window.api.hub.invalidateCaches()
            await get().fetchFilters(true)
          }
          const q = get()
          const params = { page, perpage: 30 }
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
            resources: resetPage ? incoming : [...q.resources, ...incoming],
            totalFound: result.totalFound || 0,
            totalPages: result.totalPages || 0,
            loading: false,
            ...(resetPage ? { lastFetchedKey: hubFilterSignature(q) } : {}),
          })
        } catch (err) {
          if (seq !== fetchSeq) return
          set({ error: err.message, loading: false, ...(resetPage ? { resources: [] } : {}) })
        }
      },

      fetchNextPage: () => {
        const { page, totalPages, loading } = get()
        if (loading || page >= totalPages) return
        set({ page: page + 1, loading: true })
      },

      openDetail: async (resource) => {
        const rid = String(resource.resource_id)
        const cached = detailCache.get(rid)
        set((s) => ({
          detailResource: resource,
          detailData: cached || null,
          detailLoading: !cached,
          followingDetailId: null,
          detailNonce: s.detailNonce + 1,
        }))
        if (cached) syncInstalledFromDetail(cached)
        try {
          const detail = await window.api.hub.detail(resource.resource_id)
          cacheDetail(detail)
          syncInstalledFromDetail(detail)
          // A newer open/close may have superseded this resource while we awaited.
          if (String(get().detailResource?.resource_id) !== rid) return
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
          if (String(get().detailResource?.resource_id) !== rid) return
          toast(`Failed to load hub detail: ${err.message}`)
          set({ detailLoading: false })
        }
      },

      /** Warm the detail cache for a resource without touching visible state. */
      prefetchDetail: async (resourceId) => {
        const key = String(resourceId)
        if (detailCache.has(key)) return
        try {
          cacheDetail(await window.api.hub.detail(resourceId))
        } catch {}
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
        set({ followingDetailId: rid })
        try {
          const detail = await window.api.hub.detail(resource.resource_id)
          if (get().followingDetailId !== rid) return
          cacheDetail(detail)
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

      closeDetail: () => set({ detailResource: null, detailData: null, followingDetailId: null }),

      refreshDetail: async () => {
        const { detailResource } = get()
        if (!detailResource) return
        try {
          const detail = await window.api.hub.detail(detailResource.resource_id)
          cacheDetail(detail)
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
          page: 1,
        })
      },

      // Jump to a Hub search scoped to one author. Only sets the author and
      // switches to hub mode — the other hub filters are left as-is (the wishlist
      // filters that were narrowing the view are deliberately NOT mirrored, since
      // the models aren't 1:1 and the intent is to broaden to the creator). The
      // authorSearch change drives HubView's fetch effect.
      searchHubForAuthor: (author) => {
        if (!author) return
        set({ authorSearch: author, page: 1, galleryMode: 'hub' })
      },
    }),
    persistViewState('hub-view', {
      selectedType: asString,
      paidFilter: oneOf(['all', 'free', 'paid']),
      selectedHubTags: asArray,
      authorSearch: asString,
      license: asString,
      sort: asString,
      wlType: asString,
      wlTags: asPolarityList,
      wlPaid: oneOf(['all', 'free', 'paid']),
      wlAuthor: asString,
      wlExcludedAuthors: asArray,
      wlLicense: asString,
      wlSort: asString,
      cardMode: oneOf(['minimal', 'medium']),
      cardWidth: asCardWidth,
      galleryMode: oneOf(GALLERY_MODES),
    }),
  ),
)
