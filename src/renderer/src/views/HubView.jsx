import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Globe,
  ChevronLeft,
  ChevronRight,
  Download,
  Heart,
  Bookmark,
  Star,
  ThumbsUp,
  ExternalLink,
  Bug,
  Copy,
  Check,
  Library as LibraryIcon,
  Grid2x2,
  Grid3x3,
  Calendar,
  Clock,
  Plus,
  Loader2,
  RefreshCw,
  Pin,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  TYPE_COLORS,
  HUB_CATEGORY_COLORS,
  CONTENT_TYPES,
  compareContentTypes,
  getTypeColor,
  formatNumber,
  formatStarRating,
  formatBytes,
  formatDate,
  getGradient,
  extractDomainLabel,
  isPromotionalLink,
  openExternalLink,
} from '@/lib/utils'
import { useHubStore } from '@/stores/useHubStore'
import { useWishlistStore } from '@/stores/useWishlistStore'
import { useDownloadStore } from '@/stores/useDownloadStore'
import { useInstalledStore } from '@/stores/useInstalledStore'
import { useHubInstallState } from '@/hooks/useHubInstallState'
import { useHubInteractions } from '@/hooks/useHubInteractions'
import { HubCard, AuthorAvatar, DepRow } from '@/components/PackageCard'
import FilterPanel from '@/components/FilterPanel'
import ResizeHandle from '@/components/ResizeHandle'
import { usePersistedPanelWidth } from '@/hooks/usePersistedPanelWidth'
import { useIsDev } from '@/hooks/useIsDev'
import {
  LICENSE_FILTER_OPTIONS,
  COMMERCIAL_USE_ALLOWED_LICENSE_FILTER,
  NONCOMMERCIAL_USE_ALLOWED_LICENSE_FILTER,
  getHubResourceLicense,
  canonicalizeLicense,
  isCommercialUseAllowed,
  isNonCommercialUseAllowed,
} from '@/lib/licenses'
import { searchAndTerms, haystacksMatchAllTerms } from '@shared/search-text.js'
import { LicenseTag } from '@/components/LicenseTag'
import { Tag } from '@/components/ui/tag'
import { SearchOnHubButton } from '@/components/SearchOnHubButton'
import { ThumbnailSizeSlider } from '@/components/ThumbnailSizeSlider'
import { ScrollToTopButton } from '@/components/ScrollToTopButton'

/** Hub text search: avoid a network request on every keystroke */
const HUB_SEARCH_DEBOUNCE_MS = 320
/** Must match `gap-3` on the hub gallery grid (`0.75rem` = 12px) */
const HUB_GALLERY_GRID_GAP_PX = 12
/** IntersectionObserver rootMargin (bottom): load next page before user reaches the list end */
const HUB_LOAD_MORE_MARGIN_BOTTOM_PX = 1600

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

function wishlistMatchesLicense(r, license) {
  if (license === 'Any') return true
  const lic = getHubResourceLicense(r)
  if (license === COMMERCIAL_USE_ALLOWED_LICENSE_FILTER) return isCommercialUseAllowed(lic) === true
  if (license === NONCOMMERCIAL_USE_ALLOWED_LICENSE_FILTER) return isNonCommercialUseAllowed(lic) === true
  return canonicalizeLicense(lic) === canonicalizeLicense(license)
}

/** All wishlist filter dimensions, in a fixed key order for facet cross-filtering. */
const WISHLIST_FILTER_KEYS = ['search', 'type', 'tags', 'paid', 'author', 'license']

/**
 * Build one predicate per filter dimension bound to the current filter state.
 * Keeping them separate lets the gallery AND each facet reuse the same logic:
 * the gallery ANDs them all, while a facet's counts AND every dimension *except*
 * its own (standard cross-filtered faceting).
 */
