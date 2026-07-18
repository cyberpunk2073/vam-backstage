import { useState, useEffect, useCallback, useRef, useMemo, Activity } from 'react'
import { Grid2x2, Grid3x3, Loader2, RefreshCw, Pin } from 'lucide-react'
import { dismissTransientOverlays } from '@/lib/dismissOverlays'
import { CONTENT_TYPES, compareContentTypes, getTypeColor } from '@/lib/utils'
import { useHubStore, hubFilterSignature, HUB_FILTER_DEFAULTS, WISHLIST_FILTER_DEFAULTS } from '@/stores/useHubStore'
import { useWishlistStore } from '@/stores/useWishlistStore'
import { useDownloadStore } from '@/stores/useDownloadStore'
import { useInstalledStore } from '@/stores/useInstalledStore'
import { HubCard } from '@/components/PackageCard'
import HubDetail from '@/components/HubDetail'
import FilterPanel, { sectionActive } from '@/components/FilterPanel'
import { LICENSE_FILTER_OPTIONS, getHubResourceLicense } from '@/lib/licenses'
import { matchesSmartQuery, parseSmartQuery } from '@/lib/smart-search'
import { WISHLIST_IS_FLAGS, wishlistFlags } from '@/lib/search-text'
import { matchesPolarityList, matchesAuthorFilter, matchesLicenseFilter } from '@/lib/filter-match'
import { SearchOnHubButton } from '@/components/SearchOnHubButton'
import { ThumbnailSizeSlider } from '@/components/ThumbnailSizeSlider'
import { VirtualGrid } from '@/components/VirtualGrid'

/** Hub text search: avoid a network request on every keystroke */
const HUB_SEARCH_DEBOUNCE_MS = 320
/**
 * Medium HubCard footer height below the square thumb. Unlike LibraryCard, HubCard adds a
 * full-width action button row, so it's taller: author+stats block (~68px) + button row
 * (pt-2 8 + gradient button 32 + pb-3 12 = ~52px) ≈ 120px.
 */
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

/**
 * Tags on the stored snapshot mirror the hub detail `tags` field: a single
 * comma-separated string (same shape the library persists to `hub_tags`). Parse
 * to a lowercased list, matching the library's `packageMatchesSelectedTags`.
 */
