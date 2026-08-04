import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from '@/components/Toast'
import { useInstalledStore } from './useInstalledStore'
import { persistViewState, oneOf, asArray, asPolarityList, asString, asCardWidth } from './persistViewState'
import { HUB_PER_PAGE } from '@shared/hub-http.js'

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

/** Hub-search filter defaults (server-side query). `sort` is excluded — its default is
 *  resolved dynamically from the server's option list, and reordering doesn't hide content. */
export const HUB_FILTER_DEFAULTS = {
  search: '',
  selectedType: 'All',
  paidFilter: 'all',
  authorSearch: '',
  /** Hub tag filter — joined with comma for `getResources` */
  selectedHubTags: [],
  license: 'Any',
}

/** Wishlist gallery filter defaults — client-side only (the wishlist is a local list,
 *  never a hub query), independent from the hub-search filters above so the two modes
 *  never clobber each other. `wlSort` is excluded like `sort`. */
export const WISHLIST_FILTER_DEFAULTS = {
  wlSearch: '',
  wlType: 'All',
  wlTags: [],
  wlPaid: 'all',
  wlAuthor: '',
  wlExcludedAuthors: [],
  wlLicense: 'Any',
}

let fetchSeq = 0

/** The only sort that reads as a feed you scan for new things, so the only one where flagging
 *  "updated since your last look" helps: the ranking sorts hardly move page 1, and the trending
 *  ones surface *old* resources having a moment. Label comes from `getInfo`'s sort list. */
const LATEST_UPDATE_SORT = 'Latest Update'

/** Outlives `card-new-flash` in main.css, after which `flashSince` is cleared so cards
 *  recycled by the virtual grid don't replay the animation. */
const FLASH_MS = 3200
let flashTimer = null

/** In-flight page fetches keyed by `${fetchSeq}\0${page}` — dedupes concurrent loadRange calls
 *  and lets a caller that needs the data (detail pager) await a request someone else issued. */
const inFlightPages = new Map()

/** Earliest retry time per failed page key. Without it the range sampler would re-issue
 *  a failing page on every tick for as long as the viewport sits on it. */
const pageRetryAt = new Map()
const PAGE_RETRY_MS = 5000

/** One toast per streak of range failures — a bad connection fails every page in the window. */
let lastRangeErrorAt = 0
const RANGE_ERROR_TOAST_MS = 5000

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

function buildSearchParams(q, page) {
  const params = { page, perpage: HUB_PER_PAGE }
  if (q.sort) params.sort = q.sort
  if (q.search) params.search = q.search
  if (q.selectedType !== 'All') params.type = q.selectedType
  if (q.paidFilter === 'free') params.category = 'Free'
  else if (q.paidFilter === 'paid') params.category = 'Paid'
  if (q.authorSearch) params.username = q.authorSearch
  if (q.selectedHubTags?.length) params.tags = q.selectedHubTags.join(',')
  if (q.license && q.license !== 'Any') params.license = q.license
  return params
}

/** Sentinel for a page slot the Hub claimed (via total_found) but did not return.
 *  Kept in the sparse map so the slot counts as loaded for whole-row gating. */
export const HUB_EMPTY_SLOT = Object.freeze({ _hubEmpty: true })

export function isHubEmptySlot(item) {
  return item != null && item._hubEmpty === true
}

/**
 * Write one API page into the sparse map. Resources fill the leading indices;
 * any remaining slots in the page (up to itemCount) become `HUB_EMPTY_SLOT`
 * so overcount / short tails render as confirmed-empty cards instead of skeletons.
 */
export function applyPageToIndex(byIndex, page, resources, itemCount, perPage = HUB_PER_PAGE) {
  const base = (page - 1) * perPage
  const pageEnd = Math.min(base + perPage, itemCount)
  for (let i = base; i < pageEnd; i++) {
    const j = i - base
    byIndex[i] = j < resources.length ? resources[j] : HUB_EMPTY_SLOT
  }
  return byIndex
}