function wishlistPredicates({ search, type, tags, paid, author, license }) {
  const terms = searchAndTerms(search)
  const wantTags = (tags || []).map((t) => t.toLowerCase())
  const aq = author ? author.toLowerCase() : ''
  return {
    search: (r) => !terms.length || haystacksMatchAllTerms([r.title, r.username, r.tag_line], terms),
    type: (r) => type === 'All' || r.type === type,
    tags: (r) => {
      if (!wantTags.length) return true
      const rt = parseSnapshotTags(r)
      return wantTags.every((t) => rt.includes(t))
    },
    paid: (r) => paid === 'all' || (paid === 'free' ? r.category === 'Free' : r.category === 'Paid'),
    author: (r) => !aq || (r.username || '').toLowerCase().includes(aq),
    license: (r) => wishlistMatchesLicense(r, license),
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

const HUB_INTERACTIONS_ENABLED = true

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
    wlLicense,
    wlSort,
    detailResource,
    detailData,
    detailNonce,
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
    setWlLicense,
    setWlSort,
    setCardMode,
    setCardWidth,
    fetchResources,
    fetchNextPage,
    openDetail,
    closeDetail,
  } = useHubStore()

  const wishlistMode = galleryMode === 'wishlist'

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
  // Main fires `wishlist:updated` on background snapshot/unavailability changes;
  // re-list so the gallery stays live without a manual refresh.
  useEffect(() => {
    return window.api.onWishlistUpdated(() => {
      if (useWishlistStore.getState().loaded) useWishlistStore.getState().load()
    })
  }, [])

  // Track gallery container width for the zoom slider
  const galleryRef = useRef(null)
  const [availableWidth, setAvailableWidth] = useState(0)
  useEffect(() => {
    const el = galleryRef.current
    if (!el) return
    const measure = () => setAvailableWidth(el.clientWidth - 32) // 16px padding each side
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** Mirror `repeat(auto-fill,minmax(min(cardWidth,100%),1fr))`: count how many columns fit. */
  const columnCount = useMemo(() => {
    if (!availableWidth || !cardWidth) return 1
    const effectiveCardWidth = Math.min(cardWidth, availableWidth)
    return Math.max(
      1,
      Math.floor((availableWidth + HUB_GALLERY_GRID_GAP_PX) / (effectiveCardWidth + HUB_GALLERY_GRID_GAP_PX)),
    )
  }, [availableWidth, cardWidth])

  /** While more pages exist, hide the trailing partial row so the bottom is always full rows */
  const visibleResources = useMemo(() => {
    if (page >= totalPages) return resources
    const fullRowCount = Math.floor(resources.length / columnCount) * columnCount
    if (fullRowCount === 0) return resources
    return resources.slice(0, fullRowCount)
  }, [resources, page, totalPages, columnCount])

  // Wishlist filtering/sorting is client-side over the locally stored snapshots.
  const wishlistFiltered = useMemo(
    () =>
      filterAndSortWishlist(wishlistItems, {
        search: wlSearch,
        type: wlType,
        tags: wlTags,
        paid: wlPaid,
        author: wlAuthor,
        license: wlLicense,
        sort: wlSort,
      }),
    [wishlistItems, wlSearch, wlType, wlTags, wlPaid, wlAuthor, wlLicense, wlSort],
  )

  // Gallery data source: wishlist mode reads the filtered local snapshots; hub
  // mode reads the paged search results.
  const galleryItems = wishlistMode ? wishlistFiltered : visibleResources

  // Filter changes → reset to page 1 and fetch
  useEffect(() => {
    if (!sort) return // wait for sort options to load
    useHubStore.getState().fetchResources(true)
  }, [search, selectedType, paidFilter, authorSearch, selectedHubTags, sort, license])

  // Page changes (without filter change) → fetch same filters, new page (append mode)
  const pageRef = useRef(page)
  useEffect(() => {
    if (pageRef.current === page) return
    pageRef.current = page
    useHubStore.getState().fetchResources()
  }, [page])

  // Intersection observer sentinel for infinite scroll (root = gallery scroller so rootMargin
  // prefetches below the fold; viewport root + overflow-y ancestor clips the target until late).
  const sentinelRef = useRef(null)
  useEffect(() => {
    const root = galleryRef.current
    const el = sentinelRef.current
    if (!root || !el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) fetchNextPage()
      },
      { root, rootMargin: `0px 0px ${HUB_LOAD_MORE_MARGIN_BOTTOM_PX}px 0px` },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [fetchNextPage, resources.length])

  // The observer only fires on intersection *changes*, so when the sentinel stays visible across
  // a page load (common with cached pages) nothing re-triggers it. After each page settles, probe
  // whether the sentinel is still in the prefetch zone and keep loading if so.
  useEffect(() => {
    if (loading || page >= totalPages) return
    const root = galleryRef.current
    const el = sentinelRef.current
    if (!root || !el) return
    const rootRect = root.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    if (elRect.top < rootRect.bottom + HUB_LOAD_MORE_MARGIN_BOTTOM_PX && elRect.bottom > rootRect.top) {
      fetchNextPage()
    }
  }, [loading, page, totalPages, resources.length, fetchNextPage])

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
  // null → pager hidden (neighbor unknown)
  const detailPosition =
    detailIdx >= 0
      ? { n: detailIdx + 1, total: wishlistMode ? detailList.length : totalFound || resources.length }
      : null

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
        onChange: setSelectedHubTags,
        suggestions: tagSuggestions,
        placeholder: 'Filter by tags…',
      },
      {
        key: 'author',
        label: 'Author',
        type: 'text-autocomplete',
        value: authorSearch,
        onChange: setAuthorSearch,
        suggestions: userSuggestions,
        placeholder: 'Filter by author…',
      },
      {
        key: 'license',
        label: 'License',
        type: 'select',
        value: license,
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
  }, [wishlistItems, wlSearch, wlType, wlTags, wlPaid, wlAuthor, wlLicense])

  const wishlistSections = useMemo(
    () => [
      {
        key: 'wl-type',
        label: 'Type',
        type: 'list',
        value: wlType,
        onChange: setWlType,
        items: wishlistFacets.typeItems,
      },
      {
        key: 'wl-paid',
        label: 'Pricing',
        type: 'list',
        value: wlPaid,
        onChange: setWlPaid,
        items: wishlistFacets.paidItems,
      },
      {
        key: 'wl-tags',
        label: 'Tags',
        type: 'tags-autocomplete',
        value: wlTags,
        onChange: setWlTags,
        suggestions: wishlistFacets.tagCounts,
        placeholder: 'Filter by tags…',
      },
      {
        key: 'wl-author',
        label: 'Author',
        type: 'text-autocomplete',
        value: wlAuthor,
        onChange: setWlAuthor,
        suggestions: wishlistFacets.authorCounts,
        placeholder: 'Filter by author…',
        titleAction: wlAuthor ? <SearchOnHubButton author={wlAuthor} /> : null,
      },
      {
        key: 'wl-license',
        label: 'License',
        type: 'select',
        value: wlLicense,
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
      wlLicense,
      wlSort,
      wishlistFacets,
      setWlType,
      setWlTags,
      setWlPaid,
      setWlAuthor,
      setWlLicense,
      setWlSort,
    ],
  )

  const refreshBusy = loading && resources.length === 0

  return (
    <div className="h-full flex min-w-0 relative">
      {/* Both modes use the same panel; hub filters drive the server query while
          wishlist filters run client-side over the local snapshots. */}
      <FilterPanel
        search={wishlistMode ? wlSearch : searchDraft}
        onSearchChange={wishlistMode ? setWlSearch : handleSearchChange}
        sections={wishlistMode ? wishlistSections : sections}
      />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Toolbar */}
        <div className="h-10 flex items-center px-4 border-b border-border shrink-0 gap-2">
          <div className="flex items-center gap-px bg-elevated rounded p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setGalleryMode('hub')}
              className={`px-2 py-1 rounded cursor-pointer transition-colors ${!wishlistMode ? 'bg-hover text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`}
            >
              Hub
            </button>
            <button
              type="button"
              onClick={() => setGalleryMode('wishlist')}
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

        {/* Gallery */}
        <div className="relative flex-1 min-h-0">
          <div ref={galleryRef} className="absolute inset-0 overflow-y-auto p-4">
            {!wishlistMode && error && (
              <div className="mb-4 px-4 py-3 rounded-lg bg-error/10 border border-error/20 text-error text-xs select-text cursor-text">
                {error}
              </div>
            )}
            {(
              wishlistMode
                ? wishlistItems.length === 0 && wishlistLoading && !wishlistLoaded
                : resources.length === 0 && (loading || !sort)
            ) ? (
              <div
                className="grid gap-3 content-start"
                style={{ gridTemplateColumns: `repeat(auto-fill,minmax(min(${cardWidth}px,100%),1fr))` }}
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <SkeletonCard key={i} mode={cardMode} />
                ))}
              </div>
            ) : (
              <>
                <div
                  className="grid gap-3 content-start"
                  style={{ gridTemplateColumns: `repeat(auto-fill,minmax(min(${cardWidth}px,100%),1fr))` }}
                >
                  {galleryItems.map((r) => (
                    <HubCard
                      key={r.resource_id}
                      resource={r}
                      onClick={openDetail}
                      onViewInLibrary={handleViewInLibrary}
                      onInstall={handleInstall}
                      onPromote={handlePromote}
                      onFilterAuthor={handleFilterAuthor}
                      mode={cardMode}
                      hideType={wishlistMode ? wlType !== 'All' : selectedType !== 'All'}
                      wishlist={wishlistMode}
                    />
                  ))}
                </div>
                {/* Infinite scroll sentinel (hub search only — the wishlist loads all rows at once) */}
                {!wishlistMode && page < totalPages && <div ref={sentinelRef} className="h-1" />}
                {!wishlistMode && loading && resources.length > 0 && (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 size={20} className="animate-spin text-accent-blue" />
                    <span className="text-[11px] text-text-tertiary ml-2">Loading more…</span>
                  </div>
                )}
                {!wishlistMode && !loading && sort && resources.length === 0 && (
                  <div className="text-center py-16 text-text-tertiary text-sm">No packages found</div>
                )}
                {wishlistMode && wishlistLoaded && wishlistItems.length === 0 && (
                  <div className="max-w-sm mx-auto text-center py-16 text-text-tertiary text-sm flex flex-col items-center gap-2">
                    <Pin size={28} className="opacity-40" />
                    <p>Your wishlist is empty.</p>
                    <p className="text-[12px] text-text-tertiary/80">
                      Open a package and tap the <Pin size={12} className="inline align-[-1px]" /> button in its details
                      to add it here.
                    </p>
                  </div>
                )}
                {wishlistMode && wishlistItems.length > 0 && wishlistFiltered.length === 0 && (
                  <div className="text-center py-16 text-text-tertiary text-sm">
                    No wishlisted packages match your filters
                  </div>
                )}
              </>
            )}
          </div>
          <ScrollToTopButton scrollRef={galleryRef} />
        </div>
      </div>
      {detailResource && (
        <HubDetail
          key={detailNonce}
          resource={detailResource}
          onBack={closeDetail}
          onNavigate={onNavigate}
          onInstall={handleInstall}
          onFilterAuthor={handleFilterAuthor}
          onPrev={handleDetailPrev}
          onNext={handleDetailNext}
          canPrev={canPrevDetail}
          canNext={canNextDetail}
          position={detailPosition}
        />
      )}
    </div>
  )
}

