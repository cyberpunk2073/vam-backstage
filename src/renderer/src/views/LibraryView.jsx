import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  Grid3x3,
  Grid2x2,
  List,
  AlertTriangle,
  Eye,
  Power,
  Plus,
  Trash2,
  Compass,
  Heart,
  ChevronUp,
  ChevronDown,
  LayoutGrid,
  Blend,
  RefreshCw,
  Download,
  Loader2,
  ArrowUpCircle,
  FolderTree,
  Search,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { toast } from '@/components/Toast'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  TYPE_COLORS,
  LIBRARY_FILTER_TYPES,
  compareContentTypes,
  compareLibraryPackageTypes,
  getGradient,
  formatBytes,
  displayName,
  isCoreLibraryCategory,
  libraryTypeBadgeLabel,
  cn,
  THUMB_CHIP_BOX,
  THUMB_OVERLAY_CHIP,
  isPromotionalLink,
  openExternalLink,
} from '@/lib/utils'
import { toastIfBulkToggleFailures, toastIfSingleToggleFailed } from '@/lib/packageStorageToggleResults'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LabelApplyPopover } from '@/components/labels/LabelApplyPopover'
import { bulkStateMap } from '@/components/labels/labelHelpers'
import { Tag } from 'lucide-react'
import { useThumbnail } from '@/hooks/createBlobCacheHook'
import { useLibraryStore, FILTER_DEFAULTS } from '@/stores/useLibraryStore'
import { useLabelsStore } from '@/stores/useLabelsStore'
import { useContentStore } from '@/stores/useContentStore'
import { useDownloadStore } from '@/stores/useDownloadStore'
import { useWishlistStore } from '@/stores/useWishlistStore'
import FilterPanel, { sectionActive } from '@/components/FilterPanel'
import { SearchOnHubButton } from '@/components/SearchOnHubButton'
import ResizeHandle from '@/components/ResizeHandle'
import { LibraryCard, LibraryTableRow, DepRow, AuthorAvatar, AuthorLink } from '@/components/PackageCard'
import { LabelsRow } from '@/components/labels/LabelsRow'
import { AddLabelButton } from '@/components/labels/AddLabelButton'
import { StorageStateChip } from '@/components/StorageStateChip'
import { ContentCategory, buildContentGallery } from '@/components/ContentCategory'
import FileTreeDialog from '@/components/FileTreeDialog'
import { openLightbox } from '@/components/ThumbnailLightbox'
import { VirtualGrid, VirtualList } from '@/components/VirtualGrid'
import { ThumbnailSizeSlider } from '@/components/ThumbnailSizeSlider'
import { useKeyboardNav } from '@/hooks/useKeyboardNav'
import { usePersistedPanelWidth } from '@/hooks/usePersistedPanelWidth'
import { useLibraryUpdateState } from '@/hooks/useLibraryUpdateState'
import { LICENSE_FILTER_OPTIONS } from '@/lib/licenses'
import { matchesSmartQuery, parseSmartQuery } from '@/lib/smart-search'
import { matchesPolarityList, matchesAuthorFilter, matchesLicenseFilter, polarityScrollKey } from '@/lib/filter-match'
import { haystacksMatchAllTerms, LIBRARY_IS_FLAGS, libraryFlags, searchAndTerms } from '@/lib/search-text'
import { isPackageActive } from '@shared/storage-state-predicates.js'
import { LicenseTag } from '@/components/LicenseTag'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { LibraryPackageContextMenu } from '@/components/LibraryPackageContextMenu'
import {
  UninstallDialogContent,
  DisablePackageDialogContent,
  ForceRemoveDialogContent,
} from '@/components/package-action-dialogs'
import { packageNeedsDisableConfirmation } from '@/lib/package-disable-confirm'

const SORT_OPTIONS = ['Recently installed', 'Type', 'Name', 'Size', 'Content', 'Deps', 'Morphs']

function packageHubTags(p) {
  return p.hubTags
    ? p.hubTags
        .toLowerCase()
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : []
}

function packageMatchesSelectedTags(p, selectedTags) {
  return matchesPolarityList(selectedTags, packageHubTags(p), { normalize: true })
}

function packageMatchesSelectedLabels(p, selectedLabelIds) {
  return matchesPolarityList(selectedLabelIds, p.labelIds || [])
}

/** True when an update entry has been definitively marked as not directly
 *  downloadable — paid/external, or hub couldn't be reached and enrichment
 *  marked it null as the fallback state. `downloadUrl === undefined` means
 *  enrichment hasn't completed yet and is treated as "checking" by the UI
 *  (separate state, not unavailable). */
function isUpdateUnavailable(updateInfo) {
  if (!updateInfo || updateInfo.localNewerFilename) return false
  return updateInfo.downloadUrl === null
}

/** True when the update entry hasn't been enriched yet — only happens on the
 *  first check before findPackages returns, since later checks merge prior
 *  enrichment forward. */
function isUpdateChecking(updateInfo) {
  if (!updateInfo || updateInfo.localNewerFilename) return false
  return updateInfo.downloadUrl === undefined
}

/** A package counts as "broken" when it's corrupted, has missing deps, or — while
 *  active — has dependencies that are installed but disabled/offloaded (VaM won't
 *  load them). Inactive packages aren't flagged: their inactive deps are expected. */
function isBrokenPackage(p) {
  return p.missingDeps > 0 || p.isCorrupted || (p.inactiveDeps > 0 && isPackageActive(p.storageState))
}

function filterPackagesByStatus(items, statusFilter, updateCheckResults) {
  if (statusFilter === 'missing') return []
  if (statusFilter === 'direct') return items.filter((p) => p.isDirect)
  if (statusFilter === 'dependency') return items.filter((p) => !p.isDirect)
  if (statusFilter === 'broken') return items.filter(isBrokenPackage)
  if (statusFilter === 'orphan') return items.filter((p) => p.isOrphan)
  if (statusFilter === 'updates') return items.filter((p) => updateCheckResults?.[p.filename])
  if (statusFilter === 'local') return items.filter((p) => p.isLocalOnly)
  return items
}

function filterPackagesBySelectedTypes(items, selectedTypes) {
  if (selectedTypes.length === 0) return items
  const typeSet = new Set(selectedTypes)
  return items.filter((p) => {
    const isOther = !isCoreLibraryCategory(p.type)
    if (typeSet.has('Other') && isOther) return true
    return p.type && typeSet.has(p.type)
  })
}

function filterPackagesByEnabledStorage(items, enabledFilter) {
  if (enabledFilter === 'all') return items
  return items.filter((p) => p.storageState === enabledFilter)
}

