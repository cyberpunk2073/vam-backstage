import { useState, useEffect, useCallback, useRef, useMemo, Activity } from 'react'
import { Grid2x2, Grid3x3, RefreshCw, Pin, Ban, Loader2 } from 'lucide-react'
import { dismissTransientOverlays } from '@/lib/dismissOverlays'
import { CONTENT_TYPES, compareContentTypes, getTypeColor, formatTimeAgo } from '@/lib/utils'
import {
  useHubStore,
  hubFilterSignature,
  HUB_FILTER_DEFAULTS,
  WISHLIST_FILTER_DEFAULTS,
  CATALOG_FILTER_DEFAULTS,
  isHubEmptySlot,
} from '@/stores/useHubStore'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useWishlistStore } from '@/stores/useWishlistStore'
import { useCatalogStore } from '@/stores/useCatalogStore'
import { useDownloadStore } from '@/stores/useDownloadStore'
import { useInstalledStore } from '@/stores/useInstalledStore'
import { HubCard } from '@/components/PackageCard'
import HubDetail from '@/components/HubDetail'
import FilterPanel, { sectionActive } from '@/components/FilterPanel'
import { LICENSE_FILTER_OPTIONS, getHubResourceLicense } from '@/lib/licenses'
import { matchesSmartQuery, parseSmartQuery } from '@/lib/smart-search'
import { WISHLIST_IS_FLAGS, CATALOG_IS_FLAGS, wishlistFlags } from '@/lib/search-text'
import { matchesPolarityList, matchesAuthorFilter, matchesLicenseFilter } from '@/lib/filter-match'
import { parseCommaTags, suggestionCounts } from '@/lib/suggestion-counts'
import { SearchOnHubButton } from '@/components/SearchOnHubButton'
import { ThumbnailSizeSlider } from '@/components/ThumbnailSizeSlider'
import { VirtualGrid } from '@/components/VirtualGrid'
import { EmptyState } from '@/components/EmptyState'
import { META_DENSE } from '@/lib/typography'
import { HubBrowsedRail } from '@/components/HubBrowsedRail'
import { useHubRangeLoader } from '@/hooks/useHubRangeLoader'
import { useHubNavGestures } from '@/hooks/useHubNavGestures'
import { useDebouncedCommit } from '@/hooks/useDebouncedCommit'

/** Hub keyboard fields (search / author): avoid a network request on every keystroke. */
const HUB_TEXT_DEBOUNCE_MS = 320
/** Offline catalog keyboard fields: longer pause so typing doesn't refilter ~50k rows mid-word. */
const CATALOG_TEXT_DEBOUNCE_MS = 1000
const trimSearch = (v) => v.trim()
/**
 * Medium HubCard footer height below the square thumb. Unlike LibraryCard, HubCard adds a
 * full-width action button row, so it's taller: author+stats block (~68px) + button row
 * (pt-2 8 + gradient button 32 + pb-3 12 = ~52px) ≈ 120px.
 */
/** Hard lock — virtualization footer height; do not change without measuring cards. */
const HUB_CARD_FOOTER_PX = 120

/**
 * Local sort options for the wishlist gallery. Unlike the hub sort list (which
 * comes from the server and includes server-only notions like relevance), these
 * all map to fields present in the stored snapshot, so sorting is client-side.
 * `added` (default) reproduces the original fixed created_at DESC order.
 *
 * Deliberately NO "recently updated": `last_update` is frozen in the snapshot at
 * add / last-detail-open time, so a package updated afterward would sort as if it
 * never changed — the one field whose staleness corrupts the sort's own premise.
 * Downloads/rating/likes are also snapshot-stale, but only in magnitude (accepted
 * staleness policy) — relative order stays broadly right, so they're kept.
 */
const WISHLIST_SORTS = [
  { value: 'added', label: 'Recently added' },
  { value: 'author', label: 'Author (A–Z)' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'rating', label: 'Rating' },
  { value: 'likes', label: 'Reaction Score' },
]

const wlNum = (v) => parseInt(v || '0', 10) || 0
/** Tiebreaker: most recently wishlisted first (matches the default order). */
const wlByAdded = (a, b) => (b._wishlistedAt || 0) - (a._wishlistedAt || 0)
const WISHLIST_SORT_FNS = {
  added: wlByAdded,
  downloads: (a, b) => wlNum(b.download_count) - wlNum(a.download_count) || wlByAdded(a, b),
  rating: (a, b) => (parseFloat(b.rating_avg) || 0) - (parseFloat(a.rating_avg) || 0) || wlByAdded(a, b),
  likes: (a, b) => wlNum(b.reaction_score) - wlNum(a.reaction_score) || wlByAdded(a, b),
  name: (a, b) => String(a.title || '').localeCompare(String(b.title || '')) || wlByAdded(a, b),
  author: (a, b) => String(a.username || '').localeCompare(String(b.username || '')) || wlByAdded(a, b),
}

/** Offline catalog sorts — cache is one consistent snapshot, so last_update is valid. */
const CATALOG_SORTS = [
  { value: 'updated', label: 'Latest Update' },
  { value: 'author', label: 'Author (A–Z)' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'rating', label: 'Rating' },
  { value: 'likes', label: 'Reaction Score' },
]
const catByUpdated = (a, b) => wlNum(b.last_update) - wlNum(a.last_update)
const CATALOG_SORT_FNS = {
  updated: catByUpdated,
  downloads: (a, b) => wlNum(b.download_count) - wlNum(a.download_count) || catByUpdated(a, b),
  rating: (a, b) => (parseFloat(b.rating_avg) || 0) - (parseFloat(a.rating_avg) || 0) || catByUpdated(a, b),
  likes: (a, b) => wlNum(b.reaction_score) - wlNum(a.reaction_score) || catByUpdated(a, b),
  name: (a, b) => String(a.title || '').localeCompare(String(b.title || '')) || catByUpdated(a, b),
  author: (a, b) => String(a.username || '').localeCompare(String(b.username || '')) || catByUpdated(a, b),
}

/**
 * Tags on the stored snapshot mirror the hub detail `tags` field: a single
 * comma-separated string (same shape the library persists to `hub_tags`).
 */
function parseSnapshotTags(r) {
  return parseCommaTags(r.tags)
}

/** Local gallery filter dimensions (Wishlist + Offline), fixed order for facet cross-filtering. */
const LOCAL_HUB_FILTER_KEYS = ['search', 'type', 'tags', 'paid', 'author', 'license']

/**
 * Build one predicate per filter dimension bound to the current filter state.
 * The gallery ANDs them all; Type/Paid facet counts AND every dimension except
 * their own (standard cross-filtered faceting).
 */