function normalizeHubUrlForTabMatch(urlString) {
  try {
    const u = new URL(urlString)
    const path = u.pathname.replace(/\/+$/, '') || '/'
    return `${u.origin}${path}`
  } catch {
    return ''
  }
}

/** First visible tab whose panel URL matches navigated URL (origin + path; ignores hash and query). */
function browserTabMatchingUrl(navUrl, tabUrls, tabs) {
  const nav = normalizeHubUrlForTabMatch(navUrl)
  if (!nav) return null
  for (const { key } of tabs) {
    const panelUrl = tabUrls[key]
    if (panelUrl && normalizeHubUrlForTabMatch(panelUrl) === nav) return key
  }
  return null
}

/**
 * Extract the numeric resource id from a Hub resource URL, or null for any
 * non-resource page (threads, member profiles, search, etc.). Handles both the
 * numeric `*-panel` forms we build and the slug form the Hub redirects to
 * (e.g. /resources/my-package.66186/overview-panel -> "66186").
 */
function parseHubResourceId(urlString) {
  try {
    const u = new URL(urlString)
    if (u.hostname !== 'hub.virtamate.com') return null
    const m = u.pathname.match(/^\/resources\/(?:[^/]*\.)?(\d+)(?:\/|$)/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// --- Hub interaction stats (rating / like / favorite / bookmark) ---

const HUB_SIGNED_OUT_HINT = 'Sign in on the Hub browser (right) to use this.'
// Short, non-native delay so signed-out discovery hints surface quickly (native
// `title` tooltips lag ~1s, which is too slow to guide first-time users here).
const HUB_STAT_TOOLTIP_DELAY = 200
// Signed in, discovery is done and the neighbouring stats have no tooltip, so a
// snappy rating tooltip just nags — slow it toward native-title speed.
const HUB_STAT_TOOLTIP_DELAY_RELAXED = 700

/** A stat wrapped in a non-native tooltip. Used for rating info + signed-out discovery. */
function StatTooltip({ content, side = 'top', delay = HUB_STAT_TOOLTIP_DELAY, children }) {
  return (
    <Tooltip delayDuration={delay}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="block max-w-52 text-left leading-snug">
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

/** Signed-out discovery hint: what the button does, plus how to enable it. */
function DiscoveryHint({ label }) {
  return (
    <>
      <span className="font-medium">{label}</span>
      <span className="block text-text-tertiary mt-0.5">{HUB_SIGNED_OUT_HINT}</span>
    </>
  )
}

/**
 * Star = the Hub *rating* (its thumbs up/down `/like/` action). The face shows the
 * 1–5★ review average; the tooltip reports the review count and the resource's
 * "like" count (two independent Hub metrics). Signed in, clicking casts a positive
 * "like" rating — the Hub's name for a thumbs-up.
 */
function RatingStat({ ratingAvg, ratingWeighted, ratingCount, loggedIn, rated, ratedDown, busy, onRate }) {
  const countLine = ratingCount === 1 ? '1 rating' : `${formatNumber(ratingCount)} ratings`
  const tip = (
    <>
      <span className="font-medium">{ratingCount > 0 ? countLine : 'Not yet rated'}</span>
      {ratingCount > 0 && (
        <>
          <span className="block font-medium">{formatStarRating(ratingAvg)} average</span>
          <span className="block font-medium">{formatStarRating(ratingWeighted)} weighted</span>
        </>
      )}
      <span className="block text-text-tertiary mt-0.5">
        {loggedIn ? (rated ? 'Click to remove your like' : 'Click to like (a positive rating)') : HUB_SIGNED_OUT_HINT}
      </span>
    </>
  )
  const face = (
    <>
      <Star size={13} className={rated ? 'fill-current' : ''} />
      <span className={`font-medium ${rated ? 'text-warning' : ratedDown ? 'text-error' : 'text-text-primary'}`}>
        {formatStarRating(ratingAvg)}
      </span>
    </>
  )
  return (
    <StatTooltip content={tip} delay={loggedIn ? HUB_STAT_TOOLTIP_DELAY_RELAXED : HUB_STAT_TOOLTIP_DELAY}>
      {loggedIn ? (
        <button
          type="button"
          onClick={onRate}
          disabled={busy}
          className={`flex items-center gap-1.5 transition-colors disabled:cursor-default cursor-pointer ${
            rated ? 'text-warning' : ratedDown ? 'text-error' : 'text-text-tertiary hover:text-warning'
          }`}
        >
          {face}
        </button>
      ) : (
        <span className="flex items-center gap-1.5 text-text-tertiary cursor-pointer">{face}</span>
      )}
    </StatTooltip>
  )
}

/** Thumbs up = the emoji "Like" reaction (reaction id 1); `count` is the live reaction score. */
function LikeStat({ count, loggedIn, liked, busy, onLike }) {
  const face = (
    <>
      <ThumbsUp size={13} className={liked ? 'fill-current' : ''} />
      <span className={`font-medium ${liked ? 'text-accent-blue' : 'text-text-primary'}`}>{formatNumber(count)}</span>
    </>
  )
  if (loggedIn) {
    return (
      <button
        type="button"
        onClick={onLike}
        disabled={busy}
        title={liked ? 'Remove like' : 'Like'}
        className={`flex items-center gap-1.5 transition-colors disabled:cursor-default cursor-pointer ${
          liked ? 'text-accent-blue' : 'text-text-tertiary hover:text-accent-blue'
        }`}
      >
        {face}
      </button>
    )
  }
  return (
    <StatTooltip content={<DiscoveryHint label="Like" />}>
      <span className="flex items-center gap-1.5 text-text-tertiary cursor-pointer">{face}</span>
    </StatTooltip>
  )
}

// Favorite/bookmark carry no signed-out value (bare icon, no count fetched), so
// they only render when signed in; Rating + Like already surface the sign-in hint.
function FavoriteStat({ loggedIn, favorited, favoriteCount, busy, onFavorite }) {
  if (!loggedIn) return null
  return (
    <button
      type="button"
      onClick={onFavorite}
      disabled={busy}
      title={favorited ? 'Remove favorite' : 'Add to favorites'}
      className="flex items-center gap-1.5 text-text-tertiary transition-colors hover:text-accent-pink disabled:hover:text-text-tertiary disabled:cursor-default cursor-pointer"
    >
      <Heart size={13} className={favorited ? 'fill-current text-accent-pink' : ''} />
      {favoriteCount == null ? (
        <span className="h-3 w-4 skeleton rounded" />
      ) : (
        <span className={`font-medium ${favorited ? 'text-accent-pink' : 'text-text-primary'}`}>
          {formatNumber(favoriteCount)}
        </span>
      )}
    </button>
  )
}

function BookmarkStat({ loggedIn, bookmarked, busy, onBookmark }) {
  if (!loggedIn) return null
  return (
    <button
      type="button"
      onClick={onBookmark}
      disabled={busy}
      title={bookmarked ? 'Remove bookmark' : 'Bookmark'}
      className="flex items-center text-text-tertiary transition-colors hover:text-accent-blue disabled:opacity-50 cursor-pointer"
    >
      <Bookmark size={14} className={bookmarked ? 'fill-current text-accent-blue' : ''} />
    </button>
  )
}

// --- Hub Detail ---

function HubDetail({
  resource,
  onBack,
  onNavigate,
  onInstall,
  onFilterAuthor,
  onPrev,
  onNext,
  canPrev,
  canNext,
  position,
}) {
  const { detailData, detailLoading } = useHubStore()
  const detail = detailData
  const [browserTab, setBrowserTab] = useState('overview')
  const webviewRef = useRef(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)

  const resourceId = detail?.resource_id || resource.resource_id
  const threadId = detail?.discussion_thread_id

  // The webview key is pinned to the resource the panel was opened with. Following
  // in-browser navigation swaps `resourceId` (above) to drive the left panel, but
  // the guest must never remount/reload — the user is already on the page they
  // navigated to. Captured once per mount; fresh gallery opens remount HubDetail.
  const [browserResourceId] = useState(() => String(resource.resource_id))

  const {
    loggedIn: hubLoggedIn,
    favorited,
    favoriteCount,
    bookmarked,
    rated,
    ratedDown,
    liked,
    likeDelta,
    serverReactionScore,
    loading: interactionsLoading,
    toggleFavorite,
    toggleBookmark,
    toggleRate,
    toggleLike,
  } = useHubInteractions(resourceId, { enabled: HUB_INTERACTIONS_ENABLED })

  const tabUrls = useMemo(
    () => ({
      overview: `https://hub.virtamate.com/resources/${resourceId}/overview-panel`,
      reviews: `https://hub.virtamate.com/resources/${resourceId}/review-panel`,
      history: `https://hub.virtamate.com/resources/${resourceId}/history-panel`,
      updates: `https://hub.virtamate.com/resources/${resourceId}/updates-panel`,
      discussion: threadId
        ? `https://hub.virtamate.com/threads/${threadId}/discussion-panel`
        : `https://hub.virtamate.com/resources/${resourceId}/`,
    }),
    [resourceId, threadId],
  )

  const pkg = detail || resource
  const tabs = useMemo(() => {
    const reviewCount = parseInt(pkg.review_count || '0', 10)
    const ratingCount = parseInt(pkg.rating_count || '0', 10)
    const updateCount = parseInt(pkg.update_count || '0', 10)
    const t = [{ key: 'overview', label: 'Overview' }]
    if (updateCount > 0) t.push({ key: 'updates', label: `Updates (${updateCount})` })
    if (reviewCount > 0 || ratingCount > 0) t.push({ key: 'reviews', label: `Reviews (${reviewCount || ratingCount})` })
    t.push({ key: 'history', label: 'History' })
    t.push({ key: 'discussion', label: 'Discussion' })
    return t
  }, [pkg.review_count, pkg.rating_count, pkg.update_count])

  // URL committed to the webview. Only changes on explicit tab clicks (and at
  // mount), never as a side effect of `resourceId` changing — otherwise following
  // in-browser navigation would yank the guest back to a *-panel fragment.
  const [navUrl, setNavUrl] = useState(() => tabUrls[browserTab] || tabUrls.overview)
  // Display URL for the address bar — tracks in-page navigation independently.
  const [displayUrl, setDisplayUrl] = useState(navUrl)

  // Editable address bar: `addressDraft` mirrors `displayUrl` unless the user is
  // actively typing, so live navigation keeps the field current without clobbering edits.
  const addressInputRef = useRef(null)
  const [addressFocused, setAddressFocused] = useState(false)
  const [addressDraft, setAddressDraft] = useState(displayUrl)
  useEffect(() => {
    if (!addressFocused) setAddressDraft(displayUrl)
  }, [displayUrl, addressFocused])

  const navigateToAddress = useCallback(() => {
    const raw = addressDraft.trim()
    if (!raw) return
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
    try {
      webviewRef.current?.loadURL(url)
    } catch {
      // ignore malformed URL — the webview will surface a load error if reached
    }
    // Optimistically show the target so blur doesn't briefly restore the old URL
    // before `did-navigate` fires with the real one.
    setDisplayUrl(url)
    addressInputRef.current?.blur()
  }, [addressDraft])

  const selectTab = useCallback(
    (key) => {
      setBrowserTab(key)
      const url = tabUrls[key] || tabUrls.overview
      setNavUrl(url)
      setDisplayUrl(url)
    },
    [tabUrls],
  )

  // Left/Right arrow keys step through results when the pager is active. Ignored
  // while typing in a field, with modifiers, or when focus is inside the webview
  // (guest keystrokes don't reach the host document anyway).
  const hasPager = !!position
  useEffect(() => {
    if (!hasPager) return
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))
        return
      if (e.key === 'ArrowLeft' && canPrev) {
        e.preventDefault()
        onPrev?.()
      } else if (e.key === 'ArrowRight' && canNext) {
        e.preventDefault()
        onNext?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasPager, canPrev, canNext, onPrev, onNext])

  // When navigation swaps the displayed resource, reset the panel's tab highlight
  // to Overview (highlight only — `setBrowserTab` no longer drives the webview).
  const prevResourceIdRef = useRef(resourceId)
  useEffect(() => {
    if (prevResourceIdRef.current !== resourceId) {
      prevResourceIdRef.current = resourceId
      setBrowserTab('overview')
    }
  }, [resourceId])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const syncNav = (e) => {
      setDisplayUrl(e.url)
      setCanGoBack(wv.canGoBack())
      setCanGoForward(wv.canGoForward())
      const tabKey = browserTabMatchingUrl(e.url, tabUrls, tabs)
      if (tabKey) setBrowserTab(tabKey)
      // Follow in-browser navigation: when the guest lands on a different
      // resource, load it into the details panel in the background and swap once
      // ready, so the previous resource stays visible (no skeleton flash). Skip
      // when the target is already shown or already being fetched — this also
      // covers tab/in-page navigation within the current resource.
      const navId = parseHubResourceId(e.url)
      if (navId) {
        const store = useHubStore.getState()
        const shown = String(store.detailData?.resource_id ?? store.detailResource?.resource_id ?? '')
        if (navId !== shown) {
          // Reuse the gallery row as the stub when the target is already in the
          // results; otherwise a bare id, filled by hub:detail. followDetail
          // self-dedupes concurrent calls for the same in-flight resource.
          const known = store.resources?.find((r) => String(r.resource_id) === navId)
          store.followDetail(known || { resource_id: navId })
        }
      }
    }
    const ignoreAbort = (e) => {
      if (e.errorCode === -3 || e.errorCode === -2) e.preventDefault()
    }
    const onStartLoading = () => setIsLoading(true)
    const onStopLoading = () => setIsLoading(false)

    // Inject a click-interceptor into the guest page so that:
    //  • External links (non-hub origin) open in the user's default browser via shell.openExternal.
    //    Caught in capture phase + stopImmediatePropagation, otherwise XenForo's own external-link
    //    confirmation handler claims them first and our handler never runs.
    //  • Same-origin links with target="_blank" / target="_top" navigate the webview itself instead
    //    of spawning a popup. Caught in bubble phase + bails on defaultPrevented so XenForo's
    //    lightbox controllers (also bubble-phase) can claim image-gallery clicks first.
    //
    // The guest signals the host using console.warn with a magic prefix; window.open is
    // unreliable inside XenForo's wrapped popup machinery.
    const injectLinkHandler = () => {
      wv.executeJavaScript(
        `(function() {
        if (window.__hubNavPatched) return
        window.__hubNavPatched = true
        var hubOrigin = location.origin
        var EXT_TAG = '__VAM_OPEN_EXT__:'
        var openExternal = function(url) { console.warn(EXT_TAG + url) }

        // Capture phase — external links: claim the click before XenForo's link-confirm handler.
        document.addEventListener('click', function(e) {
          if (e.button !== 0) return
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          var a = e.target.closest('a[href]')
          if (!a) return
          var href = a.getAttribute('href')
          if (!href || href.charAt(0) === '#' || href.startsWith('javascript:')) return
          try {
            var url = new URL(href, location.href)
            if (url.origin !== hubOrigin) {
              e.preventDefault()
              e.stopImmediatePropagation()
              openExternal(url.href)
            }
          } catch(err) {}
        }, true)

        // Bubble phase — same-origin target=_blank: route to webview after page JS (lightbox, etc.) had a chance.
        document.addEventListener('click', function(e) {
          if (e.defaultPrevented) return
          if (e.button !== 0) return
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          var a = e.target.closest('a[href]')
          if (!a) return
          var href = a.getAttribute('href')
          if (!href || href.charAt(0) === '#' || href.startsWith('javascript:')) return
          try {
            var url = new URL(href, location.href)
            if (url.origin === hubOrigin && a.target && a.target !== '_self') {
              e.preventDefault()
              location.href = url.href
            }
          } catch(err) {}
        }, false)

        // Programmatic window.open — route hub URLs into webview, external URLs to default browser.
        var _open = window.open.bind(window)
        window.open = function(url) {
          if (!url) return null
          try {
            var resolved = new URL(url, location.href)
            if (resolved.origin === hubOrigin) {
              location.href = resolved.href
              return null
            }
            openExternal(resolved.href)
            return null
          } catch(err) {}
          return _open(url)
        }
      })()`,
      ).catch(() => {})
    }

    const EXT_TAG = '__VAM_OPEN_EXT__:'
    const onConsoleMessage = (e) => {
      if (typeof e.message !== 'string') return
      const i = e.message.indexOf(EXT_TAG)
      if (i < 0) return
      const url = e.message.slice(i + EXT_TAG.length).trim()
      if (url) void window.api.shell.openExternal(url)
    }

    wv.addEventListener('did-navigate', syncNav)
    wv.addEventListener('did-navigate-in-page', syncNav)
    wv.addEventListener('did-fail-load', ignoreAbort)
    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', onStopLoading)
    wv.addEventListener('dom-ready', injectLinkHandler)
    wv.addEventListener('console-message', onConsoleMessage)
    return () => {
      wv.removeEventListener('did-navigate', syncNav)
      wv.removeEventListener('did-navigate-in-page', syncNav)
      wv.removeEventListener('did-fail-load', ignoreAbort)
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', onStopLoading)
      wv.removeEventListener('dom-ready', injectLinkHandler)
      wv.removeEventListener('console-message', onConsoleMessage)
    }
  }, [resourceId, tabUrls, tabs])

  const goBack = useCallback(() => webviewRef.current?.goBack(), [])
  const goForward = useCallback(() => webviewRef.current?.goForward(), [])
  const reload = useCallback(() => webviewRef.current?.reload(), [])
  const stop = useCallback(() => webviewRef.current?.stop(), [])
  const isDev = useIsDev()
  const openWebviewDevTools = useCallback(() => {
    const wv = webviewRef.current
    if (!wv) return
    if (wv.isDevToolsOpened?.()) wv.closeDevTools()
    else wv.openDevTools()
  }, [])

  const hubLicense = getHubResourceLicense(pkg)
  const title = pkg.title || resource.title
  const username = pkg.username || resource.username
  const type = pkg.type || resource.type
  const imgUrl = pkg.image_url || resource.image_url
  const [heroImgFailed, setHeroImgFailed] = useState(false)
  useEffect(() => {
    setHeroImgFailed(false)
  }, [imgUrl, resourceId])

  const isExternal = pkg.hubDownloadable === 'false' || pkg.hubDownloadable === false
  const hubFiles = detail?.hubFiles || []
  const packageSize = hubFiles.reduce((sum, f) => sum + parseInt(f.file_size || '0', 10), 0)
  const uniqueDeps = [
    ...new Map(
      Object.values(detail?.dependencies || {})
        .flat()
        .map((f) => [f.filename || f.packageName, f]),
    ).values(),
  ]
  const missingDepsSize = uniqueDeps
    .filter((f) => !f._installed)
    .reduce((sum, f) => sum + parseInt(f.file_size || '0', 10), 0)
  const totalInstallSize = packageSize + missingDepsSize
  const depCount = detail ? uniqueDeps.length : parseInt(resource.dependency_count || '0', 10)

  const rid = String(resourceId)
  const { state: installState, dlInfo, installStatus } = useHubInstallState(rid, { isExternal })
  const wishlisted = useWishlistStore((s) => s.ids.has(rid))
  const toggleWishlist = useWishlistStore((s) => s.toggle)
  const librarySelectRef = installStatus.filename || dlInfo?.packageRef || pkg._localFilename
  const dlInstallDep = useDownloadStore((s) => s.installDep)

  const deps = useMemo(() => {
    const hf = detail?.hubFiles || []
    const depGroups = detail?.dependencies || {}
    const localName = detail?._localFilename
    const seen = new Set()

    const hasDownloadUrl = (f) => (f.downloadUrl && f.downloadUrl !== 'null') || (f.urlHosted && f.urlHosted !== 'null')
    // Dep entries in `dependencies[*]` have `filename` set to the verbatim ref (e.g.
    // "Creator.Package.latest", no .var). The downloads table stores `package_ref`
    // as the concrete `packageName + "." + latest_version + ".var"`, so we prefer
    // that form for both purposes:
    //   1. byPackageRef lookup — matches what the downloads table inserts.
    //   2. Install IPC `filename` — the version we actually want from hub.
    // Falling back to `_resolved` first was wrong for `fallback` resolutions: it
    // pointed at the older local file we already have, so `enqueueInstallRef` hit
    // the silent `{ already: true }` branch and the row snapped back to Install.
    const concreteDownloadRef = (f) => {
      const ver = f.latest_version
      if (f.packageName && ver != null && /^\d+$/.test(String(ver))) return `${f.packageName}.${ver}.var`
      if (f._resolved) return /\.var$/i.test(f._resolved) ? f._resolved : f._resolved + '.var'
      if (f.filename) return /\.var$/i.test(f.filename) ? f.filename : f.filename + '.var'
      return null
    }
    const toDepRow = (f, group) => {
      const r = f._resolution
      const dl = hasDownloadUrl(f)
      const resolution =
        r === 'exact' || r === 'latest'
          ? 'exact'
          : r === 'fallback'
            ? dl
              ? 'hub'
              : 'fallback'
            : r === 'missing'
              ? dl
                ? 'hub'
                : 'missing'
              : f._installed
                ? 'exact'
                : dl
                  ? 'hub'
                  : 'missing'
      return {
        ref: f.filename || group,
        downloadRef: concreteDownloadRef(f),
        resourceId: f.resource_id,
        resolved: f._resolved || (f._installed ? f.filename : null),
        sizeBytes: parseInt(f.file_size || '0', 10),
        resolution,
      }
    }

    const roots = hf.map((f) => {
      const installed = f._installed || localName === f.filename
      const stem = f.filename?.replace(/\.\d+\.var$/, '').replace(/\.\d+$/, '')
      const groupFiles = (stem && depGroups[stem]) || []
      const children = []
      for (const dep of groupFiles) {
        const key = dep.filename || dep.packageName
        if (seen.has(key)) continue
        seen.add(key)
        children.push(toDepRow(dep, key))
      }
      return {
        ref: f.filename,
        isRoot: true,
        downloadRef: f.filename,
        resourceId: detail?.resource_id,
        resolved: installed ? f.filename : null,
        sizeBytes: parseInt(f.file_size || '0', 10),
        resolution: installed ? 'exact' : 'hub',
        children,
      }
    })

    // Orphan deps whose group key didn't match any hubFile
    for (const [group, files] of Object.entries(depGroups)) {
      if (!group) continue
      for (const f of files) {
        const key = f.filename || group
        if (seen.has(key)) continue
        seen.add(key)
        roots.at(-1)?.children.push(toDepRow(f, group))
      }
      if (files.length === 0 && !seen.has(group)) {
        seen.add(group)
        roots.at(-1)?.children.push({ ref: group, resolved: false })
      }
    }

    return roots
  }, [detail])

  const handleInstallDep = useCallback(
    (dep) => {
      const filename = dep.downloadRef || dep.ref
      if (!filename) return
      const rid = dep.resourceId != null ? String(dep.resourceId) : String(resourceId)
      dlInstallDep({ filename, resource_id: rid, asDependency: !dep.isRoot })
    },
    [resourceId, dlInstallDep],
  )

  const hubUrl = `https://hub.virtamate.com/resources/${resourceId}`
  const externalOpenUrl = pkg.download_url || pkg.external_url || hubUrl

  useEffect(() => {
    if (!tabs.some((t) => t.key === browserTab)) setBrowserTab('overview')
  }, [tabs, browserTab])

  const [panelWidth, setPanelWidth] = usePersistedPanelWidth('panel_width_hub_detail', {
    min: 260,
    max: 500,
    defaultWidth: 320,
  })
  const startWidthRef = useRef(panelWidth)
  const onResizeStart = useCallback(() => {
    startWidthRef.current = panelWidth
  }, [panelWidth])
  const onPanelResize = useCallback(
    (delta) => setPanelWidth(Math.min(500, Math.max(260, startWidthRef.current + delta))),
    [setPanelWidth],
  )
  const [hubPanelResizeDrag, setHubPanelResizeDrag] = useState(false)

  return (
    <div className="absolute inset-0 z-20 flex flex-col min-w-0 bg-base overflow-hidden">
      {/* Back bar */}
      <div className="relative h-10 flex items-center justify-between px-4 border-b border-border shrink-0">
        {/* Back + pager, flat on the bar line (the bar is the container) */}
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" onClick={onBack} className="text-text-secondary hover:text-text-primary">
            <ArrowLeft size={14} /> Back
          </Button>
          {position && (
            <div className="flex items-center gap-0.5 ml-1 pl-1.5 border-l border-border/60">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onPrev}
                disabled={!canPrev}
                aria-label="Previous package"
                title="Previous package (←)"
                className="text-text-secondary hover:text-text-primary"
              >
                <ChevronLeft size={14} />
              </Button>
              <span className="text-[11px] text-text-tertiary tabular-nums min-w-[42px] text-center select-none">
                {position.n} / {position.total}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onNext}
                disabled={!canNext}
                aria-label="Next package"
                title="Next package (→)"
                className="text-text-secondary hover:text-text-primary"
              >
                <ChevronRight size={14} />
              </Button>
            </div>
          )}
        </div>

        {/* Centered title — labels the whole view, independent of side widths */}
        <span className="absolute left-1/2 -translate-x-1/2 max-w-[42%] truncate text-xs text-text-primary font-medium pointer-events-none select-none">
          {title}
        </span>

        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onBack}
          aria-label="Close detail"
          className="shrink-0 text-text-tertiary/70 hover:text-text-tertiary hover:bg-muted/35"
        >
          <X size={12} strokeWidth={1.75} />
        </Button>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Left: Package info panel */}
        <div className="flex shrink-0" style={{ width: panelWidth }}>
          <div className="flex-1 min-w-0 border-r border-border overflow-y-auto p-4 pr-2.5 [scrollbar-gutter:stable]">
            {/* Hero */}
            <div className="aspect-square rounded-lg overflow-hidden mb-3 relative">
              <div className="absolute inset-0" style={{ background: getGradient(String(resourceId)) }} />
              {imgUrl && !heroImgFailed ? (
                <img
                  src={imgUrl}
                  className="thumb absolute inset-0 w-full h-full object-cover"
                  alt=""
                  onError={() => setHeroImgFailed(true)}
                />
              ) : null}
            </div>

            <div className="flex items-baseline gap-2">
              <h2 className="text-[16px] font-semibold text-text-primary select-text cursor-text">{title}</h2>
              {detailLoading ? (
                <div className="h-3.5 w-12 skeleton rounded" />
              ) : pkg.version_string ? (
                <span className="text-xs text-text-tertiary font-mono select-text cursor-text">
                  {pkg.version_string}
                </span>
              ) : null}
            </div>

            {/* Author card — skeleton while a nav-driven detail with no stub author loads */}
            {username ? (
              <button
                type="button"
                onClick={() => {
                  onFilterAuthor?.(username)
                  onBack()
                }}
                className="w-full flex items-center gap-2.5 mt-2.5 p-2 rounded-lg bg-elevated/50 text-left transition-colors hover:bg-elevated"
              >
                <AuthorAvatar author={username} userId={pkg.user_id} size={32} />
                <div>
                  <div className="text-xs text-text-primary font-medium">{username}</div>
                  <div className="text-[10px] text-text-tertiary">Package author</div>
                </div>
              </button>
            ) : (
              <div className="w-full flex items-center gap-2.5 mt-2.5 p-2 rounded-lg bg-elevated/50">
                <div className="h-8 w-8 skeleton rounded-md shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="h-3 w-24 skeleton rounded" />
                  <div className="h-2.5 w-16 skeleton rounded mt-1" />
                </div>
              </div>
            )}

            {isPromotionalLink(pkg.promotional_link) && (
              <button
                type="button"
                title={pkg.promotional_link}
                onClick={() => void openExternalLink(pkg.promotional_link)}
                className="flex items-center gap-1.5 mt-1.5 px-2 py-1 text-[10px] text-accent-blue hover:brightness-125 transition-[filter] cursor-pointer"
              >
                <Heart size={10} /> Support this creator
              </button>
            )}

            {/* Badges */}
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <Tag
                className="text-[9px] font-semibold text-white"
                style={{ background: (TYPE_COLORS[type] || '#6366f1') + 'cc' }}
              >
                {type}
              </Tag>
              {pkg.category && (
                <Tag
                  variant={pkg.category === 'Free' || pkg.category === 'Paid' ? 'filled' : 'outlined'}
                  className={
                    pkg.category === 'Free' || pkg.category === 'Paid'
                      ? 'text-[9px] font-semibold text-white'
                      : 'text-[9px] font-semibold border-border bg-elevated/80 text-text-tertiary'
                  }
                  style={
                    pkg.category === 'Free' || pkg.category === 'Paid'
                      ? { background: (HUB_CATEGORY_COLORS[pkg.category] || '#6366f1') + 'cc' }
                      : undefined
                  }
                >
                  {pkg.category}
                </Tag>
              )}
              {hubLicense && <LicenseTag license={hubLicense} />}
            </div>

            {/* Description */}
            {pkg.tag_line && (
              <p className="text-xs text-text-secondary leading-relaxed mt-3 select-text cursor-text">{pkg.tag_line}</p>
            )}

            {/* Stats */}
            <div className="flex items-center gap-4 mt-3 py-2.5 border-y border-border text-[12px]">
              <span className="flex items-center gap-1.5 text-text-tertiary">
                <Download size={13} />
                <span className="text-text-primary font-medium">
                  {formatNumber(parseInt(pkg.download_count || '0', 10))}
                </span>
              </span>
              <RatingStat
                ratingAvg={pkg.rating_avg}
                ratingWeighted={pkg.rating_weighted}
                ratingCount={parseInt(pkg.rating_count || '0', 10)}
                loggedIn={hubLoggedIn}
                rated={rated}
                ratedDown={ratedDown}
                busy={interactionsLoading}
                onRate={toggleRate}
              />
              <LikeStat
                count={Math.max(0, (serverReactionScore ?? parseInt(pkg.reaction_score || '0', 10)) + likeDelta)}
                loggedIn={hubLoggedIn}
                liked={liked}
                busy={interactionsLoading}
                onLike={toggleLike}
              />
              <FavoriteStat
                loggedIn={hubLoggedIn}
                favorited={favorited}
                favoriteCount={favoriteCount}
                busy={interactionsLoading}
                onFavorite={toggleFavorite}
              />
              <BookmarkStat
                loggedIn={hubLoggedIn}
                bookmarked={bookmarked}
                busy={interactionsLoading}
                onBookmark={toggleBookmark}
              />
              <button
                type="button"
                onClick={() => toggleWishlist(pkg)}
                title={wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
                aria-label={wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
                className={`ml-auto -my-1 p-1 rounded cursor-pointer transition-colors ${wishlisted ? 'text-accent-blue' : 'text-text-tertiary hover:text-text-secondary'}`}
              >
                <Pin size={15} fill={wishlisted ? 'currentColor' : 'none'} />
              </button>
            </div>

            {/* Dates */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-3 text-[11px]">
              <div className="flex items-center gap-1.5 text-text-tertiary">
                <Calendar size={11} /> Released
              </div>
              {detailLoading ? (
                <div className="h-3 w-20 skeleton rounded self-center" />
              ) : (
                <div className="text-text-primary">{formatDate(pkg.resource_date)}</div>
              )}
              <div className="flex items-center gap-1.5 text-text-tertiary">
                <Clock size={11} /> Updated
              </div>
              <div className="text-text-primary">{formatDate(pkg.last_update)}</div>
            </div>

            {/* Action */}
            <div className="mt-3">
              {installState === 'downloading' ? (
                <div className="w-full">
                  <div className="relative py-2 rounded-lg overflow-hidden bg-white/6">
                    <div
                      className="absolute inset-y-0 left-0 progress-bar rounded-lg transition-[width] duration-200"
                      style={{ width: `${Math.max(dlInfo.progress, 2)}%` }}
                    />
                    <span className="relative z-10 flex items-center justify-center text-xs text-white font-medium gap-1.5">
                      Downloading {dlInfo.completed}/{dlInfo.total} · {dlInfo.progress}%
                    </span>
                  </div>
                  {dlInfo.failed > 0 && (
                    <div className="text-[10px] text-error mt-1 text-center">{dlInfo.failed} failed</div>
                  )}
                </div>
              ) : installState === 'queued' ? (
                <div className="w-full py-2 rounded-lg text-xs border border-border text-text-tertiary flex items-center justify-center gap-1.5">
                  <Clock size={14} /> Queuing…
                </div>
              ) : installState === 'installed' ? (
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => onNavigate('library', { selectPackage: librarySelectRef })}
                  disabled={!librarySelectRef}
                  className="w-full text-xs border-accent-blue/30 text-accent-blue bg-accent-blue/5 hover:bg-accent-blue/10"
                >
                  <LibraryIcon size={14} /> View in Library
                </Button>
              ) : installState === 'installed-dep' ? (
                <Button
                  variant="gradient"
                  size="lg"
                  onClick={() => {
                    if (!installStatus.filename) return
                    window.api.packages.promote(installStatus.filename, resourceId)
                    useInstalledStore.getState().update(rid, true, true, installStatus.filename)
                    useHubStore.setState((s) => ({
                      resources: s.resources.map((r) =>
                        String(r.resource_id) === rid ? { ...r, _isDirect: true } : r,
                      ),
                      detailData:
                        s.detailData && String(s.detailData.resource_id) === rid
                          ? { ...s.detailData, _isDirect: true }
                          : s.detailData,
                    }))
                  }}
                  className="w-full text-xs"
                >
                  <Plus size={14} /> Add to Library
                </Button>
              ) : installState === 'external' ? (
                <Button
                  variant="outline"
                  size="lg"
                  title={externalOpenUrl}
                  onClick={() => void window.api.shell.openExternal(externalOpenUrl)}
                  className="w-full text-xs"
                >
                  <ExternalLink size={14} /> {extractDomainLabel(externalOpenUrl)}
                </Button>
              ) : detailLoading ? (
                <div className="w-full h-[34px] skeleton rounded-lg" />
              ) : (
                <Button
                  variant="gradient"
                  size="lg"
                  onClick={() => onInstall?.(pkg, detail)}
                  className="w-full text-xs"
                >
                  <Download size={14} /> Install{depCount > 0 ? ' All' : ''}
                  {totalInstallSize ? ` · ${formatBytes(totalInstallSize)}` : ''}
                </Button>
              )}
            </div>

            {/* Dependencies */}
            {depCount > 0 ? (
              <div className="mt-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-medium">
                    Package files <span className="normal-case">({depCount + deps.length})</span>
                  </span>
                </div>
                {detailLoading ? (
                  <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
                    {Array.from({ length: Math.min(depCount || 3, 6) }, (_, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 py-2"
                        style={{ paddingLeft: 10, paddingRight: 10 }}
                      >
                        <div className="h-3 skeleton rounded flex-1" />
                        <div className="h-3 w-12 skeleton rounded shrink-0" />
                        <div className="h-4 w-16 skeleton rounded shrink-0" />
                      </div>
                    ))}
                  </div>
                ) : deps.length > 0 ? (
                  <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
                    <DepTree deps={deps} onInstall={handleInstallDep} />
                  </div>
                ) : null}
              </div>
            ) : !detailLoading ? (
              <div className="mt-3 text-[11px] text-text-tertiary">No dependencies</div>
            ) : null}
          </div>
          <ResizeHandle
            side="right"
            onResizeStart={onResizeStart}
            onResize={onPanelResize}
            onDraggingChange={setHubPanelResizeDrag}
          />
        </div>

        {/* Right: Webview browser — pointer-events off on webview while resizing so the guest view does not steal the drag */}
        <div className={`flex-1 flex flex-col min-w-0 bg-base ${hubPanelResizeDrag ? 'select-none' : ''}`}>
          {/* Browser toolbar */}
          <div className="h-10 flex items-center gap-1.5 px-3 border-b border-border bg-surface shrink-0">
            <Button variant="ghost" size="icon-sm" onClick={goBack} disabled={!canGoBack}>
              <ArrowLeft size={14} />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={goForward} disabled={!canGoForward}>
              <ArrowRight size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={isLoading ? stop : reload}
              title={isLoading ? 'Stop' : 'Reload'}
            >
              {isLoading ? <X size={14} /> : <RotateCw size={13} />}
            </Button>
            <div className="flex-1 min-w-0 h-7 bg-elevated border border-border rounded px-2.5 flex items-center gap-2 ml-1 focus-within:border-accent-blue/60 transition-colors">
              <Globe size={12} className="text-text-tertiary shrink-0" />
              <input
                ref={addressInputRef}
                type="text"
                value={addressDraft}
                spellCheck={false}
                onChange={(e) => setAddressDraft(e.target.value)}
                onFocus={() => setAddressFocused(true)}
                onBlur={() => {
                  setAddressFocused(false)
                  setAddressDraft(displayUrl)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    navigateToAddress()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setAddressDraft(displayUrl)
                    addressInputRef.current?.blur()
                  }
                }}
                className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-text-secondary font-mono select-text cursor-text"
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              title={urlCopied ? 'Copied!' : 'Copy URL'}
              className="shrink-0 relative"
              onClick={() => {
                // Strip trailing *-panel segment so the copied URL is shareable (e.g. …/overview-panel → …/).
                const url = displayUrl.replace(
                  /^(https:\/\/hub\.virtamate\.com\/(?:resources|threads)\/[^/]+)\/[^/]+-panel\/?$/,
                  '$1/',
                )
                navigator.clipboard.writeText(url).then(() => {
                  setUrlCopied(true)
                  setTimeout(() => setUrlCopied(false), 1500)
                })
              }}
            >
              <Copy
                size={14}
                className={`transition-all duration-200 ${urlCopied ? 'opacity-0 scale-50' : 'opacity-100 scale-100'}`}
              />
              <Check
                size={14}
                className={`absolute transition-all duration-200 text-success ${urlCopied ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`}
              />
            </Button>
            {isDev && (
              <Button variant="ghost" size="icon-sm" title="Open webview DevTools" onClick={openWebviewDevTools}>
                <Bug size={14} />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" className="ml-1" asChild>
              <a
                href={hubUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  e.preventDefault()
                  void window.api.shell.openExternal(hubUrl)
                }}
              >
                <ExternalLink size={14} />
              </a>
            </Button>
          </div>

          {/* Tab bar */}
          <div className="flex items-center border-b border-border bg-surface shrink-0">
            {tabs.map((tab) => (
              <button
                type="button"
                key={tab.key}
                onClick={() => selectTab(tab.key)}
                className={`px-4 py-2 text-xs border-b-2 transition-colors cursor-pointer ${browserTab === tab.key ? 'border-accent-blue text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Webview */}
          <div className="flex-1 min-h-0">
            <webview
              key={browserResourceId}
              ref={webviewRef}
              src={navUrl}
              partition="persist:hub"
              allowpopups="true"
              className="w-full h-full"
              style={{ display: 'flex', pointerEvents: hubPanelResizeDrag ? 'none' : 'auto' }}
            />
          </div>
        </div>
      </div>
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

// --- Expandable dep list for hub detail ---

function DepTree({ deps, onInstall }) {
  const flat = useMemo(() => {
    const rows = []
    for (const root of deps) {
      rows.push({ dep: root, depth: 0 })
      for (const child of root.children || []) {
        rows.push({ dep: child, depth: 1 })
      }
    }
    return rows
  }, [deps])

  return (
    <>
      {flat.map(({ dep, depth }, i) => (
        <DepRow key={dep.ref || i} dep={dep} depth={depth} renderChildren={false} onInstall={onInstall} />
      ))}
    </>
  )
}