/** Patch every sparse-map entry matching `rid`. Returns the same object if nothing matched. */
function patchResourcesById(byIndex, rid, patch) {
  let changed = false
  const next = { ...byIndex }
  for (const [k, r] of Object.entries(next)) {
    if (isHubEmptySlot(r)) continue
    if (String(r.resource_id) === rid) {
      next[k] = { ...r, ...patch }
      changed = true
    }
  }
  return changed ? next : byIndex
}

export const useHubStore = create(
  persist(
    (set, get) => ({
      // Sparse index → resource. Keys are numeric indices into the full result set.
      resourcesByIndex: {},
      /** Page numbers present in `resourcesByIndex`. Doubles as the scrollbar rail's
       *  "already browsed" record, since nothing is evicted before the next reset. */
      loadedPages: new Set(),
      /** Window size: the Hub's `total_found`. It overcounts, and the surplus tail is
       *  shown as confirmed-empty cards rather than clipped (see docs/API.md). */
      itemCount: 0,
      loading: false,
      error: null,
      // Hub filter signature at the last reset-fetch; lets HubView skip a redundant
      // reset+fetch on reveal. Not persisted (nor are resources), so launch refetches.
      lastFetchedKey: null,
      // Wall-clock of the last successful page-1 fetch (for the refresh-button tooltip).
      lastFetchedAt: null,
      // Cards with a `last_update` newer than this hub timestamp flash briefly after a
      // refresh; Infinity = nothing flashes. Transient hint, so never persisted.
      flashSince: Infinity,
      // Global index of the open detail in hub mode (null when unknown / wishlist).
      detailIndex: null,

      ...HUB_FILTER_DEFAULTS,
      sort: '',

      // `wlSort` values are the local sort keys defined in HubView (WISHLIST_SORTS);
      // default 'added' = created_at DESC.
      ...WISHLIST_FILTER_DEFAULTS,
      wlSort: 'added',

      detailResource: null,
      detailData: null,
      detailLoading: false,
      // Bumped on every explicit detail open (gallery click, cross-view nav, prev/next
      // jump) so HubDetail can be keyed on it and remount for a fresh load. Deliberately
      // NOT changed by followDetail, which must keep the webview mounted while the user
      // browses inside the guest page.
      detailNonce: 0,
      // Stack for HubDetail Back. Two entry kinds:
      //   `{ kind: 'resource', resource, title }` — prior package (dep drill); pop reopens it
      //   `{ kind: 'view', view, title }` — origin tab (library/content); pop closes detail
      //     and returns `{ navigateTo: view }` so the caller can switch tabs
      // Resource entries may omit `kind` (treated as resource). Cleared on gallery/pager
      // opens and on closeDetail. Not persisted.
      detailHistory: [],
      // Resource id whose detail followDetail is fetching in the background; dedupes
      // concurrent follows and lets stale responses be discarded after a newer
      // follow/open supersedes them.
      followingDetailId: null,
      cardMode: 'medium',
      cardWidth: 220,

      // Gallery data source (see GALLERY_MODES): 'hub' search or local 'wishlist'.
      // Not persisted — always start in hub mode after a restart; switching never
      // touches hub search state (filters/results/page), so switching back is lossless.
      galleryMode: 'hub',

      filterOptions: null,

      getItem: (index) => get().resourcesByIndex[index] ?? null,

      /**
       * Walk the sparse map from `index` in direction `dir` (±1) to the first slot that
       * isn't a confirmed-empty dummy — the pager and its prefetchers all step over those.
       * Returns `{ index, item }` with a null `item` for a slot that isn't loaded yet,
       * or null once the walk runs off the end of the list.
       */
      findNeighbor: (index, dir) => {
        const { resourcesByIndex, itemCount } = get()
        for (let i = index; dir > 0 ? i < itemCount : i >= 0; i += dir) {
          const item = resourcesByIndex[i] ?? null
          if (!isHubEmptySlot(item)) return { index: i, item }
        }
        return null
      },

      /** Look up a loaded gallery row by resource id (follow/dep navigation stubs). */
      findResourceById: (resourceId) => {
        const rid = String(resourceId)
        for (const r of Object.values(get().resourcesByIndex)) {
          if (isHubEmptySlot(r)) continue
          if (String(r.resource_id) === rid) return r
        }
        return null
      },

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

      fetchFilters: async (force) => {
        if (!force && get().filterOptions) return
        if (!get().itemCount) set({ loading: true })
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

      /**
       * Reset the sparse window and fetch page 1 for the current filters.
       * Filter changes and the refresh button call this; scrolling uses `loadRange`.
       */
      fetchResources: async (opts) => {
        const seq = ++fetchSeq
        pageRetryAt.clear()
        const state = get()
        // Cutoff is the top row's `last_update` (hub server time) — Latest Update is DESC, so
        // index 0 is the newest. Do not use `lastFetchedAt` (local `Date.now()`; clock skew
        // makes new cards never flash). Cold start / filter change / empty page: no flash.
        const sameQuery = hubFilterSignature(state) === state.lastFetchedKey
        const top = state.resourcesByIndex[0]
        const baseline = sameQuery && !isHubEmptySlot(top) ? parseInt(top?.last_update, 10) || 0 : 0
        const flashSince = opts?.forceRefresh && state.sort === LATEST_UPDATE_SORT && baseline > 0 ? baseline : Infinity
        clearTimeout(flashTimer)
        set({
          loading: true,
          error: null,
          flashSince: Infinity,
          resourcesByIndex: {},
          loadedPages: new Set(),
          itemCount: 0,
        })
        try {
          if (opts?.forceRefresh) {
            await window.api.hub.invalidateCaches()
            await get().fetchFilters(true)
          }
          const q = get()
          const result = await window.api.hub.search(buildSearchParams(q, 1))
          if (seq !== fetchSeq) return
          const incoming = result.resources || []
          syncInstalledFromResources(incoming)

          const itemCount = result.totalFound || 0
          const byIndex = {}
          applyPageToIndex(byIndex, 1, incoming, itemCount)

          if (Number.isFinite(flashSince)) flashTimer = setTimeout(() => set({ flashSince: Infinity }), FLASH_MS)
          set({
            resourcesByIndex: byIndex,
            loadedPages: new Set([1]),
            itemCount,
            loading: false,
            flashSince,
            lastFetchedKey: hubFilterSignature(q),
            lastFetchedAt: Date.now(),
          })
        } catch (err) {
          if (seq !== fetchSeq) return
          set({ error: err.message, loading: false, resourcesByIndex: {}, loadedPages: new Set(), itemCount: 0 })
        }
      },

      /**
       * Ensure indices `[start, end]` (inclusive) are loaded. Page-aligns to the API,
       * dedupes in-flight requests, backs a failed page off for `PAGE_RETRY_MS`, and fills
       * short/empty page tails with `HUB_EMPTY_SLOT`. Resolves once every page covering the
       * range has settled, whether this call issued it or joined one already in flight.
       * Loaded pages stay until the next filter reset / refresh.
       * @param opts.anchor Index to fetch outwards from when the range spans several pages.
       * @param opts.force  Ignore the failure backoff (user-initiated, e.g. the detail pager).
       */
      loadRange: async (start, end, opts) => {
        const state = get()
        // Filters have moved on but the reset fetch hasn't run yet — it owns the new query.
        if (hubFilterSignature(state) !== state.lastFetchedKey) return
        const count = state.itemCount
        if (count <= 0) return

        const lo = Math.max(0, Math.floor(start))
        const hi = Math.min(count - 1, Math.floor(end))
        if (hi < lo) return

        // Every request is tagged with the reset-fetch sequence it belongs to, so a
        // response that outlives its query is dropped and its key can never collide
        // with the same page under a later query.
        const epoch = fetchSeq
        const now = Date.now()
        const anchor = opts?.anchor != null ? opts.anchor : Math.floor((lo + hi) / 2)
        const anchorPage = Math.floor(anchor / HUB_PER_PAGE) + 1
        const firstPage = Math.floor(lo / HUB_PER_PAGE) + 1
        const lastPage = Math.floor(hi / HUB_PER_PAGE) + 1

        const pages = []
        // Someone else's in-flight requests for pages we were asked about: awaited but
        // not re-issued, so a caller that needs the data (the detail pager) still waits
        // for it instead of returning to an empty slot.
        const pending = []
        for (let p = firstPage; p <= lastPage; p++) {
          if (state.loadedPages.has(p)) continue
          const key = `${epoch}\0${p}`
          const inFlight = inFlightPages.get(key)
          if (inFlight) {
            pending.push(inFlight)
            continue
          }
          if (!opts?.force && (pageRetryAt.get(key) ?? 0) > now) continue
          pages.push(p)
        }
        // Nearest pages first so the viewport is served before the prefetch /
        // off-screen edges when several pages are needed at once.
        pages.sort((a, b) => Math.abs(a - anchorPage) - Math.abs(b - anchorPage))

        // Kick off all pages without serializing on each other so the first page
        // to arrive can paint immediately; still return a Promise for callers
        // (detail pager) that need to wait for this range.
        const promises = pages.map((page) => {
          const key = `${epoch}\0${page}`
          const promise = window.api.hub
            .search(buildSearchParams(state, page))
            .then((result) => {
              if (fetchSeq !== epoch) return
              const incoming = result.resources || []
              syncInstalledFromResources(incoming)
              set((s) => {
                const itemCount = result.totalFound || s.itemCount
                const byIndex = applyPageToIndex({ ...s.resourcesByIndex }, page, incoming, itemCount)
                return { resourcesByIndex: byIndex, loadedPages: new Set(s.loadedPages).add(page), itemCount }
              })
            })
            .catch((err) => {
              if (fetchSeq !== epoch) return
              pageRetryAt.set(key, Date.now() + PAGE_RETRY_MS)
              // A toast, not the `error` banner: the banner belongs to the query as a
              // whole, and one deep page failing shouldn't paint the gallery as broken.
              if (Date.now() - lastRangeErrorAt > RANGE_ERROR_TOAST_MS) {
                lastRangeErrorAt = Date.now()
                toast(`Failed to load hub results: ${err.message}`)
              }
            })
            .finally(() => {
              inFlightPages.delete(key)
            })
          inFlightPages.set(key, promise)
          return promise
        })
        await Promise.all([...promises, ...pending])
      },

      /**
       * Open a package detail overlay.
       * @param opts.pushHistory  Push the current package onto `detailHistory` (dep drill).
       * @param opts.history      Replace the stack (used by popDetailHistory). Cleared when neither is set.
       * @param opts.origin       Seed a view-root entry (`{ view: 'library'|'content' }`) so Back
       *                          returns to that tab. Ignored when history/pushHistory is set.
       * @param opts.index        Global hub-list index (hub mode pager).
       */
      openDetail: async (resource, opts) => {
        const rid = String(resource.resource_id)
        const cached = detailCache.get(rid)
        set((s) => {
          let detailHistory = []
          if (opts?.history) {
            detailHistory = opts.history
          } else if (opts?.pushHistory) {
            const cur = s.detailResource
            if (cur?.resource_id != null && String(cur.resource_id) !== rid) {
              detailHistory = [
                ...s.detailHistory,
                {
                  kind: 'resource',
                  resource: cur,
                  title: s.detailData?.title || cur.title || 'Package',
                },
              ]
            } else {
              detailHistory = s.detailHistory
            }
          } else if (opts?.origin?.view === 'library' || opts?.origin?.view === 'content') {
            detailHistory = [
              {
                kind: 'view',
                view: opts.origin.view,
                title: opts.origin.view === 'library' ? 'Library' : 'Content',
              },
            ]
          }
          return {
            detailResource: resource,
            detailData: cached || null,
            detailLoading: !cached,
            followingDetailId: null,
            detailNonce: s.detailNonce + 1,
            detailHistory,
            // A dep drill / Back keeps the gallery index of the package it started from,
            // so popping back to it restores a correct pager position.
            detailIndex: opts?.index ?? (opts?.history || opts?.pushHistory ? s.detailIndex : null),
          }
        })
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
            resourcesByIndex:
              detail._installSizeBytes != null
                ? patchResourcesById(s.resourcesByIndex, rid, { _installSizeBytes: detail._installSizeBytes })
                : s.resourcesByIndex,
          }))
        } catch (err) {
          if (String(get().detailResource?.resource_id) !== rid) return
          toast(`Failed to load hub detail: ${err.message}`)
          set({ detailLoading: false })
        }
      },

      /**
       * Pop the detail back-stack. Resource entry → reopen that package. View entry →
       * close detail and return `{ navigateTo }` for the caller. Empty → close to gallery.
       */
      popDetailHistory: () => {
        const { detailHistory } = get()
        if (!detailHistory.length) {
          get().closeDetail()
          return
        }
        const prev = detailHistory[detailHistory.length - 1]
        const rest = detailHistory.slice(0, -1)
        if (prev.kind === 'view') {
          get().closeDetail()
          return { navigateTo: prev.view }
        }
        return get().openDetail(prev.resource, { history: rest })
      },

      /**
       * Promote a dependency-installed package to a direct one, and reflect the new flag
       * in all three places it shows: the installed-state store, the gallery row, and the
       * open detail. Lives here because the gallery card and the detail panel both do it.
       */
      promoteResource: (filename, resourceId) => {
        window.api.packages.promote(filename, resourceId)
        const rid = String(resourceId)
        useInstalledStore.getState().update(rid, true, true, filename)
        set((s) => ({
          resourcesByIndex: patchResourcesById(s.resourcesByIndex, rid, { _isDirect: true }),
          detailData:
            s.detailData && String(s.detailData.resource_id) === rid
              ? { ...s.detailData, _isDirect: true }
              : s.detailData,
        }))
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
            // Followed from inside the webview, so it's some other package — the gallery
            // index no longer describes it, and a stale one would mis-position the pager.
            detailIndex: null,
            resourcesByIndex:
              detail._installSizeBytes != null
                ? patchResourcesById(s.resourcesByIndex, rid, { _installSizeBytes: detail._installSizeBytes })
                : s.resourcesByIndex,
          }))
        } catch (err) {
          if (get().followingDetailId !== rid) return
          toast(`Failed to load hub detail: ${err.message}`)
          set({ followingDetailId: null })
        }
      },

      closeDetail: () =>
        set({ detailResource: null, detailData: null, followingDetailId: null, detailHistory: [], detailIndex: null }),

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
            resourcesByIndex:
              detail._installSizeBytes != null
                ? patchResourcesById(s.resourcesByIndex, rid, { _installSizeBytes: detail._installSizeBytes })
                : s.resourcesByIndex,
          }))
        } catch (err) {
          toast(`Failed to refresh hub detail: ${err.message}`)
        }
      },

      resetFilters: () => {
        const sortOptions = get().filterOptions?.sort
        const nextSort = sortOptions?.[0] || ''
        set({ ...HUB_FILTER_DEFAULTS, sort: nextSort })
      },

      /** Reset the client-side wishlist filters (incl. search) to defaults. Separate from
       *  `resetFilters` (hub search) since the two modes never share filter state; `wlSort`
       *  is left as-is — reordering doesn't hide content. */
      resetWishlistFilters: () => set({ ...WISHLIST_FILTER_DEFAULTS }),

      // Jump to a Hub search scoped to one author. Only sets the author and
      // switches to hub mode — the other hub filters are left as-is (the wishlist
      // filters that were narrowing the view are deliberately NOT mirrored, since
      // the models aren't 1:1 and the intent is to broaden to the creator). The
      // authorSearch change drives HubView's fetch effect. Dismiss any open detail
      // so a stale panel from a previous hub visit doesn't cover the new results
      // (navigateTo intentionally restores detail on plain tab switches).
      searchHubForAuthor: (author) => {
        if (!author) return
        get().closeDetail()
        set({ authorSearch: author, galleryMode: 'hub' })
      },
    }),
    persistViewState('hub-view', {
      selectedType: asString,
      paidFilter: oneOf(['all', 'free', 'paid']),
      selectedHubTags: asArray,
      authorSearch: asString,
      license: asString,
      sort: asString,
      wlSearch: asString,
      wlType: asString,
      wlTags: asPolarityList,
      wlPaid: oneOf(['all', 'free', 'paid']),
      wlAuthor: asString,
      wlExcludedAuthors: asArray,
      wlLicense: asString,
      wlSort: asString,
      cardMode: oneOf(['minimal', 'medium']),
      cardWidth: asCardWidth,
    }),
  ),
)