function localHubPredicates({ search, type, tags, paid, author, excludedAuthors, license }) {
  const { tokens } = parseSmartQuery(search)
  const tagItems = tags || []
  const excluded = excludedAuthors || []
  return {
    search: (r) =>
      !tokens.length ||
      matchesSmartQuery(tokens, {
        text: () => [r.title, r.username, r.tag_line],
        author: () => r.username || '',
        tags: () => parseSnapshotTags(r),
        labels: () => [],
        types: () => [r.type].filter(Boolean),
        flags: () => wishlistFlags(r),
      }),
    type: (r) => type === 'All' || r.type === type,
    tags: (r) => matchesPolarityList(tagItems, parseSnapshotTags(r), { normalize: true }),
    paid: (r) => paid === 'all' || (paid === 'free' ? r.category === 'Free' : r.category === 'Paid'),
    author: (r) => matchesAuthorFilter(r.username, author, excluded),
    license: (r) => matchesLicenseFilter(getHubResourceLicense(r), license),
  }
}

/** Items passing every filter dimension except `exclude` — the input set for that facet's counts. */
function localHubItemsExcept(items, preds, exclude) {
  const keys = LOCAL_HUB_FILTER_KEYS.filter((k) => k !== exclude)
  return items.filter((r) => keys.every((k) => preds[k](r)))
}

/** Apply the full local filter/sort state to a snapshot list (Wishlist or Offline). */
function filterAndSortLocalHub(items, state, sortFns = WISHLIST_SORT_FNS) {
  const preds = localHubPredicates(state)
  // `.filter` always returns a fresh array, so sorting never mutates the store's.
  const result = items.filter((r) => LOCAL_HUB_FILTER_KEYS.every((k) => preds[k](r)))
  return result.sort(sortFns[state.sort] || WISHLIST_SORT_FNS.added)
}

