import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  Grid3x3,
  Grid2x2,
  List,
  AlertTriangle,
  Eye,
  EyeOff,
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
  X,
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { toast } from '../components/Toast'
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
} from '../components/ui/alert-dialog'
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
} from '../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { useThumbnail } from '../hooks/useThumbnail'
import { useLibraryStore } from '../stores/useLibraryStore'
import { useContentStore } from '../stores/useContentStore'
import { useDownloadStore } from '../stores/useDownloadStore'
import FilterPanel from '../components/FilterPanel'
import ResizeHandle from '../components/ResizeHandle'
import { LibraryCard, LibraryTableRow, DepRow, AuthorAvatar, AuthorLink } from '../components/PackageCard'
import { ContentCategory } from '../components/ContentCategory'
import FileTreeDialog from '../components/FileTreeDialog'
import { openLightbox } from '../components/ThumbnailLightbox'
import { VirtualGrid, VirtualList } from '../components/VirtualGrid'
import { ThumbnailSizeSlider } from '../components/ThumbnailSizeSlider'
import { useKeyboardNav } from '../hooks/useKeyboardNav'
import { usePersistedPanelWidth } from '../hooks/usePersistedPanelWidth'
import {
  COMMERCIAL_USE_ALLOWED_LICENSE_FILTER,
  LICENSE_FILTER_OPTIONS,
  canonicalizeLicense,
  isCommercialUseAllowed,
} from '../lib/licenses'
import { haystacksMatchAllTerms, searchAndTerms } from '../../../shared/search-text.js'
import { LicenseTag } from '../components/LicenseTag'
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip'
import { LibraryPackageContextMenu } from '../components/LibraryPackageContextMenu'
import {
  UninstallDialogContent,
  DisablePackageDialogContent,
  ForceRemoveDialogContent,
} from '../components/package-action-dialogs'

const SORT_OPTIONS = ['Recently installed', 'Type', 'Name', 'Size', 'Content', 'Deps', 'Morphs']

function packageMatchesSelectedTags(p, selectedTags) {
  if (selectedTags.length === 0) return true
  if (!p.hubTags) return false
  const tags = p.hubTags
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
  return selectedTags.every((st) => tags.includes(st))
}