function parseSnapshotTags(r) {
  if (!r.tags) return []
  return String(r.tags)
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** All wishlist filter dimensions, in a fixed key order for facet cross-filtering. */
const WISHLIST_FILTER_KEYS = ['search', 'type', 'tags', 'paid', 'author', 'license']

/**
 * Build one predicate per filter dimension bound to the current filter state.
 * Keeping them separate lets the gallery AND each facet reuse the same logic:
 * the gallery ANDs them all, while a facet's counts AND every dimension *except*
 * its own (standard cross-filtered faceting).
 */
function wishlistPredicates({ search, type, tags, paid, author, excludedAuthors, license }) {
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
function wishlistItemsExcept(items, preds, exclude) {
  const keys = WISHLIST_FILTER_KEYS.filter((k) => k !== exclude)
  return items.filter((r) => keys.every((k) => preds[k](r)))
}

/** Apply the full wishlist filter/sort state to the raw snapshot list. */
function filterAndSortWishlist(items, state) {
  const preds = wishlistPredicates(state)
  // `.filter` always returns a fresh array, so sorting never mutates the store's.
  const result = items.filter((r) => WISHLIST_FILTER_KEYS.every((k) => preds[k](r)))
  return result.sort(WISHLIST_SORT_FNS[state.sort] || WISHLIST_SORT_FNS.added)
}

export default function HubView({ onNavigate }) {
  const {
    resources,
    totalFound,
    totalPages,
    page,
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
    detailResource,
    detailData,
    detailNonce,
    detailHistory,
    cardMode,
    cardWidth,
    galleryMode,
    setGalleryMode,
    filterOptions,
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
    resetFilters,
    resetWishlistFilters,
    setCardMode,
    setCardWidth,
    fetchResources,
    fetchNextPage,
    openDetail,
    closeDetail,
  } = useHubStore()

  const wishlistMode = galleryMode === 'wishlist'
  const detailBackLabel = detailHistory.length > 0 ? detailHistory[detailHistory.length - 1].title : null

  // Back peels dep history; a view-root entry (arrived from Library/Content) closes
  // detail and returns to that tab. X / Hub-tab re-click still close to the Hub gallery.
  const handleDetailBack = useCallback(() => {
    const result = useHubStore.getState().popDetailHistory()
    if (result?.navigateTo) onNavigate?.(result.navigateTo)
  }, [onNavigate])

  const [searchDraft, setSearchDraft] = useState(search)
  const searchDraftRef = useRef(search)
  const searchDebounceRef = useRef(null)
  useEffect(() => {
    setSearchDraft(search)
    searchDraftRef.current = search
  }, [search])
  useEffect(
    () => () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    },
    [],
  )
  const handleSearchChange = useCallback(
    (value) => {
      setSearchDraft(value)
      searchDraftRef.current = value
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
      const trimmed = value.trim()
      if (trimmed === '') {
        setSearch('')
        return
      }
      searchDebounceRef.current = setTimeout(() => {
        searchDebounceRef.current = null
        // Ignore stale timers (clear clicked after timeout fired, or newer keystrokes).
        if (searchDraftRef.current !== value) return
        setSearch(trimmed)
      }, HUB_SEARCH_DEBOUNCE_MS)
    },
    [setSearch],
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

  const [availableWidth, setAvailableWidth] = useState(0)
  const [gridCols, setGridCols] = useState(1)
  const handleGridLayout = useCallback(({ availableWidth: w, cols }) => {
    setAvailableWidth(w)
    setGridCols(cols)
  }, [])

  // Wishlist filtering/sorting is client-side over the locally stored snapshots.
  const wishlistFiltered = useMemo(
    () =>
      filterAndSortWishlist(wishlistItems, {
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

  // While more hub pages exist, hide the trailing partial row so the gallery bottom is always
  // full rows — the ragged remainder fills in once the next chunk loads. `gridCols` comes from
  // VirtualGrid's onLayout (its actual column count), so the trim tracks resize/slider changes.
  const visibleResources = useMemo(() => {
    if (page >= totalPages) return resources
    const fullRowCount = Math.floor(resources.length / gridCols) * gridCols
    if (fullRowCount === 0) return resources
    return resources.slice(0, fullRowCount)
  }, [resources, page, totalPages, gridCols])

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

  const hubShowSkeleton = resources.length === 0 && (loading || !sort)

  const compactCards = cardMode === 'minimal'

  // Filter changes → reset to page 1 and fetch. Freshness-guarded so an <Activity>
  // reveal with unchanged filters is a no-op (doesn't wipe loaded pages).
  useEffect(() => {
    if (!sort) return // wait for sort options to load
    const s = useHubStore.getState()
    if (hubFilterSignature(s) === s.lastFetchedKey) return
    s.fetchResources(true)
  }, [search, selectedType, paidFilter, authorSearch, selectedHubTags, sort, license])

  // Page changes (without filter change) → fetch same filters, new page (append mode)
  const pageRef = useRef(page)
  useEffect(() => {
    if (pageRef.current === page) return
    pageRef.current = page
    // Filter resets already fetch page 1 themselves. Starting an append fetch here
    // would supersede that request without recording its filter key, leaving the
    // freshness guard able to mistake filtered resources for a neutral result.
    if (page === 1) return
    useHubStore.getState().fetchResources()
  }, [page])

  // When packages change (promote, download completes, uninstall), resync install status from DB.
  // The hub detail panel is refreshed at App level; here we only patch the
  // gallery's resource objects + the global installed-state store.
  useEffect(() => {
    return window.api.onPackagesUpdated(async () => {
      // Re-list the wishlist so its cards' installed/dep badges reconcile too
      // (wishlist items aren't part of hub `resources`, so the block below misses them).
      if (useWishlistStore.getState().loaded) useWishlistStore.getState().load()

      const { resources } = useHubStore.getState()
      if (resources.length === 0) return

      const ids = resources.map((r) => r.resource_id)
      let snapshot = {}
      try {
        snapshot = await window.api.hub.localSnapshot(ids)
      } catch {
        return
      }

      // Canonical update — this is what all components read from
      useInstalledStore.getState().applyBatch(
        ids.map((id) => {
          const local = snapshot[String(id)]
          return local
            ? { hubResourceId: id, installed: true, isDirect: local.is_direct, filename: local.filename }
            : { hubResourceId: id, installed: false, isDirect: false, filename: null }
        }),
      )

      // Also patch resource objects for backward compat (dep size calc, etc.)
      let changed = false
      const updated = resources.map((r) => {
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
          changed = true
        }
        return next
      })
      if (changed) useHubStore.setState({ resources: updated })
    })
  }, [])

  const dlInstall = useDownloadStore((s) => s.install)

  const handleInstall = useCallback(
    (resource, hubDetail) => {
      dlInstall(resource.resource_id, hubDetail).catch(() => {})
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
      if (useHubStore.getState().galleryMode === 'wishlist') setWlAuthor(author)
      else setAuthorSearch(author)
    },
    [setAuthorSearch, setWlAuthor],
  )

  const handlePromote = useCallback((filename, hubResourceId) => {
    window.api.packages.promote(filename, hubResourceId)
    const rid = String(hubResourceId)
    useInstalledStore.getState().update(rid, true, true, filename)
    useHubStore.setState((s) => ({
      resources: s.resources.map((r) => (String(r.resource_id) === rid ? { ...r, _isDirect: true } : r)),
      detailData:
        s.detailData && String(s.detailData.resource_id) === rid ? { ...s.detailData, _isDirect: true } : s.detailData,
    }))
  }, [])

  // --- Prev/Next navigation through the current gallery list ---
  // The currently shown package: detailData once loaded, else the opening stub.
  // The list stepped through is the filtered wishlist in wishlist mode, else hub
  // search. A ref mirrors the filtered list so the pager callbacks (which read
  // fresh state to dodge stale closures) can step through exactly what's shown.
  const detailList = wishlistMode ? wishlistFiltered : resources
  const wishlistViewRef = useRef(wishlistFiltered)
  wishlistViewRef.current = wishlistFiltered
  const currentDetailId = detailResource ? String(detailData?.resource_id ?? detailResource.resource_id ?? '') : ''
  const detailIdx = currentDetailId ? detailList.findIndex((r) => String(r.resource_id) === currentDetailId) : -1
  const canPrevDetail = detailIdx > 0
  const canNextDetail = wishlistMode
    ? detailIdx >= 0 && detailIdx < detailList.length - 1
    : detailIdx >= 0 && (detailIdx < resources.length - 1 || (page < totalPages && !loading))
  // null → pager hidden (neighbor unknown, or dep-drill history is active)
  const detailPosition =
    detailBackLabel || detailIdx < 0
      ? null
      : { n: detailIdx + 1, total: wishlistMode ? detailList.length : totalFound || resources.length }

  const handleDetailPrev = useCallback(() => {
    const { galleryMode, resources, detailResource, detailData } = useHubStore.getState()
    const list = galleryMode === 'wishlist' ? wishlistViewRef.current : resources
    const cur = detailResource ? String(detailData?.resource_id ?? detailResource.resource_id ?? '') : ''
    const idx = cur ? list.findIndex((r) => String(r.resource_id) === cur) : -1
    if (idx > 0) openDetail(list[idx - 1])
  }, [openDetail])

  // Enabled after the first Next within a panel-open session; gates neighbor detail
  // prefetch so users who never step through don't pay extra `hub:detail` requests.
  const detailPrefetchRef = useRef(false)
  useEffect(() => {
    if (!detailResource) detailPrefetchRef.current = false
  }, [detailResource])

  // When Next is pressed on the last loaded item, remember which item we advanced
  // from and load the next page; the effect below jumps once that page arrives.
  const pendingNextFromRef = useRef(null)
  const handleDetailNext = useCallback(() => {
    detailPrefetchRef.current = true
    const { galleryMode, resources, detailResource, detailData, page, totalPages } = useHubStore.getState()
    const cur = detailResource ? String(detailData?.resource_id ?? detailResource.resource_id ?? '') : ''
    if (galleryMode === 'wishlist') {
      const list = wishlistViewRef.current
      const idx = cur ? list.findIndex((r) => String(r.resource_id) === cur) : -1
      if (idx >= 0 && idx < list.length - 1) openDetail(list[idx + 1])
      return
    }
    const idx = cur ? resources.findIndex((r) => String(r.resource_id) === cur) : -1
    if (idx < 0) return
    if (idx < resources.length - 1) {
      openDetail(resources[idx + 1])
    } else if (page < totalPages) {
      pendingNextFromRef.current = cur
      fetchNextPage()
    }
  }, [openDetail, fetchNextPage])

  useEffect(() => {
    const fromId = pendingNextFromRef.current
    if (!fromId) return
    const idx = resources.findIndex((r) => String(r.resource_id) === fromId)
    if (idx >= 0 && idx < resources.length - 1) {
      pendingNextFromRef.current = null
      openDetail(resources[idx + 1])
    }
  }, [resources, openDetail])

  // Proactively load the next search page when the shown item nears the end of the
  // loaded list, so Next is rarely a dead wait.
  useEffect(() => {
    if (wishlistMode || detailIdx < 0 || loading) return
    if (detailIdx >= resources.length - 2 && page < totalPages) fetchNextPage()
  }, [wishlistMode, detailIdx, resources.length, page, totalPages, loading, fetchNextPage])

  // Once stepping through, warm the next item's detail into the main-process LRU
  // cache so the upcoming Next resolves without a network round-trip. The previous
  // item is already cached from having been viewed.
  useEffect(() => {
    if (wishlistMode || !detailPrefetchRef.current || detailIdx < 0) return
    const next = resources[detailIdx + 1]
    if (next?.resource_id) useHubStore.getState().prefetchDetail(next.resource_id)
  }, [wishlistMode, detailIdx, resources])

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
        value: authorSearch,
        default: HUB_FILTER_DEFAULTS.authorSearch,
        onChange: setAuthorSearch,
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
      authorSearch,
      license,
      sort,
      sortOptions,
      hubTypes,
      tagSuggestions,
      userSuggestions,
      setSelectedType,
      setPaidFilter,
      setSelectedHubTags,
      setAuthorSearch,
      setLicense,
      setSort,
    ],
  )

  // Wishlist facets. The displayed counts are proper cross-filtered facets: each
  // dimension counts items matching all the OTHER active filters, so they update
  // as filters toggle (standard filter-panel behaviour).
  const wishlistFacets = useMemo(() => {
    const preds = wishlistPredicates({
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
    const typeFacet = bucket(wishlistItemsExcept(wishlistItems, preds, 'type'), addType)

    const tagCounts = {}
    for (const r of wishlistItemsExcept(wishlistItems, preds, 'tags'))
      for (const t of parseSnapshotTags(r)) tagCounts[t] = (tagCounts[t] || 0) + 1

    const authorCounts = {}
    for (const r of wishlistItemsExcept(wishlistItems, preds, 'author'))
      if (r.username) authorCounts[r.username] = (authorCounts[r.username] || 0) + 1

    let free = 0
    let paid = 0
    for (const r of wishlistItemsExcept(wishlistItems, preds, 'paid')) {
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
    return { typeItems, paidItems, authorCounts, tagCounts }
  }, [wishlistItems, wlSearch, wlType, wlTags, wlPaid, wlAuthor, wlExcludedAuthors, wlLicense])

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
        suggestions: wishlistFacets.tagCounts,
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
        suggestions: wishlistFacets.authorCounts,
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
      setWlType,
      setWlTags,
      setWlPaid,
      setWlAuthor,
      setWlExcludedAuthors,
      setWlLicense,
      setWlSort,
    ],
  )

  const activeSections = wishlistMode ? wishlistSections : sections
  const activeFilterCount = activeSections.filter((s) => sectionActive(s) === true).length

  const refreshBusy = loading && resources.length === 0

  return (
    <div className="h-full flex min-w-0 relative">
      {/* Both modes use the same panel; hub filters drive the server query while
          wishlist filters run client-side over the local snapshots. */}
      <FilterPanel
        search={wishlistMode ? wlSearch : searchDraft}
        onSearchChange={wishlistMode ? setWlSearch : handleSearchChange}
        smartSearch={
          wishlistMode
            ? {
                authors: wishlistFacets.authorCounts,
                tags: wishlistFacets.tagCounts,
                labels: [],
                types: hubTypes,
                flags: WISHLIST_IS_FLAGS,
              }
            : null
        }
        sections={wishlistMode ? wishlistSections : sections}
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
              className={`px-2 py-1 rounded cursor-pointer transition-colors ${!wishlistMode ? 'bg-hover text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`}
            >
              Hub
            </button>
            <button
              type="button"
              onClick={() => {
                dismissTransientOverlays()
                setGalleryMode('wishlist')
              }}
              className={`px-2 py-1 rounded cursor-pointer transition-colors flex items-center gap-1 ${wishlistMode ? 'bg-hover text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`}
            >
              Wishlist
              {wishlistCount > 0 && <span className="tabular-nums opacity-70">{wishlistCount}</span>}
            </button>
          </div>
          <span className="text-[11px] text-text-tertiary">
            {wishlistMode
              ? wishlistLoading && !wishlistLoaded
                ? 'Loading…'
                : wishlistFiltered.length !== wishlistItems.length
                  ? `${wishlistFiltered.length.toLocaleString()} of ${wishlistItems.length.toLocaleString()} wishlisted`
                  : `${wishlistItems.length.toLocaleString()} wishlisted`
              : loading && resources.length === 0
                ? 'Searching…'
                : `${totalFound.toLocaleString()} packages`}
          </span>
          {activeFilterCount > 0 && (
            <span className="shrink-0 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-text-tertiary">
              <span aria-hidden="true">·</span>
              <span>
                {activeFilterCount} {activeFilterCount === 1 ? 'filter' : 'filters'}
              </span>
              <span>
                (
                <button
                  type="button"
                  onClick={() => (wishlistMode ? resetWishlistFilters() : resetFilters())}
                  title="Reset all filters to their defaults"
                  className="text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
                >
                  Reset
                </button>
                )
              </span>
            </span>
          )}
          {/* Network-backed hub search gets a cache-busting refresh; the wishlist
              is local + live, so it needs none. */}
          {!wishlistMode && (
            <button
              type="button"
              onClick={() => fetchResources(true, { forceRefresh: true })}
              disabled={refreshBusy}
              title="Refresh"
              className="p-1 rounded text-text-tertiary hover:text-text-secondary disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <RefreshCw size={13} className={refreshBusy ? 'animate-spin' : ''} />
            </button>
          )}
          <div className="flex-1" />
          <ThumbnailSizeSlider cardWidth={cardWidth} availableWidth={availableWidth} onCardWidthChange={setCardWidth} />
          <div className="flex items-center gap-px bg-elevated rounded p-0.5">
            <button
              type="button"
              onClick={() => setCardMode('minimal')}
              title="Small cards"
              className={`p-1.5 rounded cursor-pointer ${cardMode === 'minimal' ? 'bg-hover text-text-primary' : 'text-text-tertiary'}`}
            >
              <Grid3x3 size={14} />
            </button>
            <button
              type="button"
              onClick={() => setCardMode('medium')}
              title="Large cards"
              className={`p-1.5 rounded cursor-pointer ${cardMode === 'medium' ? 'bg-hover text-text-primary' : 'text-text-tertiary'}`}
            >
              <Grid2x2 size={14} />
            </button>
          </div>
        </div>

        {/* Gallery — cards + wishlist are two <Activity>-kept scroll surfaces, so
            toggling modes preserves each one's scroll and DOM. */}
        <div className="relative flex-1 min-h-0 flex flex-col min-w-0">
          <Activity mode={wishlistMode ? 'hidden' : 'visible'}>
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
                    items={visibleResources}
                    itemWidth={cardWidth}
                    itemHeight={compactCards ? cardWidth : cardWidth + HUB_CARD_FOOTER_PX}
                    fixedHeight={compactCards ? 0 : HUB_CARD_FOOTER_PX}
                    className="flex-1"
                    scrollResetKey={hubScrollResetKey}
                    onLayout={handleGridLayout}
                    hideEmptyMessage
                    onEndReached={page < totalPages ? fetchNextPage : undefined}
                    footer={
                      loading && resources.length > 0 ? (
                        <div className="flex items-center justify-center -mt-3 pb-4">
                          <Loader2 size={20} className="animate-spin text-accent-blue" />
                          <span className="text-[11px] text-text-tertiary ml-2">Loading more…</span>
                        </div>
                      ) : null
                    }
                    renderItem={(r) => (
                      <HubCard
                        key={r.resource_id}
                        resource={r}
                        onClick={openDetail}
                        onViewInLibrary={handleViewInLibrary}
                        onInstall={handleInstall}
                        onPromote={handlePromote}
                        onFilterAuthor={handleFilterAuthor}
                        mode={cardMode}
                        hideType={selectedType !== 'All'}
                      />
                    )}
                  />
                  {!loading && sort && resources.length === 0 && (
                    <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-16 text-text-tertiary text-sm">
                      No packages found
                    </div>
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
                    onPromote={handlePromote}
                    onFilterAuthor={handleFilterAuthor}
                    mode={cardMode}
                    hideType={wlType !== 'All'}
                    wishlist
                  />
                )}
              />
              {wishlistLoaded && wishlistItems.length === 0 && (
                <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-16">
                  <div className="max-w-sm text-center text-text-tertiary text-sm flex flex-col items-center gap-2">
                    <Pin size={28} className="opacity-40" />
                    <p>Your wishlist is empty.</p>
                    <p className="text-[12px] text-text-tertiary/80">
                      Open a package and tap the <Pin size={12} className="inline align-[-1px]" /> button in its details
                      to add it here.
                    </p>
                  </div>
                </div>
              )}
              {wishlistItems.length > 0 && wishlistFiltered.length === 0 && (
                <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-16 text-text-tertiary text-sm">
                  No wishlisted packages match your filters
                </div>
              )}
            </div>
          </Activity>
        </div>
      </div>
      {detailResource && (
        <HubDetail
          key={detailNonce}
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

// --- Skeleton card for gallery loading ---

function SkeletonCard({ mode = 'medium' }) {
  const minimal = mode === 'minimal'
  return (
    <div className="w-full min-w-0 bg-surface border border-border rounded-lg overflow-hidden flex flex-col">
      <div className="relative aspect-square skeleton" />
      {!minimal && (
        <div className="p-3">
          <div className="flex items-center gap-2">
            <div className="w-[30px] h-[30px] rounded-sm skeleton shrink-0" />
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="h-3.5 skeleton rounded w-3/4" />
              <div className="h-2.5 skeleton rounded w-1/2" />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-3">
            <div className="h-2.5 skeleton rounded w-10" />
            <div className="h-2.5 skeleton rounded w-10" />
            <div className="h-2.5 skeleton rounded w-8" />
          </div>
          <div className="h-[30px] skeleton rounded w-full mt-3" />
        </div>
      )}
    </div>
  )
}