export default function HubView({ onNavigate }) {
  const {
    resourcesByIndex,
    itemCount,
    loadedPages,
    loading,
    error,
    search,
    selectedType,
    paidFilter,
    authorSearch,
    selectedHubTags,
    sort,
    license,
    wlSearch,
    wlType,
    wlTags,
    wlPaid,
    wlAuthor,
    wlExcludedAuthors,
    wlLicense,
    wlSort,
    catSearch,
    catType,
    catTags,
    catPaid,
    catAuthor,
    catExcludedAuthors,
    catLicense,
    catSort,
    detailResource,
    detailData,
    detailNonce,
    detailHistory,
    detailIndex,
    cardMode,
    cardWidth,
    galleryMode,
    setGalleryMode,
    filterOptions,
    lastFetchedAt,
    flashSince,
    setSearch,
    setSelectedType,
    setPaidFilter,
    setAuthorSearch,
    setSelectedHubTags,
    setSort,
    setLicense,
    setWlSearch,
    setWlType,
    setWlTags,
    setWlPaid,
    setWlAuthor,
    setWlExcludedAuthors,
    setWlLicense,
    setWlSort,
    setCatSearch,
    setCatType,
    setCatTags,
    setCatPaid,
    setCatAuthor,
    setCatExcludedAuthors,
    setCatLicense,
    setCatSort,
    resetFilters,
    resetWishlistFilters,
    resetCatalogFilters,
    setCardMode,
    setCardWidth,
    fetchResources,
    openDetail,
    closeDetail,
    getItem,
    findNeighbor,
    promoteResource,
  } = useHubStore()

  const wishlistMode = galleryMode === 'wishlist'
  const offlineMode = galleryMode === 'offline'
  /** Wishlist + Offline: dense local list (same role `wishlistMode` had vs Hub). */
  const localMode = wishlistMode || offlineMode
  const detailBackLabel = detailHistory.length > 0 ? detailHistory[detailHistory.length - 1].title : null
  const detailNavRef = useRef(null)

  // Mouse Back / Alt+← / app-command → same stack as the Back button.
  // Prefer the webview whenever it has guest history.
  useHubNavGestures({ onNavigate, detailNavRef })

  // Back peels dep history; a view-root entry (arrived from Library/Content) closes
  // detail and returns to that tab. X / Hub-tab re-click still close to the Hub gallery.
  const handleDetailBack = useCallback(() => {
    const result = useHubStore.getState().popDetailHistory()
    if (result?.navigateTo) onNavigate?.(result.navigateTo)
  }, [onNavigate])

  const [hubScrollEl, setHubScrollEl] = useState(null)
  // Keyboard fields: draft in the input, commit to store after idle (Enter / autocomplete flush early).
  const { draft: searchDraft, onChange: handleSearchChange } = useDebouncedCommit(
    search,
    setSearch,
    HUB_TEXT_DEBOUNCE_MS,
    { prepare: trimSearch },
  )
  const { draft: authorDraft, onChange: handleAuthorChange } = useDebouncedCommit(
    authorSearch,
    setAuthorSearch,
    HUB_TEXT_DEBOUNCE_MS,
  )
  const { draft: catSearchDraft, onChange: handleCatSearchChange } = useDebouncedCommit(
    catSearch,
    setCatSearch,
    CATALOG_TEXT_DEBOUNCE_MS,
  )
  const { draft: catAuthorDraft, onChange: handleCatAuthorChange } = useDebouncedCommit(
    catAuthor,
    setCatAuthor,
    CATALOG_TEXT_DEBOUNCE_MS,
  )

  const sortOptions = useMemo(() => filterOptions?.sort || [], [filterOptions])
  const hubTypes = (filterOptions?.type || CONTENT_TYPES).toSorted(compareContentTypes)

  /** getInfo `tags` / `users`: map → numeric counts for autocomplete (ordered by ct in the UI) */
  const tagSuggestions = useMemo(() => {
    const raw = filterOptions?.tags
    if (!raw || typeof raw !== 'object') return {}
    const out = {}
    for (const [k, v] of Object.entries(raw)) {
      out[k] = Number(v?.ct ?? 0)
    }
    return out
  }, [filterOptions])
  const userSuggestions = useMemo(() => {
    const raw = filterOptions?.users
    if (!raw || typeof raw !== 'object') return {}
    const out = {}
    for (const [k, v] of Object.entries(raw)) {
      out[k] = Number(v?.ct ?? 0)
    }
    return out
  }, [filterOptions])

  useEffect(() => {
    useHubStore.getState().fetchFilters()
  }, [])

  // Wishlist: id set drives the segmented-control count + detail toggle state
  // (loaded once on mount); the full list is loaded lazily on entering the mode.
  const wishlistItems = useWishlistStore((s) => s.items)
  const wishlistCount = useWishlistStore((s) => s.ids.size)
  const wishlistLoading = useWishlistStore((s) => s.loading)
  const wishlistLoaded = useWishlistStore((s) => s.loaded)
  useEffect(() => {
    useWishlistStore.getState().loadIds()
  }, [])
  useEffect(() => {
    if (wishlistMode) useWishlistStore.getState().load()
  }, [wishlistMode])
  // Main fires `wishlist:updated` for background snapshot changes and peer
  // pin/unpin. Keep the old local behavior for bare events; only peer membership
  // invalidations refresh ids when the full wishlist has never been loaded.
  useEffect(() => {
    return window.api.onWishlistUpdated((data) => {
      const s = useWishlistStore.getState()
      if (s.loaded) s.load()
      else if (data?.membership) s.loadIds()
    })
  }, [])

  // Offline catalog: feature-gated; load JSON on tab entry; scan progress from main.
  const offlineCatalogEnabled = useCatalogStore((s) => s.enabled)
  const catalogItems = useCatalogStore((s) => s.items)
  const catalogLoading = useCatalogStore((s) => s.loading)
  const catalogLoaded = useCatalogStore((s) => s.loaded)
  const catalogScanning = useCatalogStore((s) => s.scanning)
  const catalogScanProgress = useCatalogStore((s) => s.scanProgress)
  const catalogScannedAt = useCatalogStore((s) => s.scannedAt)
  useEffect(() => {
    useCatalogStore.getState().loadEnabled()
  }, [])
  useEffect(() => {
    if (!offlineCatalogEnabled && galleryMode === 'offline') setGalleryMode('hub')
  }, [offlineCatalogEnabled, galleryMode, setGalleryMode])
  // Load on Offline entry; drop RAM rows when leaving. Scan keeps running in main;
  // leaving does not cancel — only Settings toggle / Cancel does.
  useEffect(() => {
    if (offlineMode && offlineCatalogEnabled) useCatalogStore.getState().load()
    else if (!offlineMode) useCatalogStore.getState().unload()
  }, [offlineMode, offlineCatalogEnabled])
  useEffect(() => {
    return window.api.onCatalogScanProgress((data) => {
      useCatalogStore.setState({ scanProgress: data })
    })
  }, [])

  const [availableWidth, setAvailableWidth] = useState(0)
  const [gridCols, setGridCols] = useState(1)
  const handleGridLayout = useCallback(({ availableWidth: w, cols }) => {
    setAvailableWidth(w)
    setGridCols(cols)
  }, [])

  // Wishlist filtering/sorting is client-side over the locally stored snapshots.
  const wishlistFiltered = useMemo(
    () =>
      filterAndSortLocalHub(wishlistItems, {
        search: wlSearch,
        type: wlType,
        tags: wlTags,
        paid: wlPaid,
        author: wlAuthor,
        excludedAuthors: wlExcludedAuthors,
        license: wlLicense,
        sort: wlSort,
      }),
    [wishlistItems, wlSearch, wlType, wlTags, wlPaid, wlAuthor, wlExcludedAuthors, wlLicense, wlSort],
  )
  const catalogFiltered = useMemo(
    () =>
      filterAndSortLocalHub(
        catalogItems,
        {
          search: catSearch,
          type: catType,
          tags: catTags,
          paid: catPaid,
          author: catAuthor,
          excludedAuthors: catExcludedAuthors,
          license: catLicense,
          sort: catSort,
        },
        CATALOG_SORT_FNS,
      ),
    [catalogItems, catSearch, catType, catTags, catPaid, catAuthor, catExcludedAuthors, catLicense, catSort],
  )
  const localFiltered = wishlistMode ? wishlistFiltered : offlineMode ? catalogFiltered : []

  // Per-mode scroll reset keys: each grid resets only on a filter change within its
  // own mode, so toggling Hub<->Wishlist keeps both scroll positions. The hub key
  // reuses the fetch-guard signature so "filters changed" means the same thing for
  // scroll reset and refetch.
  const hubScrollResetKey = useMemo(
    () => hubFilterSignature({ search, selectedType, paidFilter, authorSearch, selectedHubTags, sort, license }),
    [search, selectedType, paidFilter, authorSearch, selectedHubTags, sort, license],
  )
  const wlScrollResetKey = useMemo(
    () =>
      `${wlSearch}\0${wlType}\0${wlTags.map((t) => `${typeof t === 'object' ? t.value : t}:${t?.negate ? 1 : 0}`).join(',')}\0${wlPaid}\0${wlAuthor}\0${wlExcludedAuthors.join(',')}\0${wlLicense}\0${wlSort}`,
    [wlSearch, wlType, wlTags, wlPaid, wlAuthor, wlExcludedAuthors, wlLicense, wlSort],
  )
  const catScrollResetKey = useMemo(
    () =>
      `${catSearch}\0${catType}\0${catTags.map((t) => `${typeof t === 'object' ? t.value : t}:${t?.negate ? 1 : 0}`).join(',')}\0${catPaid}\0${catAuthor}\0${catExcludedAuthors.join(',')}\0${catLicense}\0${catSort}`,
    [catSearch, catType, catTags, catPaid, catAuthor, catExcludedAuthors, catLicense, catSort],
  )

  const hubShowSkeleton = itemCount === 0 && (loading || !sort)
  const compactCards = cardMode === 'minimal'
  const { onRangeChange: onHubRangeChange, scrubbing } = useHubRangeLoader({
    enabled: !localMode && !!sort,
    cols: gridCols,
  })

  // Filter changes → reset the sparse window and fetch page 1. Freshness-guarded so an
  // <Activity> reveal with unchanged filters is a no-op (doesn't wipe loaded pages).
  useEffect(() => {
    if (!sort) return // wait for sort options to load
    const s = useHubStore.getState()
    if (hubFilterSignature(s) === s.lastFetchedKey) return
    s.fetchResources()
  }, [search, selectedType, paidFilter, authorSearch, selectedHubTags, sort, license])

  // When packages change (promote, download completes, uninstall), resync install status from DB.
  // The hub detail panel is refreshed at App level; here we only patch the
  // gallery's resource objects + the global installed-state store.
  useEffect(() => {
    return window.api.onPackagesUpdated(async () => {
      // Re-list the wishlist so its cards' installed/dep badges reconcile too
      // (wishlist items aren't part of the hub sparse map, so the block below misses them).
      if (useWishlistStore.getState().loaded) useWishlistStore.getState().load()
      // Only while Offline is loaded in memory (unloaded off-tab).
      if (useCatalogStore.getState().loaded) useCatalogStore.getState().refreshInstallState()

      const { resourcesByIndex: byIndex } = useHubStore.getState()
      const entries = Object.entries(byIndex).filter(([, r]) => !isHubEmptySlot(r))
      if (entries.length === 0) return

      const ids = entries.map(([, r]) => r.resource_id)
      let snapshot = {}
      try {
        snapshot = await window.api.hub.localSnapshot(ids)
      } catch {
        return
      }

      useInstalledStore.getState().applyBatch(
        ids.map((id) => {
          const local = snapshot[String(id)]
          return local
            ? { hubResourceId: id, installed: true, isDirect: local.is_direct, filename: local.filename }
            : { hubResourceId: id, installed: false, isDirect: false, filename: null }
        }),
      )

      let changed = false
      const updated = { ...byIndex }
      for (const [k, r] of entries) {
        const id = String(r.resource_id)
        const local = snapshot[id]
        let next = r
        if (local) {
          next = { ...r, _installed: true, _isDirect: local.is_direct, _localFilename: local.filename }
        } else if (r._installed || r._localFilename != null) {
          next = { ...r, _installed: false, _isDirect: false, _localFilename: undefined }
        }
        if (
          next._installed !== r._installed ||
          next._isDirect !== r._isDirect ||
          next._localFilename !== r._localFilename
        ) {
          updated[k] = next
          changed = true
        }
      }
      if (changed) useHubStore.setState({ resourcesByIndex: updated })
    })
  }, [])

  const dlInstall = useDownloadStore((s) => s.install)

  const handleInstall = useCallback(
    (resource, hubDetail) => {
      dlInstall({ resourceId: resource.resource_id, hubDetail }).catch(() => {})
    },
    [dlInstall],
  )

  const handleViewInLibrary = useCallback(
    (resource) => {
      onNavigate('library', { selectPackage: resource._localFilename })
    },
    [onNavigate],
  )

  const handleFilterAuthor = useCallback(
    (author) => {
      // Filter within the current mode: in wishlist mode this drives the local
      // wishlist author filter, in hub mode the hub search. The gallery mode can't
      // change while a detail overlay is open (the toggle sits behind it), so
      // reading it live also correctly reflects where the detail was opened from.
      const mode = useHubStore.getState().galleryMode
      if (mode === 'wishlist') setWlAuthor(author)
      else if (mode === 'offline') setCatAuthor(author)
      else setAuthorSearch(author)
    },
    [setAuthorSearch, setWlAuthor, setCatAuthor],
  )

  // --- Prev/Next navigation through the current gallery list ---
  // Wishlist mode steps a dense filtered array. Hub mode uses the sparse map's global
  // index (`detailIndex`) so the counter reflects true position in the full result set.
  const wishlistViewRef = useRef(localFiltered)
  wishlistViewRef.current = localFiltered
  // Enabled after the first Prev/Next within a panel-open session; gates neighbor
  // detail prefetch so users who never step through don't pay extra `hub:detail` requests.
  const detailPrefetchRef = useRef(false)
  useEffect(() => {
    if (!detailResource) detailPrefetchRef.current = false
  }, [detailResource])

  const currentDetailId = detailResource ? String(detailData?.resource_id ?? detailResource.resource_id ?? '') : ''
  const wishlistDetailIdx = localMode
    ? currentDetailId
      ? localFiltered.findIndex((r) => String(r.resource_id) === currentDetailId)
      : -1
    : -1
  const hubDetailIdx = !localMode && detailIndex != null ? detailIndex : -1
  const detailIdx = localMode ? wishlistDetailIdx : hubDetailIdx
  // Hub: an unloaded hole still counts as a neighbor (Next may load it), so only an
  // all-empty remaining tail disables the pager.
  const hubHasNeighbor = (dir) => hubDetailIdx >= 0 && !!findNeighbor(hubDetailIdx + dir, dir)
  const canPrevDetail = localMode ? detailIdx > 0 : hubHasNeighbor(-1)
  const canNextDetail = localMode ? detailIdx >= 0 && detailIdx < localFiltered.length - 1 : hubHasNeighbor(1)
  // null → pager hidden (neighbor unknown, or dep-drill history is active)
  const detailPosition =
    detailBackLabel || detailIdx < 0 ? null : { n: detailIdx + 1, total: localMode ? localFiltered.length : itemCount }

  /** Step the open detail by `dir` (±1) through whichever list the gallery is showing. */
  const stepDetail = useCallback(
    async (dir) => {
      detailPrefetchRef.current = true
      const store = useHubStore.getState()
      if (store.galleryMode === 'wishlist' || store.galleryMode === 'offline') {
        const list = wishlistViewRef.current
        const cur = store.detailResource
          ? String(store.detailData?.resource_id ?? store.detailResource.resource_id ?? '')
          : ''
        const listIdx = cur ? list.findIndex((r) => String(r.resource_id) === cur) : -1
        const target = listIdx >= 0 ? list[listIdx + dir] : null
        if (target) openDetail(target)
        return
      }
      if (store.detailIndex == null) return
      let hit = store.findNeighbor(store.detailIndex + dir, dir)
      if (!hit) return
      if (!hit.item) {
        await store.loadRange(hit.index, hit.index, { force: true })
        hit = useHubStore.getState().findNeighbor(hit.index, dir)
        // Still nothing there (fresh empty page, or the request failed) — stop rather
        // than cascade-loading the overcount phantom tail one page at a time.
        if (!hit?.item) return
      }
      openDetail(hit.item, { index: hit.index })
    },
    [openDetail],
  )

  const handleDetailPrev = useCallback(() => stepDetail(-1), [stepDetail])
  const handleDetailNext = useCallback(() => stepDetail(1), [stepDetail])

  // Prefetch the next hub slot when nearing an unloaded neighbor so Next is rarely a wait.
  useEffect(() => {
    if (localMode || hubDetailIdx < 0) return
    const hit = findNeighbor(hubDetailIdx + 1, 1)
    if (hit && !hit.item) useHubStore.getState().loadRange(hit.index, hit.index)
  }, [localMode, hubDetailIdx, findNeighbor, resourcesByIndex])

  // Once stepping through, warm neighbor details into the main-process LRU cache
  // so Prev/Next resolve without a network round-trip (LRU may have evicted a
  // previously viewed item; Prev neighbors were never warmed until now).
  useEffect(() => {
    if (localMode || !detailPrefetchRef.current || hubDetailIdx < 0) return
    const { prefetchDetail } = useHubStore.getState()
    for (const dir of [1, -1]) {
      const hit = findNeighbor(hubDetailIdx + dir, dir)
      if (hit?.item?.resource_id) prefetchDetail(hit.item.resource_id)
    }
  }, [localMode, hubDetailIdx, findNeighbor, resourcesByIndex])

  const sections = useMemo(
    () => [
      {
        key: 'type',
        label: 'Type',
        type: 'list',
        value: selectedType,
        default: HUB_FILTER_DEFAULTS.selectedType,
        onChange: setSelectedType,
        items: [
          { value: 'All', label: 'All' },
          ...hubTypes.map((t) => ({ value: t, label: t, color: getTypeColor(t) })),
        ],
      },
      {
        key: 'paid',
        label: 'Pricing',
        type: 'list',
        value: paidFilter,
        default: HUB_FILTER_DEFAULTS.paidFilter,
        onChange: setPaidFilter,
        items: [
          { value: 'all', label: 'All' },
          { value: 'free', label: 'Free' },
          { value: 'paid', label: 'Paid' },
        ],
      },
      {
        key: 'tags',
        label: 'Tags',
        type: 'tags-autocomplete',
        value: selectedHubTags,
        default: HUB_FILTER_DEFAULTS.selectedHubTags,
        onChange: setSelectedHubTags,
        suggestions: tagSuggestions,
        placeholder: 'Filter by tags…',
      },
      {
        key: 'author',
        label: 'Author',
        type: 'text-autocomplete',
        value: authorDraft,
        default: HUB_FILTER_DEFAULTS.authorSearch,
        onChange: handleAuthorChange,
        suggestions: userSuggestions,
        placeholder: 'Filter by author…',
      },
      {
        key: 'license',
        label: 'License',
        type: 'select',
        value: license,
        default: HUB_FILTER_DEFAULTS.license,
        onChange: setLicense,
        options: LICENSE_FILTER_OPTIONS,
      },
      { key: 'sort', label: 'Sort by', type: 'select', value: sort, onChange: setSort, options: sortOptions },
    ],
    [
      selectedType,
      paidFilter,
      selectedHubTags,
      authorDraft,
      license,
      sort,
      sortOptions,
      hubTypes,
      tagSuggestions,
      userSuggestions,
      setSelectedType,
      setPaidFilter,
      setSelectedHubTags,
      handleAuthorChange,
      setLicense,
      setSort,
    ],
  )

  // Type/Paid: cross-filtered facet counts. Author/tag autocomplete uses overall
  // totals via wishlistSuggestCounts (same model as Library/Content).
  const wishlistFacets = useMemo(() => {
    const preds = localHubPredicates({
      search: wlSearch,
      type: wlType,
      tags: wlTags,
      paid: wlPaid,
      author: wlAuthor,
      excludedAuthors: wlExcludedAuthors,
      license: wlLicense,
    })
    const bucket = (items, fn) => {
      const m = new Map()
      for (const r of items) fn(r, m)
      return m
    }
    const addType = (r, m) => r.type && m.set(r.type, (m.get(r.type) || 0) + 1)
    const typeFacet = bucket(localHubItemsExcept(wishlistItems, preds, 'type'), addType)

    let free = 0
    let paid = 0
    for (const r of localHubItemsExcept(wishlistItems, preds, 'paid')) {
      if (r.category === 'Free') free++
      else if (r.category === 'Paid') paid++
    }

    // Type list mirrors the hub shape: the fixed core categories always come
    // first in canonical order, then extra hub types fall into the "N more"
    // spoiler. That tail's membership + order use OVERALL counts (across the
    // whole wishlist, not the facet) so it stays put as filters toggle; only the
    // number shown on each row is the live facet count. With All + the core
    // categories filling the collapse threshold, the tail hides by default like
    // the hub sidebar.
    const coreSet = new Set(CONTENT_TYPES)
    const typeOverall = bucket(wishlistItems, addType)
    const typeItems = [
      { value: 'All', label: 'All' },
      ...CONTENT_TYPES.map((t) => ({ value: t, label: t, color: getTypeColor(t), count: typeFacet.get(t) || 0 })),
      ...[...typeOverall.entries()]
        .filter(([t]) => !coreSet.has(t))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([t]) => ({ value: t, label: t, color: getTypeColor(t), count: typeFacet.get(t) || 0 })),
    ]
    const paidItems = [
      { value: 'all', label: 'All' },
      { value: 'free', label: 'Free', count: free },
      { value: 'paid', label: 'Paid', count: paid },
    ]
    return { typeItems, paidItems }
  }, [wishlistItems, wlSearch, wlType, wlTags, wlPaid, wlAuthor, wlExcludedAuthors, wlLicense])

  const wishlistSuggestCounts = useMemo(
    () =>
      suggestionCounts(wishlistItems, {
        author: (r) => r.username,
        tags: (r) => r.tags,
      }),
    [wishlistItems],
  )

  // Offline catalog: same facet model over the cached list.
  const catalogFacets = useMemo(() => {
    const preds = localHubPredicates({
      search: catSearch,
      type: catType,
      tags: catTags,
      paid: catPaid,
      author: catAuthor,
      excludedAuthors: catExcludedAuthors,
      license: catLicense,
    })
    const bucket = (items, fn) => {
      const m = new Map()
      for (const r of items) fn(r, m)
      return m
    }
    const addType = (r, m) => r.type && m.set(r.type, (m.get(r.type) || 0) + 1)
    const typeFacet = bucket(localHubItemsExcept(catalogItems, preds, 'type'), addType)
    let free = 0
    let paid = 0
    for (const r of localHubItemsExcept(catalogItems, preds, 'paid')) {
      if (r.category === 'Free') free++
      else if (r.category === 'Paid') paid++
    }
    const coreSet = new Set(CONTENT_TYPES)
    const typeOverall = bucket(catalogItems, addType)
    const typeItems = [
      { value: 'All', label: 'All' },
      ...CONTENT_TYPES.map((t) => ({ value: t, label: t, color: getTypeColor(t), count: typeFacet.get(t) || 0 })),
      ...[...typeOverall.entries()]
        .filter(([t]) => !coreSet.has(t))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([t]) => ({ value: t, label: t, color: getTypeColor(t), count: typeFacet.get(t) || 0 })),
    ]
    return {
      typeItems,
      paidItems: [
        { value: 'all', label: 'All' },
        { value: 'free', label: 'Free', count: free },
        { value: 'paid', label: 'Paid', count: paid },
      ],
    }
  }, [catalogItems, catSearch, catType, catTags, catPaid, catAuthor, catExcludedAuthors, catLicense])

  const catalogSuggestCounts = useMemo(
    () =>
      suggestionCounts(catalogItems, {
        author: (r) => r.username,
        tags: (r) => r.tags,
      }),
    [catalogItems],
  )

  const wishlistSections = useMemo(
    () => [
      {
        key: 'wl-type',
        label: 'Type',
        type: 'list',
        value: wlType,
        default: WISHLIST_FILTER_DEFAULTS.wlType,
        onChange: setWlType,
        items: wishlistFacets.typeItems,
      },
      {
        key: 'wl-paid',
        label: 'Pricing',
        type: 'list',
        value: wlPaid,
        default: WISHLIST_FILTER_DEFAULTS.wlPaid,
        onChange: setWlPaid,
        items: wishlistFacets.paidItems,
      },
      {
        key: 'wl-tags',
        label: 'Tags',
        type: 'tags-autocomplete',
        value: wlTags,
        default: WISHLIST_FILTER_DEFAULTS.wlTags,
        onChange: setWlTags,
        suggestions: wishlistSuggestCounts.tags,
        placeholder: 'Filter by tags…',
        allowNegate: true,
      },
      {
        key: 'wl-author',
        label: 'Author',
        type: 'text-autocomplete',
        value: wlAuthor,
        default: WISHLIST_FILTER_DEFAULTS.wlAuthor,
        onChange: setWlAuthor,
        excluded: wlExcludedAuthors,
        onExcludedChange: setWlExcludedAuthors,
        suggestions: wishlistSuggestCounts.authors,
        placeholder: 'Filter by author…',
        titleAction: wlAuthor ? <SearchOnHubButton author={wlAuthor} /> : null,
      },
      {
        key: 'wl-license',
        label: 'License',
        type: 'select',
        value: wlLicense,
        default: WISHLIST_FILTER_DEFAULTS.wlLicense,
        onChange: setWlLicense,
        options: LICENSE_FILTER_OPTIONS,
      },
      { key: 'wl-sort', label: 'Sort by', type: 'select', value: wlSort, onChange: setWlSort, options: WISHLIST_SORTS },
    ],
    [
      wlType,
      wlTags,
      wlPaid,
      wlAuthor,
      wlExcludedAuthors,
      wlLicense,
      wlSort,
      wishlistFacets,
      wishlistSuggestCounts,
      setWlType,
      setWlTags,
      setWlPaid,
      setWlAuthor,
      setWlExcludedAuthors,
      setWlLicense,
      setWlSort,
    ],
  )

  const catalogSections = useMemo(
    () => [
      {
        key: 'cat-type',
        label: 'Type',
        type: 'list',
        value: catType,
        default: CATALOG_FILTER_DEFAULTS.catType,
        onChange: setCatType,
        items: catalogFacets.typeItems,
      },
      {
        key: 'cat-paid',
        label: 'Pricing',
        type: 'list',
        value: catPaid,
        default: CATALOG_FILTER_DEFAULTS.catPaid,
        onChange: setCatPaid,
        items: catalogFacets.paidItems,
      },
      {
        key: 'cat-tags',
        label: 'Tags',
        type: 'tags-autocomplete',
        value: catTags,
        default: CATALOG_FILTER_DEFAULTS.catTags,
        onChange: setCatTags,
        suggestions: catalogSuggestCounts.tags,
        placeholder: 'Filter by tags…',
        allowNegate: true,
      },
      {
        key: 'cat-author',
        label: 'Author',
        type: 'text-autocomplete',
        value: catAuthorDraft,
        default: CATALOG_FILTER_DEFAULTS.catAuthor,
        onChange: handleCatAuthorChange,
        excluded: catExcludedAuthors,
        onExcludedChange: setCatExcludedAuthors,
        suggestions: catalogSuggestCounts.authors,
        placeholder: 'Filter by author…',
        titleAction: catAuthor ? <SearchOnHubButton author={catAuthor} /> : null,
      },
      {
        key: 'cat-license',
        label: 'License',
        type: 'select',
        value: catLicense,
        default: CATALOG_FILTER_DEFAULTS.catLicense,
        onChange: setCatLicense,
        options: LICENSE_FILTER_OPTIONS,
      },
      {
        key: 'cat-sort',
        label: 'Sort by',
        type: 'select',
        value: catSort,
        onChange: setCatSort,
        options: CATALOG_SORTS,
      },
    ],
    [
      catType,
      catTags,
      catPaid,
      catAuthorDraft,
      catAuthor,
      catExcludedAuthors,
      catLicense,
      catSort,
      catalogFacets,
      catalogSuggestCounts,
      setCatType,
      setCatTags,
      setCatPaid,
      handleCatAuthorChange,
      setCatExcludedAuthors,
      setCatLicense,
      setCatSort,
    ],
  )

  const activeSections = offlineMode ? catalogSections : wishlistMode ? wishlistSections : sections
  const activeFilterCount = activeSections.filter((s) => sectionActive(s) === true).length

  const refreshBusy = loading && itemCount === 0

  return (
    <div className="h-full flex min-w-0 relative">
      {/* Shared panel: Hub filters drive the server query; Wishlist/Offline run client-side. */}
      <FilterPanel
        search={offlineMode ? catSearchDraft : wishlistMode ? wlSearch : searchDraft}
        onSearchChange={offlineMode ? handleCatSearchChange : wishlistMode ? setWlSearch : handleSearchChange}
        smartSearch={
          offlineMode
            ? {
                authors: catalogSuggestCounts.authors,
                tags: catalogSuggestCounts.tags,
                labels: [],
                types: hubTypes,
                flags: CATALOG_IS_FLAGS,
              }
            : wishlistMode
              ? {
                  authors: wishlistSuggestCounts.authors,
                  tags: wishlistSuggestCounts.tags,
                  labels: [],
                  types: hubTypes,
                  flags: WISHLIST_IS_FLAGS,
                }
              : null
        }
        sections={offlineMode ? catalogSections : wishlistMode ? wishlistSections : sections}
      />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Toolbar */}
        <div className="h-10 flex items-center px-4 border-b border-border shrink-0 gap-2">
          {/* dismissTransientOverlays: the mode toggle hides one <Activity> gallery surface, which
              would orphan any overlay (tooltip/menu) still open or animating out inside it. */}
          <div className="flex items-center gap-px bg-elevated rounded p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => {
                dismissTransientOverlays()
                setGalleryMode('hub')
              }}
              className={`px-2 py-1 rounded cursor-pointer transition-colors ${!localMode ? 'bg-hover text-text-primary' : 'text-text-aside hover:text-text-secondary'}`}
            >
              Hub
            </button>
            <button
              type="button"
              onClick={() => {
                dismissTransientOverlays()
                setGalleryMode('wishlist')
              }}
              className={`px-2 py-1 rounded cursor-pointer transition-colors flex items-center gap-1 ${wishlistMode ? 'bg-hover text-text-primary' : 'text-text-aside hover:text-text-secondary'}`}
            >
              Wishlist
              {wishlistCount > 0 && <span className="tabular-nums opacity-70">{wishlistCount}</span>}
            </button>
            {offlineCatalogEnabled && (
              <button
                type="button"
                onClick={() => {
                  dismissTransientOverlays()
                  setGalleryMode('offline')
                }}
                className={`px-2 py-1 rounded cursor-pointer transition-colors ${offlineMode ? 'bg-hover text-text-primary' : 'text-text-aside hover:text-text-secondary'}`}
              >
                Offline
              </button>
            )}
          </div>
          <span className={META_DENSE}>
            {offlineMode
              ? catalogScanning
                ? catalogScanProgress
                  ? `Scanning… ${catalogScanProgress.count.toLocaleString()} (page ${catalogScanProgress.page}/${catalogScanProgress.totalPages || '?'})`
                  : 'Scanning…'
                : catalogLoading && !catalogLoaded
                  ? 'Loading…'
                  : catalogFiltered.length !== catalogItems.length
                    ? `${catalogFiltered.length.toLocaleString()} of ${catalogItems.length.toLocaleString()} cached`
                    : catalogItems.length
                      ? `${catalogItems.length.toLocaleString()} cached`
                      : 'No cache'
              : wishlistMode
                ? wishlistLoading && !wishlistLoaded
                  ? 'Loading…'
                  : wishlistFiltered.length !== wishlistItems.length
                    ? `${wishlistFiltered.length.toLocaleString()} of ${wishlistItems.length.toLocaleString()} wishlisted`
                    : `${wishlistItems.length.toLocaleString()} wishlisted`
                : loading && itemCount === 0
                  ? 'Searching…'
                  : `${itemCount.toLocaleString()} packages`}
          </span>
          {activeFilterCount > 0 && (
            <span className={`shrink-0 flex items-center gap-1.5 whitespace-nowrap ${META_DENSE}`}>
              <span aria-hidden="true">·</span>
              <span>
                {activeFilterCount} {activeFilterCount === 1 ? 'filter' : 'filters'}
              </span>
              <span>
                (
                <button
                  type="button"
                  onClick={() =>
                    offlineMode ? resetCatalogFilters() : wishlistMode ? resetWishlistFilters() : resetFilters()
                  }
                  title="Reset all filters to their defaults"
                  className="text-text-aside hover:text-text-secondary transition-colors cursor-pointer"
                >
                  Reset
                </button>
                )
              </span>
            </span>
          )}
          {/* Network-backed hub search gets a cache-busting refresh; the wishlist
              is local + live, so it needs none. */}
          {!localMode && (
            <button
              type="button"
              onClick={() => fetchResources({ forceRefresh: true })}
              disabled={refreshBusy}
              title={lastFetchedAt ? `Refresh (${formatTimeAgo(lastFetchedAt)})` : 'Refresh'}
              className="p-1 rounded text-text-aside hover:text-text-secondary disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <RefreshCw size={13} className={refreshBusy ? 'animate-spin' : ''} />
            </button>
          )}
          {offlineMode && (
            <>
              {catalogScannedAt && !catalogScanning && (
                <span className={META_DENSE} title={new Date(catalogScannedAt).toLocaleString()}>
                  · scanned {formatTimeAgo(catalogScannedAt)}
                </span>
              )}
              {catalogScanning ? (
                <button
                  type="button"
                  onClick={() => useCatalogStore.getState().cancelScan()}
                  className="px-2 py-0.5 rounded text-[11px] text-text-aside hover:text-text-secondary border border-border cursor-pointer"
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => useCatalogStore.getState().startScan()}
                  disabled={catalogLoading}
                  title={
                    catalogItems.length
                      ? 'Refresh catalog — fetch new/updated packages from the Hub head'
                      : 'Scan Hub into local cache'
                  }
                  className="px-2 py-0.5 rounded text-[11px] text-text-aside hover:text-text-secondary border border-border cursor-pointer disabled:opacity-30 flex items-center gap-1"
                >
                  <RefreshCw size={11} />
                  {catalogItems.length ? 'Refresh' : 'Scan Hub'}
                </button>
              )}
            </>
          )}
          <div className="flex-1" />
          <ThumbnailSizeSlider cardWidth={cardWidth} availableWidth={availableWidth} onCardWidthChange={setCardWidth} />
          <div className="flex items-center gap-px bg-elevated rounded p-0.5">
            <button
              type="button"
              onClick={() => setCardMode('minimal')}
              title="Small cards"
              className={`p-1.5 rounded cursor-pointer ${cardMode === 'minimal' ? 'bg-hover text-text-primary' : 'text-text-aside'}`}
            >
              <Grid3x3 size={14} />
            </button>
            <button
              type="button"
              onClick={() => setCardMode('medium')}
              title="Large cards"
              className={`p-1.5 rounded cursor-pointer ${cardMode === 'medium' ? 'bg-hover text-text-primary' : 'text-text-aside'}`}
            >
              <Grid2x2 size={14} />
            </button>
          </div>
        </div>

        {/* Gallery — cards + wishlist are two <Activity>-kept scroll surfaces, so
            toggling modes preserves each one's scroll and DOM. */}
        <div className="relative flex-1 min-h-0 flex flex-col min-w-0">
          <Activity mode={localMode ? 'hidden' : 'visible'}>
            <div className="relative flex-1 min-h-0 flex flex-col min-w-0">
              {error && (
                <div className="shrink-0 mx-4 mt-4 px-4 py-3 rounded-lg bg-error/10 border border-error/20 text-error text-xs select-text cursor-text">
                  {error}
                </div>
              )}
              {hubShowSkeleton ? (
                <div className="flex-1 overflow-y-auto p-4">
                  <div
                    className="grid gap-3 content-start"
                    style={{ gridTemplateColumns: `repeat(auto-fill,minmax(min(${cardWidth}px,100%),1fr))` }}
                  >
                    {Array.from({ length: 12 }, (_, i) => (
                      <SkeletonCard key={i} mode={cardMode} />
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <VirtualGrid
                    itemCount={itemCount}
                    getItem={getItem}
                    itemWidth={cardWidth}
                    itemHeight={compactCards ? cardWidth : cardWidth + HUB_CARD_FOOTER_PX}
                    fixedHeight={compactCards ? 0 : HUB_CARD_FOOTER_PX}
                    className="flex-1"
                    scrollResetKey={hubScrollResetKey}
                    onLayout={handleGridLayout}
                    hideEmptyMessage
                    onRangeChange={onHubRangeChange}
                    onScrollRef={setHubScrollEl}
                    renderSkeleton={() => <SkeletonCard mode={cardMode} />}
                    renderItem={(r, index) =>
                      isHubEmptySlot(r) ? (
                        <HubEmptyCard key={`empty-${index}`} mode={cardMode} />
                      ) : (
                        <HubCard
                          key={r.resource_id}
                          resource={r}
                          onClick={(resource) => openDetail(resource, { index })}
                          onViewInLibrary={handleViewInLibrary}
                          onInstall={handleInstall}
                          onPromote={promoteResource}
                          onFilterAuthor={handleFilterAuthor}
                          mode={cardMode}
                          hideType={selectedType !== 'All'}
                          flash={r.last_update > flashSince}
                          deferThumb={scrubbing}
                        />
                      )
                    }
                  />
                  <HubBrowsedRail scrollEl={hubScrollEl} itemCount={itemCount} loadedPages={loadedPages} />
                  {!loading && sort && itemCount === 0 && (
                    <EmptyState
                      overlay
                      className="pointer-events-none absolute inset-0 flex items-start justify-center"
                    >
                      No packages found
                    </EmptyState>
                  )}
                </>
              )}
            </div>
          </Activity>

          <Activity mode={wishlistMode ? 'visible' : 'hidden'}>
            <div className="relative flex-1 min-h-0 flex flex-col min-w-0">
              <VirtualGrid
                items={wishlistFiltered}
                itemWidth={cardWidth}
                itemHeight={compactCards ? cardWidth : cardWidth + HUB_CARD_FOOTER_PX}
                fixedHeight={compactCards ? 0 : HUB_CARD_FOOTER_PX}
                className="flex-1"
                scrollResetKey={wlScrollResetKey}
                onLayout={handleGridLayout}
                hideEmptyMessage
                renderItem={(r) => (
                  <HubCard
                    key={r.resource_id}
                    resource={r}
                    onClick={openDetail}
                    onViewInLibrary={handleViewInLibrary}
                    onInstall={handleInstall}
                    onPromote={promoteResource}
                    onFilterAuthor={handleFilterAuthor}
                    mode={cardMode}
                    hideType={wlType !== 'All'}
                    wishlist
                  />
                )}
              />
              {wishlistLoaded && wishlistItems.length === 0 && (
                <EmptyState
                  overlay
                  icon={<Pin size={28} className="text-text-tertiary" />}
                  className="pointer-events-none absolute inset-0 flex flex-col items-center max-w-sm mx-auto"
                  clarification={
                    <>
                      Open a package and tap the <Pin size={12} className="inline align-[-1px]" /> button in its details
                      to add it here.
                    </>
                  }
                >
                  Your wishlist is empty.
                </EmptyState>
              )}
              {wishlistItems.length > 0 && wishlistFiltered.length === 0 && (
                <EmptyState overlay className="pointer-events-none absolute inset-0 flex items-start justify-center">
                  No wishlisted packages match your filters
                </EmptyState>
              )}
            </div>
          </Activity>

          <Activity mode={offlineMode ? 'visible' : 'hidden'}>
            <div className="relative flex-1 min-h-0 flex flex-col min-w-0">
              <VirtualGrid
                items={catalogFiltered}
                itemWidth={cardWidth}
                itemHeight={compactCards ? cardWidth : cardWidth + HUB_CARD_FOOTER_PX}
                fixedHeight={compactCards ? 0 : HUB_CARD_FOOTER_PX}
                className="flex-1"
                scrollResetKey={catScrollResetKey}
                onLayout={handleGridLayout}
                hideEmptyMessage
                renderItem={(r) => (
                  <HubCard
                    key={r.resource_id}
                    resource={r}
                    onClick={openDetail}
                    onViewInLibrary={handleViewInLibrary}
                    onInstall={handleInstall}
                    onPromote={promoteResource}
                    onFilterAuthor={handleFilterAuthor}
                    mode={cardMode}
                    hideType={catType !== 'All'}
                  />
                )}
              />
              {/* Full first scan only — refresh keeps the grid and reports progress in the toolbar. */}
              {catalogScanning && catalogItems.length === 0 && (
                <EmptyState
                  overlay
                  icon={<Loader2 size={28} className="text-text-tertiary animate-spin" />}
                  className="pointer-events-none absolute inset-0 flex flex-col items-center max-w-sm mx-auto"
                  clarification={
                    catalogScanProgress
                      ? `${catalogScanProgress.count.toLocaleString()} packages · page ${catalogScanProgress.page} of ${catalogScanProgress.totalPages || '?'}`
                      : 'Fetching the full Hub catalog…'
                  }
                >
                  Scanning Hub
                </EmptyState>
              )}
              {!catalogScanning && catalogLoaded && catalogItems.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center pt-16 max-w-sm mx-auto px-4">
                  <EmptyState clarification="Downloads the full Hub package list (no thumbnails) for local filtering.">
                    No offline cache yet
                  </EmptyState>
                  <button
                    type="button"
                    onClick={() => useCatalogStore.getState().startScan()}
                    className="mt-3 px-3 py-1.5 rounded bg-hover text-text-primary text-sm cursor-pointer hover:bg-border"
                  >
                    Scan Hub
                  </button>
                </div>
              )}
              {!catalogScanning && catalogItems.length > 0 && catalogFiltered.length === 0 && (
                <EmptyState overlay className="pointer-events-none absolute inset-0 flex items-start justify-center">
                  No cached packages match your filters
                </EmptyState>
              )}
            </div>
          </Activity>
        </div>
      </div>
      {detailResource && (
        <HubDetail
          key={detailNonce}
          ref={detailNavRef}
          resource={detailResource}
          onBack={handleDetailBack}
          onClose={closeDetail}
          onNavigate={onNavigate}
          onInstall={handleInstall}
          onFilterAuthor={handleFilterAuthor}
          onPrev={handleDetailPrev}
          onNext={handleDetailNext}
          canPrev={canPrevDetail}
          canNext={canNextDetail}
          position={detailPosition}
          backLabel={detailBackLabel}
        />
      )}
    </div>
  )
}