export default function LibraryView({ onNavigate, navContext }) {
  const {
    packages,
    selectedDetail,
    search,
    authorSearch,
    excludedAuthors,
    statusFilter,
    enabledFilter,
    selectedTypes,
    selectedTags,
    selectedLabelIds,
    primarySort,
    secondarySort,
    license,
    viewMode,
    cardWidth,
    compactCards,
    missingDeps,
    missingDepsLoading,
    hubDetailsLoading,
    updateCheckResults,
    updateCheckLoading,
    updateCheckLastChecked,
    backendCounts,
    packagesLoaded,
    setSearch,
    setAuthorSearch,
    setExcludedAuthors,
    setStatusFilter,
    setEnabledFilter,
    toggleType,
    selectSingleType,
    setSelectedTags,
    setSelectedLabelIds,
    setPrimarySort,
    setSecondarySort,
    setLicense,
    resetFilters,
    setViewMode,
    setCardWidth,
    setCompactCards,
    fetchPackages,
    fetchMissingDeps,
    refreshUpdateCheck,
    selectPackage,
    bulkSelectedFilenames,
    toggleBulkSelect,
    rangeBulkSelect,
    selectAllBulk,
    clearBulkSelection,
  } = useLibraryStore()
  const labels = useLabelsStore((s) => s.labels)
  const labelNameById = useMemo(() => {
    const m = new Map()
    for (const l of labels) m.set(l.id, l.name)
    return m
  }, [labels])

  const [gridLayout, setGridLayout] = useState({ cols: 1, availableWidth: 0 })
  const [tagCounts, setTagCounts] = useState({})
  const [authorCounts, setAuthorCounts] = useState({})
  const [detailPanelWidth] = usePersistedPanelWidth('panel_width_detail', { min: 260, max: 500, defaultWidth: 340 })
  const selectingRef = useRef(false)

  useEffect(() => {
    const getLibraryStore = () => useLibraryStore.getState()
    getLibraryStore().fetchPackages()
    getLibraryStore().fetchBackendCounts()
    // Wishlist pin badges on library cards need membership ids even if Hub was never opened.
    useWishlistStore.getState().loadIds()
    window.api.packages
      .tagCounts()
      .then(setTagCounts)
      .catch(() => {})
    window.api.packages
      .authorCounts()
      .then(setAuthorCounts)
      .catch(() => {})
    getLibraryStore().checkForUpdates()
    // Note: selectedDetail refresh + fetchPackages happen at App level so they
    // fire even when LibraryView is unmounted. We only refresh view-scoped
    // sidebar/toolbar data here.
    const cleanup1 = window.api.onPackagesUpdated(() => {
      const store = getLibraryStore()
      store.fetchBackendCounts()
      store.checkForUpdates({ enrich: false })
      if (store.statusFilter === 'missing') {
        store.fetchMissingDeps({ enrich: false })
      } else {
        useLibraryStore.setState({ missingDeps: null })
      }
      window.api.packages
        .tagCounts()
        .then(setTagCounts)
        .catch(() => {})
      window.api.packages
        .authorCounts()
        .then(setAuthorCounts)
        .catch(() => {})
    })
    // Keep pin badges in sync when Hub never loaded the full wishlist (peer pin/unpin).
    const cleanupWishlist = window.api.onWishlistUpdated((data) => {
      const s = useWishlistStore.getState()
      if (!s.loaded && data?.membership) s.loadIds()
    })
    return () => {
      cleanup1()
      cleanupWishlist()
    }
  }, [])

  useEffect(() => {
    const ctx = navContext?.current
    if (!ctx) return
    if (ctx.selectPackage) {
      selectingRef.current = true
      void selectPackage(ctx.selectPackage).finally(() => {
        selectingRef.current = false
      })
    }
    navContext.current = null
  }, [navContext, selectPackage])

  // Lazy-load missing deps data + hub availability when missing filter activates (cached)
  useEffect(() => {
    if (statusFilter !== 'missing') return
    const store = useLibraryStore.getState()
    if (!store.missingDeps && !store.missingDepsLoading) store.fetchMissingDeps()
  }, [statusFilter])

  const wishlistIds = useWishlistStore((s) => s.ids)

  const baseFiltered = useMemo(() => {
    let result = packages
    if (search?.trim()) {
      const { tokens } = parseSmartQuery(search)
      result = result.filter((p) =>
        matchesSmartQuery(tokens, {
          text: () => [p.title, p.packageName, p.filename],
          author: () => p.creator || '',
          tags: () => packageHubTags(p),
          labels: () => (p.labelIds || []).map((id) => labelNameById.get(id)).filter(Boolean),
          types: () => [libraryTypeBadgeLabel(p.type)],
          flags: () => {
            const rid = p.hubResourceId != null ? String(p.hubResourceId) : ''
            return libraryFlags({
              ...p,
              wishlisted: !!rid && wishlistIds.has(rid),
              broken: isBrokenPackage(p),
            })
          },
        }),
      )
    }
    if (authorSearch || excludedAuthors.length > 0) {
      result = result.filter((p) => matchesAuthorFilter(p.creator, authorSearch, excludedAuthors))
    }
    if (license !== 'Any') {
      result = result.filter((p) => matchesLicenseFilter(p.license, license))
    }
    return result
  }, [packages, search, authorSearch, excludedAuthors, license, labelNameById, wishlistIds])

  const statusCounts = useMemo(() => {
    if (!packagesLoaded) return { direct: '…', dependency: '…', broken: '…', orphan: '…', local: '…' }
    let items = baseFiltered
    items = filterPackagesBySelectedTypes(items, selectedTypes)
    items = filterPackagesByEnabledStorage(items, enabledFilter)
    items = items.filter((p) => packageMatchesSelectedTags(p, selectedTags))
    items = items.filter((p) => packageMatchesSelectedLabels(p, selectedLabelIds))
    let direct = 0,
      dependency = 0,
      broken = 0,
      orphan = 0,
      local = 0
    for (const p of items) {
      if (p.isDirect) direct++
      else dependency++
      if (isBrokenPackage(p)) broken++
      if (!p.isDirect && p.isOrphan) orphan++
      if (p.isLocalOnly) local++
    }
    return { direct, dependency, broken, orphan, local }
  }, [packagesLoaded, baseFiltered, selectedTypes, enabledFilter, selectedTags, selectedLabelIds])

  const updateFacetCount = useMemo(() => {
    if (!updateCheckResults) return updateCheckLoading ? '…' : '?'
    let items = baseFiltered
    items = filterPackagesBySelectedTypes(items, selectedTypes)
    items = filterPackagesByEnabledStorage(items, enabledFilter)
    items = items.filter((p) => packageMatchesSelectedTags(p, selectedTags))
    items = items.filter((p) => packageMatchesSelectedLabels(p, selectedLabelIds))
    let n = 0
    for (const p of items) {
      if (updateCheckResults[p.filename]) n++
    }
    return n
  }, [
    baseFiltered,
    selectedTypes,
    enabledFilter,
    selectedTags,
    selectedLabelIds,
    updateCheckResults,
    updateCheckLoading,
  ])

  const typeCounts = useMemo(() => {
    let items = filterPackagesByStatus(baseFiltered, statusFilter, updateCheckResults)
    items = filterPackagesByEnabledStorage(items, enabledFilter)
    items = items.filter((p) => packageMatchesSelectedTags(p, selectedTags))
    items = items.filter((p) => packageMatchesSelectedLabels(p, selectedLabelIds))
    const counts = { _total: items.length }
    for (const p of items) {
      const label = libraryTypeBadgeLabel(p.type)
      counts[label] = (counts[label] || 0) + 1
    }
    return counts
  }, [baseFiltered, statusFilter, enabledFilter, selectedTags, selectedLabelIds, updateCheckResults])

  /** Facet counts for Enabled filter: respects status/type/tags/labels but not enabled itself */
  const enabledFilterCounts = useMemo(() => {
    let items = filterPackagesByStatus(baseFiltered, statusFilter, updateCheckResults)
    items = filterPackagesBySelectedTypes(items, selectedTypes)
    items = items.filter((p) => packageMatchesSelectedTags(p, selectedTags))
    items = items.filter((p) => packageMatchesSelectedLabels(p, selectedLabelIds))
    let enabled = 0,
      disabled = 0,
      offloaded = 0
    for (const p of items) {
      if (p.storageState === 'disabled') disabled++
      else if (p.storageState === 'offloaded') offloaded++
      else if (p.storageState === 'enabled') enabled++
    }
    return { all: items.length, enabled, disabled, offloaded }
  }, [baseFiltered, statusFilter, selectedTypes, selectedTags, selectedLabelIds, updateCheckResults])

  const filtered = useMemo(() => {
    let result = filterPackagesByStatus(baseFiltered, statusFilter, updateCheckResults)
    result = filterPackagesByEnabledStorage(result, enabledFilter)
    result = filterPackagesBySelectedTypes(result, selectedTypes)
    result = result.filter((p) => packageMatchesSelectedTags(p, selectedTags))
    result = result.filter((p) => packageMatchesSelectedLabels(p, selectedLabelIds))
    const sortFns = {
      'Recently installed': (a, b) =>
        (b.firstSeenAt || 0) - (a.firstSeenAt || 0) || (b.fileMtime || 0) - (a.fileMtime || 0),
      Name: (a, b) => displayName(a).localeCompare(displayName(b)),
      Type: (a, b) => compareLibraryPackageTypes(a.type, b.type),
      Size: (a, b) => b.sizeBytes + (b.removableSize || 0) - (a.sizeBytes + (a.removableSize || 0)),
      Content: (a, b) => b.contentCount - a.contentCount,
      Deps: (a, b) => b.depCount - a.depCount,
      Morphs: (a, b) => (b.morphCount || 0) - (a.morphCount || 0),
    }
    const primary = sortFns[primarySort] || sortFns['Type']
    const secondary = sortFns[secondarySort] || sortFns['Recently installed']
    result.sort((a, b) => primary(a, b) || secondary(a, b))
    return result
  }, [
    baseFiltered,
    statusFilter,
    enabledFilter,
    selectedTypes,
    selectedTags,
    selectedLabelIds,
    primarySort,
    secondarySort,
    updateCheckResults,
  ])

  const sections = useMemo(
    () => [
      {
        key: 'status',
        label: 'Status',
        type: 'list',
        value: statusFilter,
        // Omit `default` so Status never highlights or counts toward Reset (like sort).
        onChange: setStatusFilter,
        listCollapsible: false,
        items: [
          {
            value: 'direct',
            label: 'Installed',
            count: statusCounts.direct,
            title: 'Installed directly (not pulled in only as dependencies)',
          },
          { value: 'dependency', label: 'Dependencies', count: statusCounts.dependency },
          {
            value: 'orphan',
            label: 'Orphan',
            count: statusCounts.orphan,
            level: 1,
            title: 'Installed dependencies that nothing else in your library depends on',
          },
          {
            value: 'local',
            label: 'Local',
            count: statusCounts.local,
            title: 'Not available to download from the Hub',
          },
          {
            value: 'broken',
            label: 'Broken',
            count: statusCounts.broken,
            title: 'Have missing or corrupted dependencies',
          },
          {
            value: 'missing',
            label: 'Missing',
            count: backendCounts?.missingUnique ?? '…',
            title: 'Dependencies referenced by your packages but not installed locally',
          },
          { value: 'updates', label: 'Updates', count: updateFacetCount },
        ],
      },
      {
        key: 'type',
        label: 'Type',
        type: 'tags',
        value: new Set(selectedTypes),
        default: FILTER_DEFAULTS.selectedTypes,
        onChange: selectSingleType,
        onToggle: toggleType,
        items: [
          {
            value: 'All',
            label: 'All',
            count:
              statusFilter === 'updates' && updateCheckResults == null
                ? updateCheckLoading
                  ? '…'
                  : '?'
                : typeCounts._total,
          },
          ...LIBRARY_FILTER_TYPES.map((t) => ({
            value: t,
            label: t,
            count: typeCounts[t] || 0,
            color: TYPE_COLORS[t],
          })),
        ],
      },
      {
        key: 'enabled',
        label: 'Enabled',
        type: 'list',
        value: enabledFilter,
        default: FILTER_DEFAULTS.enabledFilter,
        onChange: setEnabledFilter,
        listCollapsible: false,
        items: [
          { value: 'all', label: 'All', count: enabledFilterCounts.all },
          { value: 'enabled', label: 'Enabled', count: enabledFilterCounts.enabled },
          { value: 'disabled', label: 'Disabled', count: enabledFilterCounts.disabled },
          { value: 'offloaded', label: 'Offloaded', count: enabledFilterCounts.offloaded },
        ],
      },
      ...(labels.length
        ? [
            {
              key: 'labels',
              label: 'Labels',
              type: 'labels-autocomplete',
              value: selectedLabelIds,
              default: FILTER_DEFAULTS.selectedLabelIds,
              onChange: setSelectedLabelIds,
              labels,
              placeholder: 'Filter by label…',
              allowNegate: true,
            },
          ]
        : []),
      {
        key: 'hubTags',
        label: 'Tags',
        type: 'tags-autocomplete',
        value: selectedTags,
        default: FILTER_DEFAULTS.selectedTags,
        onChange: setSelectedTags,
        suggestions: tagCounts,
        placeholder: 'Filter by tags…',
        allowNegate: true,
      },
      {
        key: 'author',
        label: 'Author',
        type: 'text-autocomplete',
        value: authorSearch,
        default: FILTER_DEFAULTS.authorSearch,
        onChange: setAuthorSearch,
        excluded: excludedAuthors,
        onExcludedChange: setExcludedAuthors,
        suggestions: authorCounts,
        placeholder: 'Filter by author…',
        titleAction: authorSearch ? <SearchOnHubButton author={authorSearch} onNavigate={onNavigate} /> : null,
      },
      {
        key: 'license',
        label: 'License',
        type: 'select',
        value: license,
        default: FILTER_DEFAULTS.license,
        onChange: setLicense,
        options: LICENSE_FILTER_OPTIONS,
      },
      {
        key: 'primarySort',
        label: 'Sort by',
        type: 'select',
        value: primarySort,
        onChange: setPrimarySort,
        options: SORT_OPTIONS,
      },
      {
        key: 'secondarySort',
        label: 'Then by',
        type: 'select',
        value: secondarySort,
        onChange: setSecondarySort,
        options: SORT_OPTIONS,
      },
    ],
    [
      statusFilter,
      enabledFilter,
      selectedTypes,
      typeCounts,
      statusCounts,
      enabledFilterCounts,
      backendCounts,
      updateFacetCount,
      authorSearch,
      excludedAuthors,
      selectedTags,
      selectedLabelIds,
      labels,
      tagCounts,
      authorCounts,
      license,
      primarySort,
      secondarySort,
      updateCheckLoading,
      updateCheckResults,
      setStatusFilter,
      toggleType,
      selectSingleType,
      setEnabledFilter,
      setAuthorSearch,
      setExcludedAuthors,
      setSelectedTags,
      setSelectedLabelIds,
      setLicense,
      setPrimarySort,
      setSecondarySort,
      onNavigate,
    ],
  )

  const activeFilterCount = sections.filter((s) => sectionActive(s) === true).length

  const orderedLibraryFilenames = useMemo(() => filtered.map((p) => p.filename), [filtered])
  const bulkActive = bulkSelectedFilenames.length > 0
  const bulkToggleIntent = useLibraryStore((s) => s.bulkToggleIntent)
  const selectedBulkSet = useMemo(() => new Set(bulkSelectedFilenames), [bulkSelectedFilenames])

  const scrollResetKey = `${search}\0${authorSearch}\0${excludedAuthors.join(',')}\0${statusFilter}\0${enabledFilter}\0${selectedTypes.join(',')}\0${polarityScrollKey(selectedTags)}\0${polarityScrollKey(selectedLabelIds)}\0${primarySort}\0${secondarySort}\0${license}`

  const lastSelectedIdxRef = useRef(0)
  const prevScrollResetKeyRef = useRef(scrollResetKey)
  const selectedIdx = selectedDetail ? filtered.findIndex((p) => p.filename === selectedDetail.filename) : -1
  if (selectedIdx >= 0) lastSelectedIdxRef.current = selectedIdx

  const runSelectPackage = useCallback(
    (filename) => {
      if (!filename) return Promise.resolve()
      selectingRef.current = true
      return selectPackage(filename).finally(() => {
        selectingRef.current = false
      })
    },
    [selectPackage],
  )

  useEffect(() => {
    if (bulkActive || statusFilter === 'missing' || filtered.length === 0) {
      prevScrollResetKeyRef.current = scrollResetKey
      return
    }
    if (selectingRef.current) return
    if (selectedDetail && filtered.some((p) => p.filename === selectedDetail.filename)) {
      prevScrollResetKeyRef.current = scrollResetKey
      return
    }
    const scrollReset = prevScrollResetKeyRef.current !== scrollResetKey
    prevScrollResetKeyRef.current = scrollResetKey
    // Keep detail-targeted selections that are outside the current sidebar filters (deps / dependents).
    if (selectedDetail && !scrollReset) return
    const idx = scrollReset ? 0 : Math.min(lastSelectedIdxRef.current, filtered.length - 1)
    const target = filtered[idx]
    if (!target) return
    void runSelectPackage(target.filename)
  }, [bulkActive, filtered, selectedDetail, statusFilter, scrollResetKey, runSelectPackage])

  const handleLibraryClick = useCallback(
    (pkg, e) => {
      const mod = e.metaKey || e.ctrlKey
      if (e.shiftKey) {
        const anchor = bulkActive ? useLibraryStore.getState().bulkAnchorFilename : selectedDetail?.filename
        rangeBulkSelect(pkg.filename, orderedLibraryFilenames, anchor)
        return
      }
      if (mod || bulkActive) {
        toggleBulkSelect(pkg.filename)
        return
      }
      void runSelectPackage(pkg.filename)
    },
    [
      bulkActive,
      orderedLibraryFilenames,
      rangeBulkSelect,
      selectedDetail?.filename,
      toggleBulkSelect,
      runSelectPackage,
    ],
  )

  const handleLibraryTableRowClick = useCallback(
    (pkg, e) => {
      handleLibraryClick(pkg, e)
    },
    [handleLibraryClick],
  )

  const handleLibraryBulkToggle = useCallback(
    (pkg) => {
      toggleBulkSelect(pkg.filename)
    },
    [toggleBulkSelect],
  )

  const bulkEnabledState = useMemo(() => {
    const items = filtered.filter((p) => bulkSelectedFilenames.includes(p.filename))
    if (!items.length) return { allEnabled: false, allDisabled: false, mixed: false }
    const n = items.filter((p) => isPackageActive(p.storageState)).length
    return {
      allEnabled: n === items.length,
      allDisabled: n === 0,
      mixed: n > 0 && n < items.length,
    }
  }, [filtered, bulkSelectedFilenames])

  const [bulkRemoveOpen, setBulkRemoveOpen] = useState(false)

  const bulkRemoveSummary = useMemo(() => {
    const items = filtered.filter((p) => bulkSelectedFilenames.includes(p.filename))
    const direct = items.filter((p) => p.isDirect)
    const dep = items.filter((p) => !p.isDirect)
    return { items, direct, dep }
  }, [filtered, bulkSelectedFilenames])

  const runBulkToggleEnabled = useCallback(async () => {
    if (useLibraryStore.getState().bulkToggleIntent) return
    const items = filtered.filter((p) => bulkSelectedFilenames.includes(p.filename))
    if (!items.length) return
    const targets = bulkEnabledState.mixed ? items.filter((p) => !isPackageActive(p.storageState)) : items
    if (!targets.length) return
    const enabled = bulkEnabledState.allDisabled || bulkEnabledState.mixed
    useLibraryStore.setState({ bulkToggleIntent: enabled ? 'enable' : 'disable' })
    try {
      const res = await window.api.packages.setEnabled(
        targets.map((p) => p.filename),
        enabled,
      )
      toastIfBulkToggleFailures(res)
      await fetchPackages()
    } catch (err) {
      toast(`Failed: ${err.message}`)
    } finally {
      useLibraryStore.setState({ bulkToggleIntent: null })
    }
  }, [filtered, bulkSelectedFilenames, bulkEnabledState.mixed, bulkEnabledState.allDisabled, fetchPackages])

  const runBulkPromote = useCallback(async () => {
    const fnames = filtered
      .filter((p) => bulkSelectedFilenames.includes(p.filename) && !p.isDirect)
      .map((p) => p.filename)
    if (!fnames.length) return
    try {
      await window.api.packages.promote(fnames.length === 1 ? fnames[0] : fnames, null)
      clearBulkSelection()
      await fetchPackages()
    } catch (err) {
      toast(`Failed: ${err.message}`)
    }
  }, [filtered, bulkSelectedFilenames, clearBulkSelection, fetchPackages])

  const runBulkRemove = useCallback(async () => {
    const { direct, dep } = bulkRemoveSummary
    try {
      if (direct.length) {
        const d = direct.map((p) => p.filename)
        await window.api.packages.uninstall(d.length === 1 ? d[0] : d)
      }
      if (dep.length) {
        const d = dep.map((p) => p.filename)
        await window.api.packages.forceRemove(d.length === 1 ? d[0] : d)
      }
      setBulkRemoveOpen(false)
      clearBulkSelection()
      await fetchPackages()
    } catch (err) {
      toast(`Failed: ${err.message}`)
    }
  }, [bulkRemoveSummary, clearBulkSelection, fetchPackages])

  const runBulkSetType = useCallback(
    async (typeOverride) => {
      const fnames = filtered.filter((p) => bulkSelectedFilenames.includes(p.filename)).map((p) => p.filename)
      if (!fnames.length) return
      try {
        await window.api.packages.setTypeOverride({ filenames: fnames, typeOverride })
        await fetchPackages()
      } catch (err) {
        toast(`Failed: ${err.message}`)
      }
    },
    [filtered, bulkSelectedFilenames, fetchPackages],
  )

  const bulkLabelStateMap = useMemo(() => {
    const items = filtered.filter((p) => bulkSelectedFilenames.includes(p.filename))
    return bulkStateMap(items.map((p) => p.labelIds || []))
  }, [filtered, bulkSelectedFilenames])

  const runBulkLabelToggle = useCallback(
    async (label, currentState) => {
      const fnames = filtered.filter((p) => bulkSelectedFilenames.includes(p.filename)).map((p) => p.filename)
      if (!fnames.length) return
      const apply = currentState !== 'all'
      try {
        await window.api.labels.applyToPackages({ id: label.id, filenames: fnames, applied: apply })
      } catch (err) {
        toast(`Failed to ${apply ? 'apply' : 'remove'} label: ${err.message}`)
      }
    },
    [filtered, bulkSelectedFilenames],
  )

  const runBulkLabelCreate = useCallback(
    async (name) => {
      const fnames = filtered.filter((p) => bulkSelectedFilenames.includes(p.filename)).map((p) => p.filename)
      if (!fnames.length) return
      try {
        const created = await window.api.labels.create({ name })
        await window.api.labels.applyToPackages({ id: created.id, filenames: fnames, applied: true })
      } catch (err) {
        toast(`Failed to create label: ${err.message}`)
      }
    },
    [filtered, bulkSelectedFilenames],
  )

  const selectionAnnouncedLib = bulkActive ? `${bulkSelectedFilenames.length} selected` : ''

  const handleFilterAuthor = useCallback(
    (author) => {
      setAuthorSearch(author)
    },
    [setAuthorSearch],
  )

  const handleKeyboardSelectLibrary = useCallback(
    (pkg) => {
      if (bulkActive) return
      void runSelectPackage(pkg.filename)
    },
    [bulkActive, runSelectPackage],
  )

  useKeyboardNav({
    items: bulkActive ? [] : filtered,
    selectedId: selectedDetail?.filename,
    onSelect: handleKeyboardSelectLibrary,
    onClose: () => {
      if (bulkActive) clearBulkSelection()
    },
    getId: (p) => p.filename,
    columnCount: viewMode !== 'table' ? gridLayout.cols : 1,
  })

  useEffect(() => {
    function onKeyDown(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault()
        selectAllBulk(orderedLibraryFilenames)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [orderedLibraryFilenames, selectAllBulk])

  useEffect(() => {
    if (!bulkActive) return
    function onSpace(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
      if (e.key !== ' ' && e.code !== 'Space') return
      e.preventDefault()
      const fn = useLibraryStore.getState().bulkAnchorFilename
      if (fn == null) return
      useLibraryStore.getState().toggleBulkSelect(fn)
    }
    window.addEventListener('keydown', onSpace, true)
    return () => window.removeEventListener('keydown', onSpace, true)
  }, [bulkActive])

  const libraryTableSelectAllRef = useRef(null)
  useLayoutEffect(() => {
    const el = libraryTableSelectAllRef.current
    if (!el) return
    el.indeterminate = bulkSelectedFilenames.length > 0 && bulkSelectedFilenames.length < filtered.length
  }, [bulkSelectedFilenames, filtered.length])

  return (
    <div className="h-full flex">
      <FilterPanel
        search={search}
        onSearchChange={setSearch}
        smartSearch={{
          authors: authorCounts,
          tags: tagCounts,
          labels,
          types: LIBRARY_FILTER_TYPES,
          flags: LIBRARY_IS_FLAGS,
        }}
        sections={sections}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        {bulkActive && statusFilter !== 'missing' ? (
          <div className="h-10 flex flex-nowrap items-center px-4 border-b border-border shrink-0 gap-3 min-w-0 overflow-x-auto [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:bg-transparent">
            <button
              type="button"
              onClick={() => void runBulkToggleEnabled()}
              disabled={!!bulkToggleIntent}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 py-1 rounded cursor-pointer border border-border hover:bg-elevated text-[11px] text-text-primary disabled:cursor-progress disabled:opacity-70 disabled:hover:bg-transparent"
            >
              {bulkToggleIntent ? (
                <Loader2 size={16} className="shrink-0 animate-spin text-text-tertiary" />
              ) : (
                <Power
                  size={16}
                  className={cn(
                    'shrink-0',
                    bulkEnabledState.mixed
                      ? 'text-text-tertiary'
                      : bulkEnabledState.allDisabled
                        ? 'text-error'
                        : 'text-text-secondary',
                  )}
                />
              )}
              {bulkToggleIntent === 'enable'
                ? 'Enabling…'
                : bulkToggleIntent === 'disable'
                  ? 'Disabling…'
                  : bulkEnabledState.mixed || bulkEnabledState.allDisabled
                    ? 'Enable'
                    : 'Disable'}
            </button>
            <button
              type="button"
              onClick={() => setBulkRemoveOpen(true)}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 py-1 rounded cursor-pointer border border-border text-error hover:bg-error/10 text-[11px]"
            >
              <Trash2 size={16} className="shrink-0" />
              Remove
            </button>
            {bulkRemoveSummary.dep.length > 0 && (
              <button
                type="button"
                onClick={() => void runBulkPromote()}
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 py-1 rounded cursor-pointer border border-border hover:bg-elevated text-accent-blue text-[11px]"
              >
                <Plus size={16} className="shrink-0" />
                Promote
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap h-7 pl-2.5 pr-2 rounded-md cursor-pointer border border-border/90 bg-elevated/60 hover:bg-elevated hover:border-border text-[11px] font-medium text-text-primary shadow-sm transition-colors"
                >
                  Type
                  <ChevronDown size={14} className="text-text-tertiary shrink-0 opacity-90" strokeWidth={2.25} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto min-w-48">
                <DropdownMenuLabel className="text-[11px] px-2 py-1.5">
                  Type ({bulkSelectedFilenames.length})
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-[11px] gap-2 px-2 py-1.5" onSelect={() => void runBulkSetType(null)}>
                  Auto (clear override)
                </DropdownMenuItem>
                {LIBRARY_FILTER_TYPES.map((t) => (
                  <DropdownMenuItem
                    key={t}
                    className="text-[11px] gap-2 px-2 py-1.5"
                    onSelect={() => void runBulkSetType(t)}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ background: TYPE_COLORS[t] }}
                    />
                    {t}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <LabelApplyPopover
              align="end"
              labels={labels}
              stateById={bulkLabelStateMap}
              onToggle={runBulkLabelToggle}
              onCreate={runBulkLabelCreate}
            >
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap h-7 pl-2.5 pr-2 rounded-md cursor-pointer border border-border/90 bg-elevated/60 hover:bg-elevated hover:border-border text-[11px] font-medium text-text-primary shadow-sm transition-colors"
              >
                <Tag size={12} className="text-text-tertiary shrink-0" />
                Labels
                <ChevronDown size={14} className="text-text-tertiary shrink-0 opacity-90" strokeWidth={2.25} />
              </button>
            </LabelApplyPopover>
            <span className="shrink-0 whitespace-nowrap text-[11px] text-text-primary font-medium tabular-nums">
              {bulkSelectedFilenames.length} selected
            </span>
            <div className="flex shrink-0 flex-nowrap items-center gap-2 whitespace-nowrap">
              <button
                type="button"
                className="shrink-0 whitespace-nowrap text-[10px] text-accent-blue hover:brightness-125 transition-[filter] cursor-pointer"
                onClick={() => selectAllBulk(orderedLibraryFilenames)}
              >
                Select all {filtered.length}
              </button>
              <button
                type="button"
                className="shrink-0 whitespace-nowrap text-[10px] text-text-tertiary hover:text-text-secondary cursor-pointer transition-colors"
                onClick={() => clearBulkSelection()}
              >
                Deselect
              </button>
            </div>
            <div className="flex-1 min-w-0" />
            <button
              type="button"
              title="Clear selection"
              aria-label="Clear selection"
              onClick={() => clearBulkSelection()}
              className="p-1.5 rounded cursor-pointer text-text-tertiary hover:text-text-primary hover:bg-elevated shrink-0"
            >
              <X size={16} />
            </button>
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {selectionAnnouncedLib}
            </span>
          </div>
        ) : (
          <div className="h-10 flex flex-nowrap items-center px-4 border-b border-border shrink-0 gap-2 min-w-0 overflow-x-auto [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:bg-transparent">
            <ToolbarActions
              statusFilter={statusFilter}
              statusCounts={statusCounts}
              filtered={filtered}
              updateCheckResults={updateCheckResults}
              updateCheckLoading={updateCheckLoading}
              updateCheckLastChecked={updateCheckLastChecked}
              missingDeps={missingDeps}
              missingDepsLoading={missingDepsLoading}
              hubDetailsLoading={hubDetailsLoading}
              onRefreshMissing={fetchMissingDeps}
              onRefreshUpdates={refreshUpdateCheck}
            />
            <span className="shrink-0 whitespace-nowrap text-[11px] text-text-tertiary">
              {statusFilter === 'missing'
                ? `${missingDeps?.length ?? '…'} missing dependencies`
                : statusFilter === 'updates' && updateCheckResults == null
                  ? `${updateCheckLoading ? '…' : '?'} packages`
                  : `${filtered.length} packages`}
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
                    onClick={() => resetFilters()}
                    title="Reset all filters to their defaults"
                    className="text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
                  >
                    Reset
                  </button>
                  )
                </span>
              </span>
            )}
            <div className="flex-1 min-w-0" />
            {statusFilter !== 'missing' && (
              <div className="flex shrink-0 flex-nowrap items-center gap-2">
                {viewMode !== 'table' && (
                  <ThumbnailSizeSlider
                    cardWidth={cardWidth}
                    availableWidth={gridLayout.availableWidth}
                    onCardWidthChange={setCardWidth}
                  />
                )}
                <div className="flex items-center gap-px bg-elevated rounded p-0.5">
                  <button
                    onClick={() => {
                      setCompactCards(true)
                      setViewMode('grid')
                    }}
                    title="Compact cards"
                    className={`p-1.5 rounded cursor-pointer ${compactCards && viewMode !== 'table' ? 'bg-hover text-text-primary' : 'text-text-tertiary'}`}
                  >
                    <Grid3x3 size={14} />
                  </button>
                  <button
                    onClick={() => {
                      setCompactCards(false)
                      setViewMode('grid')
                    }}
                    title="Detailed cards"
                    className={`p-1.5 rounded cursor-pointer ${!compactCards && viewMode !== 'table' ? 'bg-hover text-text-primary' : 'text-text-tertiary'}`}
                  >
                    <Grid2x2 size={14} />
                  </button>
                  <button
                    onClick={() => setViewMode('table')}
                    title="Table"
                    className={`p-1.5 rounded cursor-pointer ${viewMode === 'table' ? 'bg-hover text-text-primary' : 'text-text-tertiary'}`}
                  >
                    <List size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {statusFilter === 'missing' ? (
          <MissingDepsTable
            data={missingDeps}
            loading={missingDepsLoading}
            hubDetailsLoading={hubDetailsLoading}
            scrollResetKey={scrollResetKey}
            onNavigateBroken={(filename) => {
              setStatusFilter('broken')
              void runSelectPackage(filename)
            }}
          />
        ) : viewMode !== 'table' ? (
          <VirtualGrid
            items={filtered}
            itemWidth={cardWidth}
            itemHeight={compactCards ? cardWidth : cardWidth + 84}
            fixedHeight={compactCards ? 0 : 84}
            className="flex-1"
            scrollResetKey={scrollResetKey}
            selectedIndex={selectedIdx}
            onLayout={setGridLayout}
            onEmptyAreaPointerDown={bulkActive ? () => clearBulkSelection() : undefined}
            renderItem={(pkg) => {
              const updateInfo = updateCheckResults?.[pkg.filename]
              const dimUpdateUnavailable = statusFilter === 'updates' && isUpdateUnavailable(updateInfo)
              return (
                <LibraryPackageContextMenu key={pkg.filename} pkg={pkg} updateInfo={updateInfo} onNavigate={onNavigate}>
                  <LibraryCard
                    pkg={pkg}
                    onClick={handleLibraryClick}
                    selected={!bulkActive && selectedDetail?.filename === pkg.filename}
                    bulkMode={bulkActive}
                    bulkSelected={selectedBulkSet.has(pkg.filename)}
                    onFilterAuthor={handleFilterAuthor}
                    mode={compactCards ? 'minimal' : 'medium'}
                    hideType={selectedTypes.length === 1}
                    dimmed={dimUpdateUnavailable}
                  />
                </LibraryPackageContextMenu>
              )
            }}
          />
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden p-4">
            <div className="border border-border rounded-lg overflow-hidden flex flex-col flex-1 min-h-0">
              <div className="bg-elevated text-[10px] uppercase tracking-wider text-text-tertiary flex border-b border-border shrink-0">
                {bulkActive && (
                  <div className="w-8 shrink-0 flex items-center justify-center border-r border-border/50 py-2">
                    <input
                      ref={libraryTableSelectAllRef}
                      type="checkbox"
                      className="accent-accent-blue cursor-pointer"
                      aria-label="Select all"
                      checked={bulkSelectedFilenames.length > 0 && bulkSelectedFilenames.length === filtered.length}
                      onChange={(e) => {
                        if (e.target.checked) selectAllBulk(orderedLibraryFilenames)
                        else clearBulkSelection()
                      }}
                    />
                  </div>
                )}
                <div className="flex-3 py-2 px-3 font-medium">Package</div>
                <div className="flex-2 py-2 px-3 font-medium">Author</div>
                {selectedTypes.length !== 1 && <div className="flex-1 py-2 px-3 font-medium">Type</div>}
                <div className="flex-1 py-2 px-3 font-medium">Status</div>
                <div className="flex-1 py-2 px-3 font-medium">Size</div>
                <div className="w-16 py-2 px-3 font-medium">Items</div>
                <div className="w-14 py-2 px-3 font-medium">Deps</div>
              </div>
              <VirtualList
                items={filtered}
                rowHeight={37}
                className="flex-1"
                scrollResetKey={scrollResetKey}
                renderRow={(pkg) => {
                  const updateInfo = updateCheckResults?.[pkg.filename]
                  const dimUpdateUnavailable = statusFilter === 'updates' && isUpdateUnavailable(updateInfo)
                  return (
                    <LibraryPackageContextMenu
                      key={pkg.filename}
                      pkg={pkg}
                      updateInfo={updateInfo}
                      onNavigate={onNavigate}
                    >
                      <LibraryTableRow
                        pkg={pkg}
                        onClick={handleLibraryTableRowClick}
                        selected={!bulkActive && selectedDetail?.filename === pkg.filename}
                        bulkMode={bulkActive}
                        bulkSelected={selectedBulkSet.has(pkg.filename)}
                        onBulkToggle={handleLibraryBulkToggle}
                        onFilterAuthor={handleFilterAuthor}
                        hideType={selectedTypes.length === 1}
                        dimmed={dimUpdateUnavailable}
                      />
                    </LibraryPackageContextMenu>
                  )
                }}
              />
            </div>
            {filtered.length === 0 && (
              <div className="text-center py-16 text-text-tertiary text-sm">No packages found</div>
            )}
          </div>
        )}
      </div>

      {statusFilter !== 'missing' &&
        (selectedDetail && !bulkActive ? (
          <LibraryDetailPanel
            pkg={selectedDetail}
            onNavigate={onNavigate}
            onFilterAuthor={handleFilterAuthor}
            updateInfo={updateCheckResults?.[selectedDetail.filename]}
          />
        ) : bulkActive ? (
          <LibraryBulkPanel filtered={filtered} bulkSelectedFilenames={bulkSelectedFilenames} />
        ) : (
          <div className="shrink-0 border-l border-border bg-surface" style={{ width: detailPanelWidth }} />
        ))}

      <AlertDialog open={bulkRemoveOpen} onOpenChange={setBulkRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="select-text cursor-text">
              Remove {bulkRemoveSummary.items.length} package{bulkRemoveSummary.items.length !== 1 ? 's' : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground select-text cursor-text">
                {bulkRemoveSummary.direct.length > 0 && (
                  <p>
                    {bulkRemoveSummary.direct.length} installed package
                    {bulkRemoveSummary.direct.length !== 1 ? 's' : ''} will be uninstalled
                    {bulkRemoveSummary.direct.length > 1 ? '. Packages' : ', or'} demoted to dependency if other
                    packages depend on them.
                  </p>
                )}
                {bulkRemoveSummary.dep.length > 0 && (
                  <p>
                    {bulkRemoveSummary.dep.length} dependenc{bulkRemoveSummary.dep.length !== 1 ? 'ies' : 'y'} will be
                    removed from disk.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void runBulkRemove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// --- Toolbar Actions (contextual per status filter) ---

function ToolbarActions({
  statusFilter,
  statusCounts,
  filtered,
  updateCheckResults,
  updateCheckLoading,
  updateCheckLastChecked,
  missingDeps,
  missingDepsLoading,
  hubDetailsLoading,
  onRefreshMissing,
  onRefreshUpdates,
}) {
  const handleInstallAllMissing = async () => {
    if (!missingDeps?.length) return
    const items = []
    for (const dep of missingDeps) {
      const hub = dep.hub
      if (!hub?.filename || hub.installedLocally || hub.downloadUrl === null) continue
      items.push({ filename: hub.filename, resource_id: hub.resourceId })
    }
    if (items.length === 0) return
    try {
      const result = await window.api.packages.installDepsBatch(items)
      if (result?.queued > 0) toast(`${result.queued} missing dependencies queued`, 'success', 3000)
    } catch (err) {
      toast(`Install failed: ${err.message}`)
    }
  }

  const handleRemoveOrphans = async () => {
    try {
      const result = await window.api.packages.removeOrphans()
      if (result?.count > 0)
        toast(`Removed ${result.count} orphan packages (${formatBytes(result.freedBytes)})`, 'success')
    } catch (err) {
      toast(`Remove failed: ${err.message}`)
    }
  }

  const handleUpdateAll = async () => {
    if (!updateCheckResults) return
    const store = useDownloadStore.getState()
    let queued = 0
    let alreadyKnown = 0
    let pausedFlag = false
    for (const update of Object.values(updateCheckResults)) {
      if (update.localNewerFilename) continue
      if (isUpdateUnavailable(update)) continue
      if (!update.hubResourceId && !update.packageName) continue
      try {
        const r = await store.install(update.hubResourceId, null, true, update.packageName, !!update.isDepUpdate)
        const ins = r?.inserted ?? 0
        if (ins > 0) queued += ins
        else if ((r?.alreadyLocal ?? 0) + (r?.alreadyQueued ?? 0) > 0) alreadyKnown++
        if (r?.paused) pausedFlag = true
      } catch {}
    }
    if (queued > 0) {
      const msg = pausedFlag
        ? `${queued} update${queued !== 1 ? 's' : ''} queued — downloads are paused`
        : `${queued} update${queued !== 1 ? 's' : ''} queued`
      toast(msg, pausedFlag ? 'info' : 'success', pausedFlag ? 4000 : 3000)
    } else if (alreadyKnown > 0) {
      toast(`Nothing new to queue (${alreadyKnown} already on disk or queued)`, 'info', 3500)
    }
  }

  const lastCheckedText = useMemo(() => {
    if (!updateCheckLastChecked) return null
    const mins = Math.round((Date.now() - updateCheckLastChecked) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    return `${Math.round(mins / 60)}h ago`
  }, [updateCheckLastChecked])

  if (statusFilter === 'broken' && statusCounts.broken > 0) {
    return (
      <Button variant="outline" size="xs" onClick={() => useLibraryStore.getState().setStatusFilter('missing')}>
        View Missing Packages
      </Button>
    )
  }

  if (statusFilter === 'missing') {
    const availableCount =
      missingDeps?.filter((d) => d.hub?.filename && !d.hub.installedLocally && d.hub.downloadUrl !== null).length ?? 0
    const anyLoading = missingDepsLoading || hubDetailsLoading
    return (
      <>
        <Button
          variant="gradient"
          size="xs"
          onClick={handleInstallAllMissing}
          disabled={availableCount === 0 || anyLoading}
        >
          Install All Available ({availableCount})
        </Button>
        <button
          type="button"
          onClick={onRefreshMissing}
          disabled={missingDepsLoading}
          title="Re-check Hub availability"
          className="text-text-tertiary hover:text-text-secondary cursor-pointer p-1 transition-colors"
        >
          {anyLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </>
    )
  }

  if (statusFilter === 'orphan' && statusCounts.orphan > 0) {
    const orphanSize = filtered.reduce((sum, p) => sum + (p.sizeBytes || 0), 0)
    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" size="xs">
            Remove All Orphans ({statusCounts.orphan} items, {formatBytes(orphanSize)})
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all orphan dependencies?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  {statusCounts.orphan} orphan dependenc{statusCounts.orphan !== 1 ? 'ies' : 'y'} will be permanently
                  deleted from disk.
                </p>
                <p>These packages are not used by any installed package.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleRemoveOrphans}>
              Remove All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  if (statusFilter === 'updates') {
    const downloadableCount =
      updateCheckResults != null
        ? Object.values(updateCheckResults).filter((u) => !u.localNewerFilename && !isUpdateUnavailable(u)).length
        : null
    return (
      <>
        <Button
          variant="gradient"
          size="xs"
          onClick={handleUpdateAll}
          disabled={updateCheckResults == null || updateCheckLoading || downloadableCount === 0}
        >
          <ArrowUpCircle size={12} /> Update All
          {downloadableCount != null && downloadableCount > 0 ? ` (${downloadableCount})` : ''}
        </Button>
        <button
          type="button"
          onClick={onRefreshUpdates}
          disabled={updateCheckLoading}
          title="Re-check for updates"
          className="text-text-tertiary hover:text-text-secondary cursor-pointer p-1 transition-colors"
        >
          {updateCheckLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
        {lastCheckedText && <span className="text-[10px] text-text-tertiary">Checked {lastCheckedText}</span>}
      </>
    )
  }

  return null
}

// --- Missing Deps Table ---

function MissingDepsTable({ data, loading, hubDetailsLoading, scrollResetKey, onNavigateBroken }) {
  if (!data || data.length === 0) {
    if (loading) {
      return (
        <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm gap-2">
          <Loader2 size={16} className="animate-spin" /> Loading missing dependencies…
        </div>
      )
    }
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">No missing dependencies</div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-4">
      <div className="border border-border rounded-lg overflow-hidden flex flex-col flex-1 min-h-0">
        <div className="bg-elevated text-[10px] uppercase tracking-wider text-text-tertiary flex border-b border-border shrink-0">
          <div className="flex-3 py-2 px-3 font-medium">Package</div>
          <div className="w-32 shrink-0 py-2 px-3 font-medium">Version</div>
          <div className="flex-2 py-2 px-3 font-medium">Author</div>
          <div className="flex-2 py-2 px-3 font-medium">Needed by</div>
          <div className="w-16 py-2 px-3 font-medium text-right">Size</div>
          <div className="w-24 py-2 px-3 font-medium text-right">Status</div>
        </div>
        <VirtualList
          items={data}
          rowHeight={37}
          className="flex-1"
          scrollResetKey={scrollResetKey}
          renderRow={(item) => (
            <MissingDepRow
              key={item.ref}
              item={item}
              hubDetailsLoading={hubDetailsLoading}
              onNavigateBroken={onNavigateBroken}
            />
          )}
        />
      </div>
    </div>
  )
}

const MTAG = 'text-[9px] font-medium px-2 py-0.5 rounded min-w-[4.5rem] text-center inline-block'

function missingDepStatusTag(hub, hubDetailsLoading, dlStatus, dlProgress, onInstall) {
  if (dlStatus === 'active') {
    return (
      <span className={`${MTAG} relative overflow-hidden bg-white/6`}>
        <span
          className="absolute inset-y-0 left-0 progress-bar rounded transition-[width] duration-300"
          style={{ width: `${Math.max(dlProgress, 8)}%` }}
        />
        <span className="relative text-white">{dlProgress}%</span>
      </span>
    )
  }
  if (dlStatus === 'queued')
    return <span className={`${MTAG} text-text-tertiary bg-white/4 animate-pulse`}>Queued</span>
  if (dlStatus === 'failed')
    return (
      <span title="Last download attempt failed" className={`${MTAG} text-error bg-error/8`}>
        Failed
      </span>
    )
  if (hub?.installedLocally)
    return (
      <span
        title="Required version isn't available — using a different installed version as fallback"
        className={`${MTAG} text-warning bg-warning/8`}
      >
        Fallback
      </span>
    )
  if (hub?.filename && !hub.downloadUrl && hubDetailsLoading)
    return <span className={`${MTAG} text-text-tertiary bg-white/4 animate-pulse`}>Checking</span>
  if (hub?.filename && hub.downloadUrl === null)
    return (
      <span
        title="Listed on the hub but not directly downloadable (paid or external)"
        className={`${MTAG} text-text-tertiary bg-white/4`}
      >
        Unavailable
      </span>
    )
  if (hub?.filename) {
    return (
      <button
        type="button"
        onClick={onInstall}
        className={`${MTAG} bg-linear-to-br from-[#3a7cf4] to-[#c740e8] text-white cursor-pointer hover:brightness-110 transition-all`}
      >
        Install
      </button>
    )
  }
  if (hub === null)
    return (
      <span title="Not found on the hub — no install source available" className={`${MTAG} text-error bg-error/8`}>
        Missing
      </span>
    )
  return null
}

function MissingDepRow({ item, hubDetailsLoading, onNavigateBroken }) {
  const hub = item.hub
  const dl = useDownloadStore((s) => {
    if (!hub?.filename) return null
    const d = s.byPackageRef.get(hub.filename) || s.byPackageRef.get(hub.filename.replace(/\.var$/i, ''))
    if (!d || d.status === 'completed' || d.status === 'cancelled') return null
    if (d.status === 'active') return `active|${s.liveProgress[d.id]?.progress ?? 0}`
    return d.status
  })
  const dlStatus = dl?.startsWith('active') ? 'active' : dl
  const dlProgress = dl?.startsWith('active') ? Number(dl.split('|')[1]) || 0 : 0

  const handleInstall = async () => {
    if (!hub?.filename || hub.installedLocally) return
    try {
      await window.api.packages.installDep({
        filename: hub.filename,
        resource_id: hub.resourceId,
      })
    } catch (err) {
      toast(`Install failed: ${err.message}`)
    }
  }

  return (
    <div className="flex items-center hover:bg-elevated transition-colors text-xs">
      <div className="flex-3 py-2 px-3 truncate">
        <span className="text-text-primary select-text cursor-text">{item.displayName}</span>
      </div>
      <div className="w-32 shrink-0 py-2 px-3 truncate text-text-tertiary select-text cursor-text">
        {item.version === 'latest'
          ? 'any'
          : item.version === 'min'
            ? `v${item.minVersion}+`
            : item.version
              ? `v${item.version}`
              : '—'}
        {item.isFallback && item.fallbackVersion && (
          <span className="text-text-quaternary text-[10px]"> — have v{item.fallbackVersion}</span>
        )}
        {!hub?.isExact && hub?.hubVersion && !hub.installedLocally && (
          <span className="text-text-quaternary text-[10px]"> → v{hub.hubVersion}</span>
        )}
      </div>
      <div className="flex-2 py-2 px-3 truncate text-text-secondary">{item.creator}</div>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex-2 py-2 px-3 truncate text-text-secondary">
            {item.neededBy.slice(0, 3).map((n, i) => (
              <span key={n.filename}>
                {i > 0 && ', '}
                <button
                  type="button"
                  className="text-accent-blue hover:brightness-125 cursor-pointer transition-[filter]"
                  onClick={() => onNavigateBroken(n.filename)}
                >
                  {n.name}
                </button>
              </span>
            ))}
            {item.neededBy.length > 3 && (
              <>
                {', '}
                <span className="text-text-tertiary">+{item.neededBy.length - 3}</span>
              </>
            )}
          </div>
        </TooltipTrigger>
        {item.neededBy.length > 1 && (
          <TooltipContent side="bottom" className="whitespace-pre text-left">
            {item.neededBy
              .slice(0, 20)
              .map((n) => n.name)
              .join('\n')}
            {item.neededBy.length > 20 ? `\n…and ${item.neededBy.length - 20} more` : ''}
          </TooltipContent>
        )}
      </Tooltip>
      <div className="w-16 py-2 px-3 text-right text-text-tertiary">
        {hub?.fileSize ? formatBytes(hub.fileSize) : '—'}
      </div>
      <div className="w-24 py-2 px-3 flex justify-end">
        {missingDepStatusTag(hub, hubDetailsLoading, dlStatus, dlProgress, handleInstall)}
      </div>
    </div>
  )
}

function LibraryBulkPanel({ filtered, bulkSelectedFilenames }) {
  const [panelWidth] = usePersistedPanelWidth('panel_width_detail', {
    min: 260,
    max: 500,
    defaultWidth: 340,
  })
  const selected = filtered.filter((p) => bulkSelectedFilenames.includes(p.filename))
  const totalSize = selected.reduce((s, p) => s + (p.sizeBytes || 0), 0)
  return (
    <div className="shrink-0 border-l border-border bg-surface" style={{ width: panelWidth }}>
      <div className="p-4">
        <div className="text-sm font-semibold text-text-primary">
          {selected.length} package{selected.length !== 1 ? 's' : ''} selected
        </div>
        <div className="text-[11px] text-text-tertiary mt-1">{formatBytes(totalSize)}</div>
      </div>
    </div>
  )
}

// --- Detail Panel ---

function LibraryPackageTypeBadgeMenu({ pkg, kindLabel, kindIsCore }) {
  const autoBucketLabel = libraryTypeBadgeLabel(pkg.derivedType || pkg.hubType)
  const handleSelect = async (value) => {
    try {
      if (value === '__clear') {
        await window.api.packages.setTypeOverride(pkg.filename, null)
      } else {
        await window.api.packages.setTypeOverride(pkg.filename, value)
      }
      await useLibraryStore.getState().fetchPackages()
      await useLibraryStore.getState().refreshDetail()
    } catch (err) {
      toast(`Failed to update package type: ${err.message}`)
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            THUMB_OVERLAY_CHIP,
            'text-white cursor-pointer',
            kindIsCore ? '' : 'max-w-[min(100%,14rem)] truncate',
          )}
          title={kindIsCore ? 'Change package type' : kindLabel}
          style={{ background: (kindIsCore ? TYPE_COLORS[kindLabel] : TYPE_COLORS.Other) + 'cc' }}
        >
          {kindLabel}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={3}
        className="min-w-28 max-w-33 p-0.5 text-[10px] leading-snug"
      >
        <DropdownMenuLabel className="px-2 py-0.5 text-[10px]">Set type</DropdownMenuLabel>
        {LIBRARY_FILTER_TYPES.map((t) => (
          <DropdownMenuItem key={t} onSelect={() => void handleSelect(t)} className="gap-2 px-2 py-1 text-[10px]">
            <span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ background: TYPE_COLORS[t] }} />
            {t}
          </DropdownMenuItem>
        ))}
        {pkg.typeOverride != null && (
          <>
            <DropdownMenuSeparator className="my-0.5" />
            <DropdownMenuItem onSelect={() => void handleSelect('__clear')} className="px-2 py-1 text-[10px]">
              Auto ({autoBucketLabel})
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UpdateActions({ pkg, updateInfo }) {
  const [promoting, setPromoting] = useState(false)
  const updateState = useLibraryUpdateState(pkg, updateInfo)
  const checking = isUpdateChecking(updateInfo)

  const handlePromote = async () => {
    if (promoting) return
    setPromoting(true)
    try {
      await window.api.packages.uninstall(pkg.filename)
      await window.api.packages.promote(updateInfo.localNewerFilename)
      await useLibraryStore.getState().fetchPackages()
      await useLibraryStore.getState().selectPackage(updateInfo.localNewerFilename)
      toast(`Updated to v${updateInfo.hubVersion}`, 'success', 2500)
    } catch (err) {
      toast(`Update failed: ${err.message}`)
    } finally {
      setPromoting(false)
    }
  }

  if (updateInfo.localNewerFilename) {
    return (
      <div className="flex gap-1.5">
        <Button
          variant="gradient"
          size="sm"
          onClick={handlePromote}
          disabled={promoting}
          className="flex-1 min-w-0 text-[11px]"
        >
          {promoting ? (
            <>
              <Loader2 size={11} className="animate-spin" /> Updating…
            </>
          ) : (
            <>
              <ArrowUpCircle size={11} /> Update to v{updateInfo.hubVersion}
            </>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => useLibraryStore.getState().selectPackage(updateInfo.localNewerFilename)}
          disabled={promoting}
          className="shrink-0 text-[11px] px-2.5 border-text-secondary/25 text-text-primary"
        >
          <Eye size={11} /> Go to
        </Button>
      </div>
    )
  }

  if (isUpdateUnavailable(updateInfo)) {
    return (
      <div className="rounded border border-border bg-elevated/40 px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-text-secondary">
          <ArrowUpCircle size={11} className="shrink-0" /> v{updateInfo.hubVersion} unavailable
        </div>
        <p className="text-[10px] text-text-tertiary mt-1 leading-relaxed">
          A newer version is listed on the hub but is not directly downloadable — typically because it is a paid
          resource or hosted externally.
        </p>
      </div>
    )
  }

  const busy = updateState.state === 'pending' || updateState.state === 'queued' || updateState.state === 'downloading'
  return (
    <Button
      variant="gradient"
      size="sm"
      onClick={() => useDownloadStore.getState().installUpdate(pkg, updateInfo)}
      disabled={busy || checking || (!updateInfo.hubResourceId && !updateInfo.packageName)}
      className="w-full text-[11px]"
    >
      {checking ? (
        <>
          <Loader2 size={11} className="animate-spin" /> Checking v{updateInfo.hubVersion}…
        </>
      ) : updateState.state === 'pending' ? (
        <>
          <Loader2 size={11} className="animate-spin" /> Queuing…
        </>
      ) : updateState.state === 'queued' ? (
        <>
          <Loader2 size={11} className="animate-spin" /> Queued
        </>
      ) : updateState.state === 'downloading' ? (
        <>
          <Loader2 size={11} className="animate-spin" /> Downloading {Math.round((updateState.progress ?? 0) * 100)}%
        </>
      ) : (
        <>
          <ArrowUpCircle size={11} /> Update to v{updateInfo.hubVersion}
        </>
      )}
    </Button>
  )
}

function LibraryDetailPanel({ pkg, onNavigate, onFilterAuthor, updateInfo }) {
  const galleryVisibilityFilter = useContentStore((s) => s.visibilityFilter)
  const [panelWidth, setPanelWidth] = usePersistedPanelWidth('panel_width_detail', {
    min: 260,
    max: 500,
    defaultWidth: 340,
  })
  const startWidthRef = useRef(panelWidth)
  const onResizeStart = useCallback(() => {
    startWidthRef.current = panelWidth
  }, [panelWidth])
  const onPanelResize = useCallback(
    (delta) => setPanelWidth(Math.min(500, Math.max(260, startWidthRef.current + delta))),
    [setPanelWidth],
  )

  const name = displayName(pkg)
  const thumbUrl = useThumbnail(`pkg:${pkg.filename}`)
  const grouped = {}
  ;(pkg.contents || []).forEach((c) => {
    if (!grouped[c.category]) grouped[c.category] = []
    grouped[c.category].push(c)
  })
  // Flat, display-ordered gallery so arrow keys step through every content
  // thumbnail in the section (across categories) once the lightbox is open.
  const contentGallery = useMemo(() => {
    const g = {}
    ;(pkg.contents || []).forEach((c) => {
      if (!g[c.category]) g[c.category] = []
      g[c.category].push(c)
    })
    const types = Object.keys(g).sort(compareContentTypes)
    return buildContentGallery(types.flatMap((t) => g[t]))
  }, [pkg.contents])

  const hasDependents = pkg.dependents?.length > 0
  const suppressDisablePackageWarning = useLibraryStore((s) => s.suppressDisablePackageWarning)
  const showDisableDialog = packageNeedsDisableConfirmation(pkg, suppressDisablePackageWarning)
  const contentCount = pkg.contents?.length ?? 0
  const hasContent = contentCount > 0
  const hiddenContentCount = (pkg.contents || []).filter((c) => c.hidden).length
  const dependentNames = hasDependents
    ? pkg.dependents
        .slice(0, 2)
        .map((d) => d.packageName?.split('.').pop() || d.filename)
        .join(', ') + (pkg.dependents.length > 2 ? ` +${pkg.dependents.length - 2}` : '')
    : ''

  const kindLabel = pkg.type || pkg.hubType
  const kindIsCore = kindLabel ? isCoreLibraryCategory(kindLabel) : false
  const [fileTreeOpen, setFileTreeOpen] = useState(false)
  const [redownloading, setRedownloading] = useState(false)
  const forceRemoveActionsRowRef = useRef(null)
  const [shortForceRemoveLabel, setShortForceRemoveLabel] = useState(false)

  useLayoutEffect(() => {
    if (!hasDependents || pkg.isDirect) return
    const el = forceRemoveActionsRowRef.current
    if (!el) return
    const MIN_ROW_PX_FOR_FULL_FORCE_REMOVE = 320
    const measure = () => setShortForceRemoveLabel(el.clientWidth < MIN_ROW_PX_FOR_FULL_FORCE_REMOVE)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasDependents, pkg.isDirect, pkg.dependents?.length, pkg.filename])

  const handleSelectPackage = useCallback((filename) => {
    useLibraryStore.getState().selectPackage(filename)
  }, [])

  const handleToggleEnabled = async () => {
    try {
      const res = await window.api.packages.toggleEnabled(pkg.filename)
      toastIfSingleToggleFailed(res)
    } catch (err) {
      toast(`Failed to toggle package: ${err.message}`)
    }
  }
  const handleEnableInactiveDeps = async () => {
    try {
      const res = await window.api.packages.enableDeps(pkg.filename)
      if (res?.count > 0) toast(`Enabled ${res.count} dependenc${res.count === 1 ? 'y' : 'ies'}`, 'success')
    } catch (err) {
      toast(`Failed to enable dependencies: ${err.message}`)
    }
  }
  const handlePromote = async () => {
    try {
      await window.api.packages.promote(pkg.filename)
    } catch (err) {
      toast(`Failed to promote package: ${err.message}`)
    }
  }
  const handleUninstall = async () => {
    try {
      await window.api.packages.uninstall(pkg.filename)
    } catch (err) {
      toast(`Uninstall failed: ${err.message}`)
    }
  }
  const handleForceRemove = async () => {
    try {
      await window.api.packages.forceRemove(pkg.filename)
    } catch (err) {
      toast(`Remove failed: ${err.message}`)
    }
  }
  const handleRedownload = async () => {
    if (redownloading) return
    setRedownloading(true)
    try {
      await window.api.packages.redownload(pkg.filename)
      toast('Package redownloaded and verified', 'success')
    } catch (err) {
      toast(`Redownload failed: ${err.message}`)
    } finally {
      setRedownloading(false)
    }
  }

  return (
    <div className="flex shrink-0" style={{ width: panelWidth }}>
      <ResizeHandle side="left" onResizeStart={onResizeStart} onResize={onPanelResize} />
      <div className="flex-1 min-w-0 border-l border-border bg-surface overflow-y-auto">
        {/* Header */}
        <div className="p-4 border-b border-border">
          <div className="flex items-start gap-3">
            <div
              className={`w-14 h-14 rounded shrink-0 relative overflow-hidden${thumbUrl ? ' cursor-pointer' : ''}`}
              onClick={() => openLightbox(thumbUrl)}
            >
              <div className="absolute inset-0" style={{ background: getGradient(pkg.filename) }} />
              {thumbUrl && <img src={thumbUrl} className="thumb absolute inset-0 w-full h-full object-cover" alt="" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-sm font-semibold text-text-primary truncate select-text cursor-text">{name}</span>
                <span className="text-[11px] text-text-tertiary shrink-0 select-text cursor-text">v{pkg.version}</span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <AuthorAvatar author={pkg.creator} userId={pkg.hubUserId} size={16} />
                <span className="text-[11px] text-text-secondary">
                  by <AuthorLink author={pkg.creator} onFilterAuthor={onFilterAuthor} />
                </span>
                {isPromotionalLink(pkg.promotionalLink) && (
                  <button
                    type="button"
                    title={pkg.promotionalLink}
                    onClick={() => void openExternalLink(pkg.promotionalLink)}
                    className="flex items-center gap-1 text-[10px] text-accent-blue hover:brightness-125 transition-[filter] cursor-pointer ml-1 shrink-0"
                  >
                    <Heart size={9} /> Support
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1 mt-1 flex-wrap">
                {kindLabel && <LibraryPackageTypeBadgeMenu pkg={pkg} kindLabel={kindLabel} kindIsCore={kindIsCore} />}
                {!pkg.isDirect && (
                  <span className={cn(THUMB_OVERLAY_CHIP, 'bg-accent-blue/20 text-accent-blue')}>DEP</span>
                )}
                <StorageStateChip storageState={pkg.storageState ?? 'enabled'} />
                {pkg.isCorrupted && <span className={cn(THUMB_OVERLAY_CHIP, 'bg-error/20 text-error')}>CORRUPTED</span>}
                {pkg.isLocalOnly && (
                  <span className={cn(THUMB_OVERLAY_CHIP, 'bg-text-tertiary/15 text-text-secondary')}>LOCAL</span>
                )}
                {pkg.license && <LicenseTag license={pkg.license} />}
                {pkg.morphCount > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          THUMB_CHIP_BOX,
                          'normal-case tracking-normal gap-0.5 bg-text-tertiary/15 text-text-secondary cursor-default whitespace-nowrap',
                        )}
                      >
                        <Blend size={9} className="inline opacity-80 shrink-0" /> {pkg.morphCount} morphs
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="block max-w-60 text-left">
                      Morphs are the primary thing that slows down VaM. This count includes the package and its{' '}
                      <em>unique</em> dependencies.
                    </TooltipContent>
                  </Tooltip>
                )}
                {(pkg.labelIds || []).length === 0 && (
                  <AddLabelButton
                    appliedIds={pkg.labelIds || []}
                    onApplyToTarget={(id, applied) =>
                      window.api.labels.applyToPackages({ id, filenames: [pkg.filename], applied })
                    }
                  />
                )}
              </div>
            </div>
          </div>

          {(pkg.labelIds || []).length > 0 && (
            <div className="mt-3">
              <LabelsRow
                appliedIds={pkg.labelIds}
                onApplyToTarget={(id, applied) =>
                  window.api.labels.applyToPackages({ id, filenames: [pkg.filename], applied })
                }
              />
            </div>
          )}

          {/* Actions */}
          <div className="mt-3 space-y-1.5">
            {updateInfo && <UpdateActions pkg={pkg} updateInfo={updateInfo} />}
            {pkg.isCorrupted && !pkg.isLocalOnly && (
              <Button
                variant="gradient"
                size="sm"
                onClick={handleRedownload}
                disabled={redownloading}
                className="w-full text-[11px]"
              >
                {redownloading ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                {redownloading ? 'Redownloading…' : 'Redownload'}
              </Button>
            )}
            {pkg.hubResourceId && (
              <Button
                variant="outline"
                onClick={() =>
                  onNavigate?.('hub', {
                    openResource: {
                      resource_id: pkg.hubResourceId,
                      title: displayName(pkg),
                      username: pkg.creator,
                      type: pkg.hubType || pkg.derivedType || pkg.type,
                    },
                  })
                }
                className="w-full text-[11px] border-accent-blue/30 text-accent-blue hover:bg-accent-blue/10"
              >
                <Compass size={12} /> View on Hub
              </Button>
            )}
            {pkg.isDirect ? (
              <div>
                <div className="flex gap-1.5">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant={hasDependents ? 'outline' : 'destructive'}
                        className={`flex-1 min-w-0 text-[11px] ${hasDependents ? 'border-text-secondary/25 text-text-primary' : ''}`}
                      >
                        <Trash2 size={12} />
                        {hasDependents ? (
                          'Remove'
                        ) : (
                          <>Uninstall &middot; {formatBytes(pkg.sizeBytes + (pkg.removableSize || 0))}</>
                        )}
                      </Button>
                    </AlertDialogTrigger>
                    <UninstallDialogContent
                      pkg={pkg}
                      name={name}
                      hasDependents={hasDependents}
                      dependentNames={dependentNames}
                      onConfirm={handleUninstall}
                    />
                  </AlertDialog>
                  {isPackageActive(pkg.storageState) && showDisableDialog ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          className={`shrink-0 text-[10px] px-2.5 border-text-secondary/25 text-text-primary`}
                        >
                          <Power size={11} />
                          Disable
                        </Button>
                      </AlertDialogTrigger>
                      <DisablePackageDialogContent pkg={pkg} name={name} onConfirm={handleToggleEnabled} />
                    </AlertDialog>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={handleToggleEnabled}
                      className={`shrink-0 text-[10px] px-2.5 ${!isPackageActive(pkg.storageState) ? 'border-warning/50 text-warning hover:bg-warning/15' : 'border-text-secondary/25 text-text-primary'}`}
                    >
                      <Power size={11} />
                      {isPackageActive(pkg.storageState) ? 'Disable' : 'Enable'}
                    </Button>
                  )}
                </div>
                <p className="text-[10px] text-text-tertiary mt-1 leading-relaxed px-0.5">
                  {hasDependents ? (
                    <>Used by {dependentNames}. Stays as dependency, content auto-hidden.</>
                  ) : pkg.removableSize > 0 ? (
                    <>
                      Frees {formatBytes(pkg.sizeBytes)} + {formatBytes(pkg.removableSize)} from unused deps
                    </>
                  ) : (
                    <>Frees {formatBytes(pkg.sizeBytes)}</>
                  )}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div>
                  <Button variant="gradient" onClick={handlePromote} className="w-full text-[11px]">
                    <Plus size={12} /> Add to Library
                  </Button>
                  {hiddenContentCount > 0 && (
                    <p className="text-[10px] text-text-tertiary mt-1 px-0.5">
                      Unhides {hiddenContentCount} content item{hiddenContentCount !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
                <div className="flex gap-1.5" ref={forceRemoveActionsRowRef}>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant={hasDependents ? 'outline' : 'destructive-outline'}
                        size="sm"
                        title={
                          hasDependents && shortForceRemoveLabel
                            ? `Force remove — breaks ${pkg.dependents.length} package${pkg.dependents.length !== 1 ? 's' : ''}`
                            : undefined
                        }
                        className={`flex-1 min-w-0 text-[10px] ${hasDependents ? 'text-text-tertiary hover:border-error/30 hover:text-error/70' : ''}`}
                      >
                        <Trash2 size={10} />
                        {hasDependents ? (
                          shortForceRemoveLabel ? (
                            'Force remove'
                          ) : (
                            <>
                              Force remove &mdash; breaks {pkg.dependents.length} package
                              {pkg.dependents.length !== 1 ? 's' : ''}
                            </>
                          )
                        ) : (
                          'Remove'
                        )}
                      </Button>
                    </AlertDialogTrigger>
                    <ForceRemoveDialogContent
                      pkg={pkg}
                      name={name}
                      hasDependents={hasDependents}
                      onConfirm={handleForceRemove}
                    />
                  </AlertDialog>
                  {isPackageActive(pkg.storageState) && showDisableDialog ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0 text-[10px] px-2.5 border-text-secondary/33 text-text-primary"
                        >
                          <Power size={11} />
                          Disable
                        </Button>
                      </AlertDialogTrigger>
                      <DisablePackageDialogContent pkg={pkg} name={name} onConfirm={handleToggleEnabled} />
                    </AlertDialog>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleToggleEnabled}
                      className={`shrink-0 text-[10px] px-2.5 ${!isPackageActive(pkg.storageState) ? 'border-warning/50 text-warning hover:bg-warning/15' : 'border-text-secondary/33 text-text-primary'}`}
                    >
                      <Power size={11} />
                      {isPackageActive(pkg.storageState) ? 'Disable' : 'Enable'}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Description */}
        {pkg.description && (
          <div className="px-4 py-3 border-b border-border">
            <p className="text-[11px] text-text-secondary leading-relaxed select-text cursor-text">
              {pkg.description.length > 300 ? pkg.description.slice(0, 300).trimEnd() + '…' : pkg.description}
            </p>
          </div>
        )}

        {/* Dependencies */}
        {pkg.deps?.length > 0 && (
          <div className="p-4 border-b border-border">
            <DepList
              items={pkg.deps}
              depCount={pkg.depCount}
              missingDeps={pkg.missingDeps}
              inactiveDeps={isPackageActive(pkg.storageState) ? pkg.inactiveDeps : 0}
              onInstallMissing={() => useDownloadStore.getState().installMissing(pkg.filename)}
              onEnableInactive={handleEnableInactiveDeps}
              onSelectPackage={handleSelectPackage}
            />
          </div>
        )}

        {/* Dependents */}
        {pkg.dependents?.length > 0 && (
          <div className="p-4 border-b border-border">
            <div className="text-[11px] font-medium text-text-primary mb-2">
              Used by <span className="text-text-tertiary font-normal">({pkg.dependents.length})</span>
            </div>
            <DependentsList items={pkg.dependents} onSelectPackage={handleSelectPackage} />
          </div>
        )}

        {/* Content */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
            <span className="text-[11px] font-medium text-text-primary">
              Content{' '}
              <span className="text-text-tertiary font-normal">
                {hasContent ? `(${contentCount})` : '(none detected)'}
              </span>
            </span>
            <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={() => setFileTreeOpen(true)}
                className="text-[10px] text-text-tertiary hover:text-accent-blue transition-colors cursor-pointer flex items-center gap-1"
              >
                <FolderTree size={11} /> Browse files
              </button>
              {hasContent && (
                <button
                  type="button"
                  onClick={() => onNavigate?.('content', { filterByPackage: pkg.packageName || pkg.filename })}
                  className="text-[10px] text-accent-blue hover:brightness-125 transition-[filter] cursor-pointer flex items-center gap-1"
                >
                  <LayoutGrid size={11} /> View in gallery
                </button>
              )}
            </div>
          </div>
          {hasContent && (
            <div className="space-y-2">
              {Object.entries(grouped)
                .sort(([a], [b]) => compareContentTypes(a, b))
                .map(([type, items]) => (
                  <ContentCategory
                    key={type}
                    items={items}
                    label={type}
                    gallery={contentGallery}
                    suppressHiddenRowStyle={galleryVisibilityFilter === 'hidden'}
                  />
                ))}
            </div>
          )}
        </div>

        <FileTreeDialog open={fileTreeOpen} onOpenChange={setFileTreeOpen} filename={pkg.filename} />
      </div>
    </div>
  )
}

// --- Dep / Dependent lists ---

/** Matches depStatusTag in PackageCard: higher = worse (sort descending). */
function depBadnessRank(dep, byPackageRef) {
  const d = byPackageRef.get(dep.ref)
  let dl = null
  if (d && d.status !== 'completed' && d.status !== 'cancelled') {
    dl = d.status === 'active' ? 'active' : d.status
  }
  // Missing (95) bubbles first; disabled/offloaded (85) second among problem deps.
  if (dep.resolution === 'exact' || dep.resolution === 'latest') {
    if (dep.storageState === 'disabled' || dep.storageState === 'offloaded') return 85
    return 0
  }
  if (dep.resolution === 'fallback') return 72
  if (dl === 'active') return 45
  if (dl === 'queued') return 58
  if (dl === 'failed') return 100
  if (dep.resolution === 'hub') return 32
  return 95
}

function aggregateDepBadness(dep, byPackageRef) {
  let m = depBadnessRank(dep, byPackageRef)
  for (const c of dep.children || []) {
    const cm = aggregateDepBadness(c, byPackageRef)
    if (cm > m) m = cm
  }
  return m
}

function sortDepTree(items, byPackageRef) {
  if (!items?.length) return items
  return [...items]
    .map((node) => ({ ...node, children: sortDepTree(node.children, byPackageRef) }))
    .sort((a, b) => {
      const diff = aggregateDepBadness(b, byPackageRef) - aggregateDepBadness(a, byPackageRef)
      if (diff !== 0) return diff
      const selfDiff = depBadnessRank(b, byPackageRef) - depBadnessRank(a, byPackageRef)
      if (selfDiff !== 0) return selfDiff
      return a.ref.localeCompare(b.ref)
    })
}

/** Drop branches with no ref match; keep ancestors on paths to at least one match. */
function pruneDepTreeForFilter(items, terms) {
  if (!items?.length) return items
  const out = []
  for (const dep of items) {
    const childPruned = dep.children?.length ? pruneDepTreeForFilter(dep.children, terms) : []
    const selfMatch = haystacksMatchAllTerms([dep.ref], terms)
    if (!selfMatch && !childPruned.length) continue
    out.push({
      ...dep,
      children: childPruned.length ? childPruned : undefined,
    })
  }
  return out
}

function flattenDepRows(items, depth = 0) {
  const out = []
  for (const dep of items) {
    out.push({ dep, depth })
    if (dep.children?.length) out.push(...flattenDepRows(dep.children, depth + 1))
  }
  return out
}

/**
 * Well-header issue chip: a calm amber status that reveals an inline fix-all link
 * on hover (via an interactive hover-card), so stray hovers never reflow the header.
 */
function DepIssueAction({ Icon, label, description, actionLabel, onAction }) {
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span className="flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap text-[10px] leading-none text-warning transition-[filter] hover:brightness-125">
          <Icon size={10} className="shrink-0" /> {label}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="max-w-[220px]">
        <p className="text-[11px] leading-snug text-text-secondary">
          {description}{' '}
          <button
            type="button"
            onClick={onAction}
            className="cursor-pointer font-medium text-accent-blue transition-[filter] hover:brightness-125"
          >
            {actionLabel}
          </button>
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}

function DepList({
  items,
  depCount,
  missingDeps,
  inactiveDeps = 0,
  onInstallMissing,
  onEnableInactive,
  onSelectPackage,
}) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const byPackageRef = useDownloadStore((s) => s.byPackageRef)
  const sorted = useMemo(() => sortDepTree(items, byPackageRef), [items, byPackageRef])
  const flat = useMemo(() => flattenDepRows(sorted), [sorted])
  const total = flat.length
  const collapsible = total > 4
  const isExpanded = expanded || !collapsible
  const showSearch = isExpanded && total >= 10

  const filteredFlat = useMemo(() => {
    if (!query.trim()) return flat
    const terms = searchAndTerms(query)
    return flattenDepRows(pruneDepTreeForFilter(sorted, terms))
  }, [flat, sorted, query])

  const visible = isExpanded ? filteredFlat : flat.slice(0, 3)
  const remaining = expanded ? 0 : collapsible ? Math.max(0, total - 3) : 0

  const handleCollapse = () => {
    setExpanded(false)
    setQuery('')
  }

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setQuery('')
      e.currentTarget.blur()
    }
  }

  return (
    <div>
      <div className="sticky top-0 z-10 bg-surface -mx-4 px-4 -mt-4 pt-4 pb-2 flex items-center justify-between gap-2 min-w-0 flex-nowrap">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {showSearch ? (
            <div className="relative flex-1 min-w-0 h-6">
              <Search
                size={11}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={`Filter ${total} dependencies…`}
                className="w-full h-6 pl-7 pr-7 text-[11px] bg-elevated rounded border border-border text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue/40"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  title="Clear filter"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary cursor-pointer"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          ) : (
            <div className="flex h-6 min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:thin]">
              <span className="shrink-0 whitespace-nowrap text-[11px] font-medium text-text-primary">
                Dependencies <span className="text-text-tertiary font-normal">({depCount})</span>
              </span>
            </div>
          )}
        </div>
        {/* Each issue reads as a calm, static amber status. Hovering it opens an interactive
            hover-card holding an inline fix-all link — so accidental mouse-overs cause no
            motion in the header, and the action is one deliberate move away. */}
        <div className="flex shrink-0 items-center gap-2">
          {!showSearch && inactiveDeps > 0 && onEnableInactive && (
            <DepIssueAction
              Icon={Power}
              label={`${inactiveDeps} disabled`}
              description={`${inactiveDeps} dependenc${inactiveDeps === 1 ? 'y is' : 'ies are'} disabled or offloaded.`}
              actionLabel="Enable all"
              onAction={onEnableInactive}
            />
          )}
          {!showSearch && missingDeps > 0 && (
            <DepIssueAction
              Icon={AlertTriangle}
              label={`${missingDeps} missing`}
              description={`${missingDeps} dependenc${missingDeps === 1 ? 'y is' : 'ies are'} missing.`}
              actionLabel="Install all"
              onAction={onInstallMissing}
            />
          )}
          {expanded && collapsible && (
            <button
              type="button"
              onClick={handleCollapse}
              title="Collapse"
              className="shrink-0 cursor-pointer p-0.5 text-text-tertiary hover:text-text-secondary transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="border border-border rounded overflow-hidden divide-y divide-border">
        {visible.length === 0 ? (
          <div className="px-2 py-2 text-[10px] text-text-tertiary text-center">No matches</div>
        ) : (
          visible.map(({ dep, depth }, i) => (
            <DepRow
              key={`${dep.ref}-${depth}-${i}`}
              dep={dep}
              depth={depth}
              renderChildren={false}
              onNavigate={onSelectPackage}
            />
          ))
        )}
        {!expanded && remaining >= 2 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full px-2 py-1.5 text-[10px] text-text-tertiary hover:bg-elevated hover:text-text-secondary cursor-pointer text-center transition-colors"
          >
            + {remaining} more
          </button>
        )}
      </div>
      {expanded && collapsible && (
        <div className="sticky bottom-0 z-10 -mx-4 -mb-4 px-4 pb-4 bg-surface">
          <button
            type="button"
            onClick={handleCollapse}
            title="Collapse"
            className="w-full px-2 py-1.5 text-[10px] text-text-tertiary hover:bg-elevated hover:text-text-secondary cursor-pointer text-center transition-colors flex items-center justify-center"
          >
            <ChevronUp size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

function DependentsList({ items, onSelectPackage }) {
  const [expanded, setExpanded] = useState(false)
  const total = items.length
  const collapsible = total > 4
  const visible = expanded || !collapsible ? items : items.slice(0, 3)
  const remaining = expanded ? 0 : collapsible ? Math.max(0, total - 3) : 0

  return (
    <div className="border border-border rounded overflow-hidden divide-y divide-border">
      {visible.map((dep, i) => (
        <div
          key={dep.filename || i}
          onClick={dep.filename ? () => onSelectPackage?.(dep.filename) : undefined}
          className={`py-1.5 px-2.5 hover:bg-elevated transition-colors text-[11px] min-w-0 truncate ${dep.filename ? 'cursor-pointer' : ''}`}
        >
          <span className="text-text-primary">{dep.packageName?.split('.').pop() || dep.filename}</span>
          {dep.creator && <span className="text-text-tertiary"> by {dep.creator}</span>}
        </div>
      ))}
      {!expanded && remaining >= 2 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full px-2 py-1.5 text-[10px] text-text-tertiary hover:bg-elevated hover:text-text-secondary cursor-pointer text-center transition-colors"
        >
          + {remaining} more
        </button>
      )}
      {expanded && collapsible && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full py-1 flex items-center justify-center text-text-tertiary hover:bg-elevated hover:text-text-secondary cursor-pointer transition-colors"
        >
          <ChevronUp size={14} />
        </button>
      )}
    </div>
  )
}