export default function LibraryView({ onNavigate, navContext }) {
  const {
    packages,
    selectedDetail,
    search,
    authorSearch,
    statusFilter,
    enabledFilter,
    selectedTypes,
    selectedTags,
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
    setStatusFilter,
    setEnabledFilter,
    toggleType,
    selectSingleType,
    setSelectedTags,
    setPrimarySort,
    setSecondarySort,
    setLicense,
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

  const [gridLayout, setGridLayout] = useState({ cols: 1, availableWidth: 0 })
  const [tagCounts, setTagCounts] = useState({})
  const [authorCounts, setAuthorCounts] = useState({})
  const [detailPanelWidth] = usePersistedPanelWidth('panel_width_detail', { min: 260, max: 500, defaultWidth: 340 })
  const selectingRef = useRef(false)

  useEffect(() => {
    const getLibraryStore = () => useLibraryStore.getState()
    getLibraryStore().fetchPackages()
    getLibraryStore().fetchBackendCounts()
    window.api.packages
      .tagCounts()
      .then(setTagCounts)
      .catch(() => {})
    window.api.packages
      .authorCounts()
      .then(setAuthorCounts)
      .catch(() => {})
    getLibraryStore().checkForUpdates()
    const cleanup1 = window.api.onPackagesUpdated(() => {
      const store = getLibraryStore()
      store.fetchPackages()
      store.fetchBackendCounts()
      store.checkForUpdates({ enrich: false })
      store.refreshDetail()
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
    const cleanup2 = window.api.onContentsUpdated(() => {
      getLibraryStore().fetchPackages()
      getLibraryStore().refreshDetail()
    })
    return () => {
      cleanup1()
      cleanup2()
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

  const baseFiltered = useMemo(() => {
    let result = packages
    if (search?.trim()) {
      const terms = searchAndTerms(search)
      result = result.filter((p) => haystacksMatchAllTerms([p.title, p.packageName, p.filename], terms))
    }
    if (authorSearch) {
      const aq = authorSearch.toLowerCase()
      result = result.filter((p) => (p.creator || '').toLowerCase().includes(aq))
    }
    if (license !== 'Any') {
      if (license === COMMERCIAL_USE_ALLOWED_LICENSE_FILTER) {
        result = result.filter((p) => isCommercialUseAllowed(p.license) === true)
      } else {
        const want = canonicalizeLicense(license)
        result = result.filter((p) => canonicalizeLicense(p.license) === want)
      }
    }
    return result
  }, [packages, search, authorSearch, license])

  const statusCounts = useMemo(() => {
    if (!packagesLoaded) return { direct: '…', dependency: '…', broken: '…', orphan: '…', local: '…' }
    let items = baseFiltered
    if (selectedTypes.length > 0) {
      const typeSet = new Set(selectedTypes)
      items = items.filter((p) => {
        const isOther = !isCoreLibraryCategory(p.type)
        if (typeSet.has('Other') && isOther) return true
        return p.type && typeSet.has(p.type)
      })
    }
    if (enabledFilter === 'enabled') items = items.filter((p) => p.isEnabled)
    else if (enabledFilter === 'disabled') items = items.filter((p) => !p.isEnabled)
    items = items.filter((p) => packageMatchesSelectedTags(p, selectedTags))
    let direct = 0,
      dependency = 0,
      broken = 0,
      orphan = 0,
      local = 0
    for (const p of items) {
      if (p.isDirect) direct++
      else dependency++
      if (p.missingDeps > 0 || p.isCorrupted) broken++
      if (!p.isDirect && p.isOrphan) orphan++
      if (p.isLocalOnly) local++
    }
    return { direct, dependency, broken, orphan, local }
  }, [packagesLoaded, baseFiltered, selectedTypes, enabledFilter, selectedTags])

  const updateFacetCount = useMemo(() => {
    if (!updateCheckResults) return updateCheckLoading ? '…' : '?'
    let items = baseFiltered
    if (selectedTypes.length > 0) {
      const typeSet = new Set(selectedTypes)
      items = items.filter((p) => {
        const isOther = !isCoreLibraryCategory(p.type)
        if (typeSet.has('Other') && isOther) return true
        return p.type && typeSet.has(p.type)
      })
    }
    if (enabledFilter === 'enabled') items = items.filter((p) => p.isEnabled)
    else if (enabledFilter === 'disabled') items = items.filter((p) => !p.isEnabled)
    items = items.filter((p) => packageMatchesSelectedTags(p, selectedTags))
    let n = 0
    for (const p of items) {
      if (updateCheckResults[p.filename]) n++
    }
    return n
  }, [baseFiltered, selectedTypes, enabledFilter, selectedTags, updateCheckResults, updateCheckLoading])

  const typeCounts = useMemo(() => {
    let items = baseFiltered
    if (statusFilter === 'direct') items = items.filter((p) => p.isDirect)
    else if (statusFilter === 'dependency') items = items.filter((p) => !p.isDirect)
    else if (statusFilter === 'broken') items = items.filter((p) => p.missingDeps > 0 || p.isCorrupted)
    else if (statusFilter === 'orphan') items = items.filter((p) => p.isOrphan)
    else if (statusFilter === 'updates') items = items.filter((p) => updateCheckResults?.[p.filename])
    else if (statusFilter === 'local') items = items.filter((p) => p.isLocalOnly)
    else if (statusFilter === 'missing') items = []
    if (enabledFilter === 'enabled') items = items.filter((p) => p.isEnabled)
    else if (enabledFilter === 'disabled') items = items.filter((p) => !p.isEnabled)
    items = items.filter((p) => packageMatchesSelectedTags(p, selectedTags))
    const counts = { _total: items.length }
    for (const p of items) {
      const label = libraryTypeBadgeLabel(p.type)
      counts[label] = (counts[label] || 0) + 1
    }
    return counts
  }, [baseFiltered, statusFilter, enabledFilter, selectedTags, updateCheckResults])

  const filtered = useMemo(() => {
    if (statusFilter === 'missing') return []
    let result = [...baseFiltered]
    if (statusFilter === 'direct') result = result.filter((p) => p.isDirect)
    else if (statusFilter === 'dependency') result = result.filter((p) => !p.isDirect)
    else if (statusFilter === 'broken') result = result.filter((p) => p.missingDeps > 0 || p.isCorrupted)
    else if (statusFilter === 'orphan') result = result.filter((p) => p.isOrphan)
    else if (statusFilter === 'updates') result = result.filter((p) => updateCheckResults?.[p.filename])
    else if (statusFilter === 'local') result = result.filter((p) => p.isLocalOnly)
    if (enabledFilter === 'enabled') result = result.filter((p) => p.isEnabled)
    else if (enabledFilter === 'disabled') result = result.filter((p) => !p.isEnabled)
    if (selectedTypes.length > 0) {
      const typeSet = new Set(selectedTypes)
      result = result.filter((p) => {
        const isOther = !isCoreLibraryCategory(p.type)
        if (typeSet.has('Other') && isOther) return true
        return p.type && typeSet.has(p.type)
      })
    }
    if (selectedTags.length > 0) {
      result = result.filter((p) => {
        if (!p.hubTags) return false
        const tags = p.hubTags
          .toLowerCase()
          .split(',')
          .map((t) => t.trim())
        return selectedTags.every((st) => tags.includes(st))
      })
    }

    const sortFns = {
      'Recently installed': (a, b) => (b.firstSeenAt || 0) - (a.firstSeenAt || 0),
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
        onChange: setStatusFilter,
        listCollapsible: false,
        items: [
          { value: 'direct', label: 'Installed', count: statusCounts.direct },
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
          { value: 'missing', label: 'Missing', count: backendCounts?.missingUnique ?? '…' },
          { value: 'updates', label: 'Updates', count: updateFacetCount },
        ],
      },
      {
        key: 'type',
        label: 'Type',
        type: 'tags',
        value: new Set(selectedTypes),
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
        type: 'select',
        value: enabledFilter,
        onChange: setEnabledFilter,
        options: [
          { value: 'all', label: 'All' },
          { value: 'enabled', label: 'Enabled' },
          { value: 'disabled', label: 'Disabled' },
        ],
      },
      {
        key: 'author',
        label: 'Author',
        type: 'text-autocomplete',
        value: authorSearch,
        onChange: setAuthorSearch,
        suggestions: authorCounts,
        placeholder: 'Filter by author…',
      },
      {
        key: 'hubTags',
        label: 'Tags',
        type: 'tags-autocomplete',
        value: selectedTags,
        onChange: setSelectedTags,
        suggestions: tagCounts,
        placeholder: 'Filter by tags…',
      },
      {
        key: 'license',
        label: 'License',
        type: 'select',
        value: license,
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
      backendCounts,
      updateFacetCount,
      authorSearch,
      selectedTags,
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
      setSelectedTags,
      setLicense,
      setPrimarySort,
      setSecondarySort,
    ],
  )

  const orderedLibraryFilenames = useMemo(() => filtered.map((p) => p.filename), [filtered])
  const bulkActive = bulkSelectedFilenames.length > 0
  const selectedBulkSet = useMemo(() => new Set(bulkSelectedFilenames), [bulkSelectedFilenames])

  const scrollResetKey = `${search}\0${authorSearch}\0${statusFilter}\0${enabledFilter}\0${selectedTypes.join(',')}\0${selectedTags.join(',')}\0${primarySort}\0${secondarySort}\0${license}`

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
    const n = items.filter((p) => p.isEnabled).length
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
    const items = filtered.filter((p) => bulkSelectedFilenames.includes(p.filename))
    if (!items.length) return
    const targets = bulkEnabledState.mixed ? items.filter((p) => !p.isEnabled) : items
    try {
      for (const p of targets) {
        await window.api.packages.toggleEnabled(p.filename)
      }
      await fetchPackages()
    } catch (err) {
      toast(`Failed: ${err.message}`)
    }
  }, [filtered, bulkSelectedFilenames, bulkEnabledState.mixed, fetchPackages])

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
      <FilterPanel search={search} onSearchChange={setSearch} sections={sections} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        {bulkActive && statusFilter !== 'missing' ? (
          <div className="h-10 flex items-center px-4 border-b border-border shrink-0 gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => void runBulkToggleEnabled()}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer border border-border hover:bg-elevated text-[11px] text-text-primary"
            >
              {bulkEnabledState.allEnabled && !bulkEnabledState.mixed ? (
                <EyeOff size={16} className="text-text-secondary" />
              ) : bulkEnabledState.mixed ? (
                <Eye size={16} className="text-text-tertiary" />
              ) : (
                <Eye size={16} className="text-text-secondary" />
              )}
              {bulkEnabledState.mixed || bulkEnabledState.allDisabled ? 'Enable' : 'Disable'}
            </button>
            <button
              type="button"
              onClick={() => setBulkRemoveOpen(true)}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer border border-border text-error hover:bg-error/10 text-[11px]"
            >
              <Trash2 size={16} />
              Remove
            </button>
            {bulkRemoveSummary.dep.length > 0 && (
              <button
                type="button"
                onClick={() => void runBulkPromote()}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer border border-border hover:bg-elevated text-accent-blue text-[11px]"
              >
                <Plus size={16} />
                Promote
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-2 rounded-md cursor-pointer border border-border/90 bg-elevated/60 hover:bg-elevated hover:border-border text-[11px] font-medium text-text-primary shadow-sm transition-colors shrink-0"
                >
                  Type
                  <ChevronDown size={14} className="text-text-tertiary shrink-0 opacity-90" strokeWidth={2.25} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto min-w-[12rem]">
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
            <span className="text-[11px] text-text-primary font-medium tabular-nums">
              {bulkSelectedFilenames.length} selected
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="text-[10px] text-accent-blue hover:brightness-125 transition-[filter] cursor-pointer"
                onClick={() => selectAllBulk(orderedLibraryFilenames)}
              >
                Select all {filtered.length}
              </button>
              <button
                type="button"
                className="text-[10px] text-text-tertiary hover:text-text-secondary cursor-pointer transition-colors"
                onClick={() => clearBulkSelection()}
              >
                Deselect
              </button>
            </div>
            <div className="flex-1 min-w-4" />
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
          <div className="h-10 flex items-center px-4 border-b border-border shrink-0 gap-2">
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
            <span className="text-[11px] text-text-tertiary">
              {statusFilter === 'missing'
                ? `${missingDeps?.length ?? '…'} missing dependencies`
                : statusFilter === 'updates' && updateCheckResults == null
                  ? `${updateCheckLoading ? '…' : '?'} packages`
                  : `${filtered.length} packages`}
            </span>
            <div className="flex-1" />
            {statusFilter !== 'missing' && (
              <div className="flex items-center gap-2">
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
            onLayout={setGridLayout}
            onEmptyAreaPointerDown={bulkActive ? () => clearBulkSelection() : undefined}
            renderItem={(pkg) => (
              <LibraryPackageContextMenu
                key={pkg.filename}
                pkg={pkg}
                updateInfo={updateCheckResults?.[pkg.filename]}
                onNavigate={onNavigate}
              >
                <LibraryCard
                  pkg={pkg}
                  onClick={handleLibraryClick}
                  selected={!bulkActive && selectedDetail?.filename === pkg.filename}
                  bulkMode={bulkActive}
                  bulkSelected={selectedBulkSet.has(pkg.filename)}
                  onFilterAuthor={handleFilterAuthor}
                  mode={compactCards ? 'minimal' : 'medium'}
                  hideType={selectedTypes.length === 1}
                />
              </LibraryPackageContextMenu>
            )}
          />
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden p-4">
            <div className="border border-border rounded-lg overflow-hidden flex flex-col min-h-0">
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
                renderRow={(pkg) => (
                  <LibraryPackageContextMenu
                    key={pkg.filename}
                    pkg={pkg}
                    updateInfo={updateCheckResults?.[pkg.filename]}
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
                    />
                  </LibraryPackageContextMenu>
                )}
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
    for (const update of Object.values(updateCheckResults)) {
      if (update.localNewerFilename) continue
      if (!update.hubResourceId && !update.packageName) continue
      try {
        await store.install(update.hubResourceId, null, true, update.packageName, !!update.isDepUpdate)
        queued++
      } catch {}
    }
    if (queued > 0) toast(`${queued} update${queued !== 1 ? 's' : ''} queued`, 'success', 3000)
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
      updateCheckResults != null ? Object.values(updateCheckResults).filter((u) => !u.localNewerFilename).length : null
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
      <div className="border border-border rounded-lg overflow-hidden flex flex-col min-h-0">
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
  if (dlStatus === 'failed') return <span className={`${MTAG} text-error bg-error/8`}>Failed</span>
  if (hub?.installedLocally) return <span className={`${MTAG} text-warning bg-warning/8`}>Fallback</span>
  if (hub?.filename && !hub.downloadUrl && hubDetailsLoading)
    return <span className={`${MTAG} text-text-tertiary bg-white/4 animate-pulse`}>Checking</span>
  if (hub?.filename && hub.downloadUrl === null)
    return <span className={`${MTAG} text-text-tertiary bg-white/4`}>Unavailable</span>
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
  if (hub === null) return <span className={`${MTAG} text-error bg-error/8`}>Missing</span>
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
        className="min-w-[7rem] max-w-[8.25rem] p-0.5 text-[10px] leading-snug"
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

  const hasDependents = pkg.dependents?.length > 0
  const hasCascadeDeps = pkg.cascadeDisableDeps?.length > 0
  const showDisableDialog = hasDependents || hasCascadeDeps
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
      await window.api.packages.toggleEnabled(pkg.filename)
    } catch (err) {
      toast(`Failed to toggle package: ${err.message}`)
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
                {pkg.promotionalLink && (
                  <a
                    title={pkg.promotionalLink}
                    onClick={(e) => {
                      e.preventDefault()
                      void window.api.shell.openExternal(pkg.promotionalLink)
                    }}
                    className="flex items-center gap-1 text-[10px] text-accent-blue hover:brightness-125 transition-[filter] cursor-pointer ml-1"
                  >
                    <Heart size={9} /> Support
                  </a>
                )}
              </div>
              <div className="flex items-center gap-1 mt-1 flex-wrap">
                {kindLabel && <LibraryPackageTypeBadgeMenu pkg={pkg} kindLabel={kindLabel} kindIsCore={kindIsCore} />}
                {!pkg.isDirect && (
                  <span className={cn(THUMB_OVERLAY_CHIP, 'bg-accent-blue/20 text-accent-blue')}>DEP</span>
                )}
                {!pkg.isEnabled && (
                  <span className={cn(THUMB_OVERLAY_CHIP, 'bg-warning/20 text-warning')}>DISABLED</span>
                )}
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
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="mt-3 space-y-1.5">
            {updateInfo &&
              (updateInfo.localNewerFilename ? (
                <div className="flex gap-1.5">
                  <Button
                    variant="gradient"
                    size="sm"
                    onClick={async () => {
                      try {
                        await window.api.packages.uninstall(pkg.filename)
                        await window.api.packages.promote(updateInfo.localNewerFilename)
                        await useLibraryStore.getState().fetchPackages()
                        await useLibraryStore.getState().selectPackage(updateInfo.localNewerFilename)
                      } catch (err) {
                        toast(`Update failed: ${err.message}`)
                      }
                    }}
                    className="flex-1 min-w-0 text-[11px]"
                  >
                    <ArrowUpCircle size={11} /> Update to v{updateInfo.hubVersion}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => useLibraryStore.getState().selectPackage(updateInfo.localNewerFilename)}
                    className="shrink-0 text-[11px] px-2.5 border-text-secondary/25 text-text-primary"
                  >
                    <Eye size={11} /> Go to
                  </Button>
                </div>
              ) : (
                <Button
                  variant="gradient"
                  size="sm"
                  onClick={() => {
                    if (updateInfo.hubResourceId || updateInfo.packageName)
                      useDownloadStore
                        .getState()
                        .install(
                          updateInfo.hubResourceId,
                          null,
                          false,
                          updateInfo.packageName,
                          !!updateInfo.isDepUpdate,
                        )
                  }}
                  className="w-full text-[11px]"
                >
                  <ArrowUpCircle size={11} /> Update to v{updateInfo.hubVersion}
                </Button>
              ))}
            {pkg.isCorrupted && (
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
                  {pkg.isEnabled && showDisableDialog ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          className={`shrink-0 text-[10px] px-2.5 border-text-secondary/25 text-text-primary`}
                        >
                          <EyeOff size={11} />
                          Disable
                        </Button>
                      </AlertDialogTrigger>
                      <DisablePackageDialogContent pkg={pkg} name={name} onConfirm={handleToggleEnabled} />
                    </AlertDialog>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={handleToggleEnabled}
                      className={`shrink-0 text-[10px] px-2.5 ${!pkg.isEnabled ? 'border-warning/50 text-warning hover:bg-warning/15' : 'border-text-secondary/25 text-text-primary'}`}
                    >
                      {pkg.isEnabled ? <EyeOff size={11} /> : <Eye size={11} />}
                      {pkg.isEnabled ? 'Disable' : 'Enable'}
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
                  {pkg.isEnabled && showDisableDialog ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0 text-[10px] px-2.5 border-text-secondary/33 text-text-primary"
                        >
                          <EyeOff size={11} />
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
                      className={`shrink-0 text-[10px] px-2.5 ${!pkg.isEnabled ? 'border-warning/50 text-warning hover:bg-warning/15' : 'border-text-secondary/33 text-text-primary'}`}
                    >
                      {pkg.isEnabled ? <EyeOff size={11} /> : <Eye size={11} />}
                      {pkg.isEnabled ? 'Disable' : 'Enable'}
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
            <div className="flex items-center justify-between gap-2 mb-2 min-w-0 flex-nowrap">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:thin]">
                <span className="shrink-0 whitespace-nowrap text-[11px] font-medium text-text-primary">
                  Dependencies <span className="text-text-tertiary font-normal">({pkg.depCount})</span>
                </span>
                {pkg.missingDeps > 0 && (
                  <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-warning">
                    <AlertTriangle size={10} className="shrink-0" /> {pkg.missingDeps} missing
                  </span>
                )}
              </div>
              {pkg.missingDeps > 0 && (
                <button
                  type="button"
                  onClick={() => useDownloadStore.getState().installMissing(pkg.filename)}
                  className="shrink-0 cursor-pointer text-[10px] text-accent-blue transition-[filter] hover:brightness-125"
                >
                  Install missing
                </button>
              )}
            </div>
            <DepList items={pkg.deps} onSelectPackage={handleSelectPackage} />
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
        {(pkg.contents?.length ?? 0) > 0 && (
          <div className="p-4 border-b border-border">
            <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
              <span className="text-[11px] font-medium text-text-primary">
                Content <span className="text-text-tertiary font-normal">({pkg.contents.length})</span>
              </span>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => setFileTreeOpen(true)}
                  className="text-[10px] text-text-tertiary hover:text-accent-blue transition-colors cursor-pointer flex items-center gap-1"
                >
                  <FolderTree size={11} /> Browse
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate?.('content', { filterByPackage: pkg.packageName || pkg.filename })}
                  className="text-[10px] text-accent-blue hover:brightness-125 transition-[filter] cursor-pointer flex items-center gap-1"
                >
                  <LayoutGrid size={11} /> View in gallery
                </button>
              </div>
            </div>
            {!pkg.isEnabled && (
              <p className="text-[10px] text-warning mb-2 flex items-center gap-1">
                <EyeOff size={10} className="shrink-0" /> All content hidden in gallery while disabled
              </p>
            )}
            <div className="space-y-2">
              {Object.entries(grouped)
                .sort(([a], [b]) => compareContentTypes(a, b))
                .map(([type, items]) => (
                  <ContentCategory
                    key={type}
                    items={items}
                    label={type}
                    disabled={!pkg.isEnabled}
                    suppressHiddenRowStyle={galleryVisibilityFilter === 'hidden'}
                  />
                ))}
            </div>
          </div>
        )}

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
  if (dep.resolution === 'exact' || dep.resolution === 'latest') return 0
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

function flattenDepRows(items, depth = 0) {
  const out = []
  for (const dep of items) {
    out.push({ dep, depth })
    if (dep.children?.length) out.push(...flattenDepRows(dep.children, depth + 1))
  }
  return out
}

function DepList({ items, onSelectPackage }) {
  const [expanded, setExpanded] = useState(false)
  const byPackageRef = useDownloadStore((s) => s.byPackageRef)
  const sorted = useMemo(() => sortDepTree(items, byPackageRef), [items, byPackageRef])
  const flat = useMemo(() => flattenDepRows(sorted), [sorted])
  const total = flat.length
  const collapsible = total > 4
  const visible = expanded || !collapsible ? flat : flat.slice(0, 3)
  const remaining = expanded ? 0 : collapsible ? Math.max(0, total - 3) : 0

  return (
    <div className="border border-border rounded overflow-hidden divide-y divide-border">
      {visible.map(({ dep, depth }, i) => (
        <DepRow
          key={`${dep.ref}-${depth}-${i}`}
          dep={dep}
          depth={depth}
          renderChildren={false}
          onNavigate={onSelectPackage}
        />
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