// --- Gallery placeholder card ---

/**
 * Stand-in for a card that isn't there: shimmering while the slot loads, or — with
 * `empty` — static blocks behind a dashed border and a ban watermark for a slot the
 * Hub counted but never returned. One component so the two always share a footprint.
 */
function SkeletonCard({ mode = 'medium', empty = false }) {
  const minimal = mode === 'minimal'
  const fill = empty ? 'bg-hover' : 'skeleton'
  const border = empty ? 'border-dashed border-border-bright' : 'border-border'
  return (
    <div className={`w-full min-w-0 bg-surface border ${border} rounded-lg overflow-hidden flex flex-col`}>
      <div className={`relative aspect-square flex items-center justify-center ${fill}`}>
        {empty && <Ban size={52} strokeWidth={3.5} className="text-border-bright" aria-hidden />}
      </div>
      {!minimal && (
        <div className="p-3">
          <div className="flex items-center gap-2">
            <div className={`w-[30px] h-[30px] rounded-sm shrink-0 ${fill}`} />
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className={`h-3.5 rounded w-3/4 ${fill}`} />
              <div className={`h-2.5 rounded w-1/2 ${fill}`} />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-3">
            <div className={`h-2.5 rounded w-10 ${fill}`} />
            <div className={`h-2.5 rounded w-10 ${fill}`} />
            <div className={`h-2.5 rounded w-8 ${fill}`} />
          </div>
          <div className={`h-[30px] rounded w-full mt-3 ${fill}`} />
        </div>
      )}
    </div>
  )
}

/** Confirmed-empty slot: the Hub claimed a card here but returned nothing. */
function HubEmptyCard({ mode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="w-full min-w-0">
          <SkeletonCard mode={mode} empty />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-56 text-left">
        Hub returned an empty result here. The catalog count includes packages the Hub will not return.
      </TooltipContent>
    </Tooltip>
  )
}
