import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  LayoutGrid,
  List,
  Compass,
  Library as LibraryIcon,
  AlertTriangle,
  Eye,
  EyeOff,
  Star,
  X,
  Loader2,
  FolderOpen,
  ChevronDown,
  Tag,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/Toast'
import {
  TYPE_COLORS,
  CONTENT_TYPES,
  LIBRARY_FILTER_TYPES,
  compareContentTypes,
  getGradient,
  getContentGradient,
  formatBytes,
  displayName,
  isCoreLibraryCategory,
  libraryTypeBadgeLabel,
  THUMB_OVERLAY_CHIP,
  cn,
} from '@/lib/utils'
import { useThumbnail } from '@/hooks/useThumbnail'
import { useContentStore } from '@/stores/useContentStore'
import { useLabelsStore } from '@/stores/useLabelsStore'
import { AuthorAvatar, AuthorLink, ContentCard, ContentTableRow } from '@/components/PackageCard'
import { ContentItemContextMenu } from '@/components/ContentItemContextMenu'
import { LabelsRow } from '@/components/labels/LabelsRow'
import { LabelChip } from '@/components/labels/LabelChip'
import { LabelApplyPopover } from '@/components/labels/LabelApplyPopover'
import { useAddLabel } from '@/components/labels/useAddLabel'
import { useLabelObjects } from '@/components/labels/useLabelObjects'
import { bulkStateMap } from '@/components/labels/labelApplyState'
import { ContentCategory } from '@/components/ContentCategory'
import FilterPanel from '@/components/FilterPanel'
import ResizeHandle from '@/components/ResizeHandle'
import { VirtualGrid, VirtualList } from '@/components/VirtualGrid'
import { ThumbnailSizeSlider } from '@/components/ThumbnailSizeSlider'
import { useKeyboardNav } from '@/hooks/useKeyboardNav'
import { usePersistedPanelWidth } from '@/hooks/usePersistedPanelWidth'
import { openLightbox } from '@/components/ThumbnailLightbox'
import { haystacksMatchAllTerms, searchAndTerms } from '@shared/search-text.js'
import { isLocalPackage } from '@shared/local-package.js'
import { isPackageActive } from '@shared/storage-state-predicates.js'
import { StorageStateChip } from '@/components/StorageStateChip'

const SORT_OPTIONS = ['Recently installed', 'Name A-Z', 'Package', 'Type']
const isEffectivelyHidden = (c) => c.hidden || !isPackageActive(c.storageState ?? 'enabled')

function contentMatchesSelectedTags(c, selectedTags) {
  if (selectedTags.length === 0) return true
  if (!c.hubTags) return false
  const tags = c.hubTags
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
  return selectedTags.every((st) => tags.includes(st))
}

function contentLabelIds(c) {
  const own = c.ownLabelIds || []
  const parent = c.inheritedLabelIds || []
  if (!own.length) return parent
  if (!parent.length) return own
  const set = new Set(own)
  for (const id of parent) set.add(id)
  return [...set]
}

function contentMatchesSelectedLabels(c, selectedLabelIds) {
  if (selectedLabelIds.length === 0) return true
  const ids = contentLabelIds(c)
  if (!ids.length) return false
  for (const id of selectedLabelIds) if (!ids.includes(id)) return false
  return true
}

function matchesContentPackageFilter(c, packageFilter) {
  if (packageFilter === 'all') return true
  if (packageFilter === 'local') return isLocalPackage(c.packageFilename)
  if (isLocalPackage(c.packageFilename)) return false
  if (packageFilter === 'installed') return c.isDirect
  return !c.isDirect
}

export default function ContentView({ onNavigate, navContext }) {
  const {
    contents,
    selectedItem,
    selectedPackage,
    search,
    authorSearch,
    selectedTypes,
    selectedPackageTypes,
    selectedTags,
    selectedLabelIds,
    packageFilter,
    visibilityFilter,
    primarySort,
    secondarySort,
    viewMode,
    setSearch,
    setAuthorSearch,
    toggleType,
    selectSingleType,
    togglePackageType,
    selectSinglePackageType,
    setSelectedTags,
    setSelectedLabelIds,
    setPackageFilter,
    setVisibilityFilter,
    setPrimarySort,
    setSecondarySort,
    setViewMode,
    cardWidth,
    setCardWidth,
    selectItem,
    bulkSelectedIds,
    toggleBulkSelect,
    rangeBulkSelect,
    selectAllBulk,
    clearBulkSelection,
  } = useContentStore()
  const labels = useLabelsStore((s) => s.labels)

  const [gridLayout, setGridLayout] = useState({ cols: 1, availableWidth: 0 })
  const [tagCounts, setTagCounts] = useState({})
  const [authorCounts, setAuthorCounts] = useState({})
  const [detailPanelWidth] = usePersistedPanelWidth('panel_width_detail', { min: 260, max: 500, defaultWidth: 340 })
  const selectingRef = useRef(false)

  useEffect(() => {
    const load = () => {
      useContentStore.getState().fetchContents()
    }
    load()
    window.api.packages
      .tagCounts()
      .then(setTagCounts)
      .catch(() => {})
    window.api.packages
      .authorCounts()
      .then(setAuthorCounts)
      .catch(() => {})
    const cleanup1 = window.api.onContentsUpdated(() => {
      load()
      useContentStore.getState().refreshSelection()
    })
    const cleanup2 = window.api.onPackagesUpdated(() => {
      load()
      useContentStore.getState().refreshSelection()
      window.api.packages
        .tagCounts()
        .then(setTagCounts)
        .catch(() => {})
      window.api.packages
        .authorCounts()
        .then(setAuthorCounts)
        .catch(() => {})
    })
    return () => {
      cleanup1()
      cleanup2()
    }
  }, [])

  useEffect(() => {
    const ctx = navContext?.current
    if (!ctx) return
    if (ctx.filterByPackage) {
      useContentStore.getState().showPackageContents(ctx.filterByPackage)
    }
    navContext.current = null
  }, [navContext])

  const resetPackageTypeFilter = useCallback(() => {
    selectSinglePackageType('All')
  }, [selectSinglePackageType])

  const baseFiltered = useMemo(() => {
    let result = contents
    if (search?.trim()) {
      const terms = searchAndTerms(search)
      result = result.filter((c) => {
        const pkgLabel = displayName({
          hubDisplayName: c.packageHubDisplayName,
          title: c.packageTitle,
          packageName: c.packageName,
          filename: c.packageFilename,
        })
        return haystacksMatchAllTerms([c.displayName, c.packageName, pkgLabel], terms)
      })
    }
    if (authorSearch) {
      const aq = authorSearch.toLowerCase()
      result = result.filter((c) => (c.creator || '').toLowerCase().includes(aq))
    }
    return result
  }, [contents, search, authorSearch])

  const typeCounts = useMemo(() => {
    let items = baseFiltered
    if (selectedPackageTypes.length > 0) {
      const ptSet = new Set(selectedPackageTypes)
      items = items.filter((c) => {
        const label = libraryTypeBadgeLabel(c.parentPackageType)
        if (ptSet.has('Other') && !isCoreLibraryCategory(c.parentPackageType)) return true
        return ptSet.has(label)
      })
    }
    items = items.filter((c) => matchesContentPackageFilter(c, packageFilter))
    if (visibilityFilter === 'visible') items = items.filter((c) => !isEffectivelyHidden(c))
    else if (visibilityFilter === 'hidden') items = items.filter((c) => isEffectivelyHidden(c))
    else if (visibilityFilter === 'favorites') items = items.filter((c) => c.favorite)
    items = items.filter((c) => contentMatchesSelectedTags(c, selectedTags))
    items = items.filter((c) => contentMatchesSelectedLabels(c, selectedLabelIds))
    const counts = { _total: items.length }
    for (const c of items) counts[c.category] = (counts[c.category] || 0) + 1
    return counts
  }, [baseFiltered, selectedPackageTypes, packageFilter, visibilityFilter, selectedTags, selectedLabelIds])

  const packageTypeCounts = useMemo(() => {
    let items = baseFiltered
    if (selectedTypes.length > 0) {
      const typeSet = new Set(selectedTypes)
      items = items.filter((c) => typeSet.has(c.category))
    }
    items = items.filter((c) => matchesContentPackageFilter(c, packageFilter))
    if (visibilityFilter === 'visible') items = items.filter((c) => !isEffectivelyHidden(c))
    else if (visibilityFilter === 'hidden') items = items.filter((c) => isEffectivelyHidden(c))
    else if (visibilityFilter === 'favorites') items = items.filter((c) => c.favorite)
    items = items.filter((c) => contentMatchesSelectedTags(c, selectedTags))
    items = items.filter((c) => contentMatchesSelectedLabels(c, selectedLabelIds))
    const counts = { _total: items.length }
    for (const c of items) {
      const label = libraryTypeBadgeLabel(c.parentPackageType)
      counts[label] = (counts[label] || 0) + 1
    }
    return counts
  }, [baseFiltered, selectedTypes, packageFilter, visibilityFilter, selectedTags, selectedLabelIds])

  const packageFilterCounts = useMemo(() => {
    let items = baseFiltered
    if (selectedTypes.length > 0) {
      const typeSet = new Set(selectedTypes)
      items = items.filter((c) => typeSet.has(c.category))
    }
    if (selectedPackageTypes.length > 0) {
      const ptSet = new Set(selectedPackageTypes)
      items = items.filter((c) => {
        if (ptSet.has('Other') && !isCoreLibraryCategory(c.parentPackageType)) return true
        return ptSet.has(libraryTypeBadgeLabel(c.parentPackageType))
      })
    }
    if (visibilityFilter === 'visible') items = items.filter((c) => !isEffectivelyHidden(c))
    else if (visibilityFilter === 'hidden') items = items.filter((c) => isEffectivelyHidden(c))
    else if (visibilityFilter === 'favorites') items = items.filter((c) => c.favorite)
    items = items.filter((c) => contentMatchesSelectedTags(c, selectedTags))
    items = items.filter((c) => contentMatchesSelectedLabels(c, selectedLabelIds))
    let installed = 0,
      dependency = 0,
      local = 0
    for (const c of items) {
      if (isLocalPackage(c.packageFilename)) local++
      else if (c.isDirect) installed++
      else dependency++
    }
    return { all: items.length, installed, dependency, local }
  }, [baseFiltered, selectedTypes, selectedPackageTypes, visibilityFilter, selectedTags, selectedLabelIds])

  const visibilityCounts = useMemo(() => {
    let items = baseFiltered
    if (selectedTypes.length > 0) {
      const typeSet = new Set(selectedTypes)
      items = items.filter((c) => typeSet.has(c.category))
    }
    if (selectedPackageTypes.length > 0) {
      const ptSet = new Set(selectedPackageTypes)
      items = items.filter((c) => {
        if (ptSet.has('Other') && !isCoreLibraryCategory(c.parentPackageType)) return true
        return ptSet.has(libraryTypeBadgeLabel(c.parentPackageType))
      })
    }
    items = items.filter((c) => matchesContentPackageFilter(c, packageFilter))
    items = items.filter((c) => contentMatchesSelectedTags(c, selectedTags))
    items = items.filter((c) => contentMatchesSelectedLabels(c, selectedLabelIds))
    let visible = 0,
      hidden = 0,
      favorites = 0
    for (const c of items) {
      if (isEffectivelyHidden(c)) hidden++
      else visible++
      if (c.favorite) favorites++
    }
    return { all: visible + hidden, visible, hidden, favorites }
  }, [baseFiltered, selectedTypes, selectedPackageTypes, packageFilter, selectedTags, selectedLabelIds])

  const filtered = useMemo(() => {
    let result = [...baseFiltered]
    if (selectedTypes.length > 0) {
      const typeSet = new Set(selectedTypes)
      result = result.filter((c) => typeSet.has(c.category))
    }
    if (selectedPackageTypes.length > 0) {
      const ptSet = new Set(selectedPackageTypes)
      result = result.filter((c) => {
        if (ptSet.has('Other') && !isCoreLibraryCategory(c.parentPackageType)) return true
        return ptSet.has(libraryTypeBadgeLabel(c.parentPackageType))
      })
    }
    result = result.filter((c) => matchesContentPackageFilter(c, packageFilter))
    if (visibilityFilter === 'visible') result = result.filter((c) => !isEffectivelyHidden(c))
    else if (visibilityFilter === 'hidden') result = result.filter((c) => isEffectivelyHidden(c))
    else if (visibilityFilter === 'favorites') result = result.filter((c) => c.favorite)
    if (selectedTags.length > 0) {
      result = result.filter((c) => {
        if (!c.hubTags) return false
        const tags = c.hubTags
          .toLowerCase()
          .split(',')
          .map((t) => t.trim())
        return selectedTags.every((st) => tags.includes(st))
      })
    }
    if (selectedLabelIds.length > 0) {
      result = result.filter((c) => contentMatchesSelectedLabels(c, selectedLabelIds))
    }

    const sortFns = {
      'Recently installed': (a, b) => (b.firstSeenAt || 0) - (a.firstSeenAt || 0),
      'Name A-Z': (a, b) => (a.displayName || '').localeCompare(b.displayName || ''),
      Package: (a, b) =>
        displayName({
          hubDisplayName: a.packageHubDisplayName,
          title: a.packageTitle,
          packageName: a.packageName,
          filename: a.packageFilename,
        }).localeCompare(
          displayName({
            hubDisplayName: b.packageHubDisplayName,
            title: b.packageTitle,
            packageName: b.packageName,
            filename: b.packageFilename,
          }),
        ),
      Type: (a, b) => compareContentTypes(a.category, b.category),
    }
    const primary = sortFns[primarySort] || sortFns['Type']
    const secondary = sortFns[secondarySort] || sortFns['Recently installed']
    result.sort((a, b) => primary(a, b) || secondary(a, b))
    return result
  }, [
    baseFiltered,
    selectedTypes,
    selectedPackageTypes,
    selectedTags,
    selectedLabelIds,
    packageFilter,
    visibilityFilter,
    primarySort,
    secondarySort,
  ])

  const sections = useMemo(
    () => [
      {
        key: 'type',
        label: 'Type',
        type: 'tags',
        value: new Set(selectedTypes),
        onChange: selectSingleType,
        onToggle: toggleType,
        items: [
          { value: 'All', label: 'All', count: typeCounts._total },
          ...CONTENT_TYPES.map((t) => ({
            value: t,
            label: t,
            count: typeCounts[t] || 0,
            color: TYPE_COLORS[t],
          })),
        ],
      },
      {
        key: 'packageType',
        label: 'Package type',
        type: 'tags',
        collapsible: true,
        collapsedByDefault: true,
        onCollapsedChange: resetPackageTypeFilter,
        value: new Set(selectedPackageTypes),
        onChange: selectSinglePackageType,
        onToggle: togglePackageType,
        items: [
          { value: 'All', label: 'All', count: packageTypeCounts._total },
          ...LIBRARY_FILTER_TYPES.map((t) => ({
            value: t,
            label: t,
            count: packageTypeCounts[t] || 0,
            color: TYPE_COLORS[t],
          })),
        ],
      },
      {
        key: 'package',
        label: 'Package',
        type: 'list',
        value: packageFilter,
        onChange: setPackageFilter,
        items: [
          { value: 'all', label: 'All', count: packageFilterCounts.all },
          { value: 'installed', label: 'Installed', count: packageFilterCounts.installed },
          { value: 'dependency', label: 'Dependencies', count: packageFilterCounts.dependency },
          { value: 'local', label: 'Local', count: packageFilterCounts.local },
        ],
      },
      {
        key: 'visibility',
        label: 'Visibility',
        type: 'list',
        value: visibilityFilter,
        onChange: setVisibilityFilter,
        items: [
          { value: 'all', label: 'All', count: visibilityCounts.all },
          { value: 'visible', label: 'Visible', count: visibilityCounts.visible },
          { value: 'hidden', label: 'Hidden', count: visibilityCounts.hidden },
          { value: 'favorites', label: 'Favorites', count: visibilityCounts.favorites },
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
      ...(labels.length
        ? [
            {
              key: 'labels',
              label: 'Labels',
              type: 'labels-autocomplete',
              value: selectedLabelIds,
              onChange: setSelectedLabelIds,
              labels,
              placeholder: 'Filter by label…',
            },
          ]
        : []),
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
      selectedTypes,
      typeCounts,
      selectedPackageTypes,
      packageTypeCounts,
      packageFilter,
      packageFilterCounts,
      visibilityFilter,
      visibilityCounts,
      authorSearch,
      selectedTags,
      selectedLabelIds,
      labels,
      tagCounts,
      authorCounts,
      primarySort,
      secondarySort,
      resetPackageTypeFilter,
      selectSingleType,
      toggleType,
      selectSinglePackageType,
      togglePackageType,
      setPackageFilter,
      setVisibilityFilter,
      setAuthorSearch,
      setSelectedTags,
      setSelectedLabelIds,
      setPrimarySort,
      setSecondarySort,
    ],
  )

  const handleToggleHidden = useCallback(async (item) => {
    try {
      await window.api.contents.toggleHidden({
        id: item.id,
        packageFilename: item.packageFilename,
        internalPath: item.internalPath,
      })
    } catch (err) {
      toast(`Failed to toggle hidden: ${err.message}`)
    }
  }, [])

  const handleToggleFavorite = useCallback(async (item) => {
    try {
      await window.api.contents.toggleFavorite({
        id: item.id,
        packageFilename: item.packageFilename,
        internalPath: item.internalPath,
      })
    } catch (err) {
      toast(`Failed to toggle favorite: ${err.message}`)
    }
  }, [])

  const orderedContentIds = useMemo(() => filtered.map((c) => c.id), [filtered])

  const bulkActive = bulkSelectedIds.length > 0

  const scrollResetKey = `${search}\0${authorSearch}\0${selectedTypes.join(',')}\0${selectedPackageTypes.join(',')}\0${selectedTags.join(',')}\0${selectedLabelIds.join(',')}\0${packageFilter}\0${visibilityFilter}\0${primarySort}\0${secondarySort}`

  const lastSelectedIdxRef = useRef(0)
  const prevScrollResetKeyRef = useRef(scrollResetKey)
  const selectedIdx = selectedItem ? filtered.findIndex((c) => c.id === selectedItem.id) : -1
  if (selectedIdx >= 0) lastSelectedIdxRef.current = selectedIdx

  const runSelectItem = useCallback(
    (item) => {
      if (!item) return Promise.resolve()
      selectingRef.current = true
      return selectItem(item).finally(() => {
        selectingRef.current = false
      })
    },
    [selectItem],
  )

  useEffect(() => {
    if (bulkActive || filtered.length === 0) {
      prevScrollResetKeyRef.current = scrollResetKey
      return
    }
    if (selectingRef.current) return
    if (selectedItem && filtered.some((c) => c.id === selectedItem.id)) {
      prevScrollResetKeyRef.current = scrollResetKey
      return
    }
    const scrollReset = prevScrollResetKeyRef.current !== scrollResetKey
    prevScrollResetKeyRef.current = scrollResetKey
    const idx = scrollReset ? 0 : Math.min(lastSelectedIdxRef.current, filtered.length - 1)
    const target = filtered[idx]
    if (!target) return
    void runSelectItem(target)
  }, [bulkActive, filtered, selectedItem, scrollResetKey, runSelectItem])

  const handleContentClick = useCallback(
    (item, e) => {
      const mod = e.metaKey || e.ctrlKey
      if (e.shiftKey) {
        const anchor = bulkActive ? useContentStore.getState().bulkAnchorId : selectedItem?.id
        rangeBulkSelect(item.id, orderedContentIds, anchor)
        return
      }
      if (mod || bulkActive) {
        toggleBulkSelect(item.id)
        return
      }
      void runSelectItem(item)
    },
    [bulkActive, orderedContentIds, rangeBulkSelect, selectedItem?.id, toggleBulkSelect, runSelectItem],
  )

  const handleContentTableRowClick = useCallback(
    (item, e) => {
      handleContentClick(item, e)
    },
    [handleContentClick],
  )

  const handleContentBulkToggle = useCallback(
    (item) => {
      toggleBulkSelect(item.id)
    },
    [toggleBulkSelect],
  )

  const handleFilterAuthor = useCallback(
    (author) => {
      setAuthorSearch(author)
    },
    [setAuthorSearch],
  )

  const handleKeyboardSelect = useCallback(
    (item) => {
      if (bulkActive) return
      void runSelectItem(item)
    },
    [bulkActive, runSelectItem],
  )

  useKeyboardNav({
    items: bulkActive ? [] : filtered,
    selectedId: selectedItem?.id,
    onSelect: handleKeyboardSelect,
    onClose: () => {
      if (bulkActive) clearBulkSelection()
    },
    getId: (c) => c.id,
  })

  useEffect(() => {
    function onKeyDown(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault()
        selectAllBulk(orderedContentIds)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [orderedContentIds, selectAllBulk])

  useEffect(() => {
    if (!bulkActive) return
    function onSpace(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
      if (e.key !== ' ' && e.code !== 'Space') return
      e.preventDefault()
      const id = useContentStore.getState().bulkAnchorId
      if (id == null) return
      useContentStore.getState().toggleBulkSelect(id)
    }
    window.addEventListener('keydown', onSpace, true)
    return () => window.removeEventListener('keydown', onSpace, true)
  }, [bulkActive])

  const selectedBulkSet = useMemo(() => new Set(bulkSelectedIds), [bulkSelectedIds])

  const bulkVisibilityState = useMemo(() => {
    const items = filtered.filter((c) => bulkSelectedIds.includes(c.id))
    if (!items.length) return { disabled: true, mixed: false, allHidden: false }
    const eligible = items.filter((c) => isPackageActive(c.storageState ?? 'enabled'))
    if (!eligible.length) return { disabled: true, mixed: false, allHidden: false }
    const hiddenCount = eligible.filter((c) => c.hidden).length
    const allHidden = hiddenCount === eligible.length
    const allVisible = hiddenCount === 0
    return {
      disabled: false,
      mixed: !allHidden && !allVisible,
      allHidden,
      allVisible,
    }
  }, [filtered, bulkSelectedIds])

  const bulkFavoriteState = useMemo(() => {
    const items = filtered.filter((c) => bulkSelectedIds.includes(c.id))
    if (!items.length) return { mixed: false, allFav: false, allUnfav: false }
    const favCount = items.filter((c) => c.favorite).length
    const allFav = favCount === items.length
    const allUnfav = favCount === 0
    return { mixed: !allFav && !allUnfav, allFav, allUnfav }
  }, [filtered, bulkSelectedIds])

  const runBulkHidden = useCallback(
    async (hidden) => {
      const items = filtered
        .filter((c) => bulkSelectedIds.includes(c.id) && isPackageActive(c.storageState ?? 'enabled'))
        .map((c) => ({
          id: c.id,
          packageFilename: c.packageFilename,
          internalPath: c.internalPath,
        }))
      if (!items.length) return
      try {
        await window.api.contents.setHiddenBatch({ items, hidden })
      } catch (err) {
        toast(`Failed: ${err.message}`)
      }
    },
    [filtered, bulkSelectedIds],
  )

  const runBulkFavorite = useCallback(
    async (favorite) => {
      const items = filtered
        .filter((c) => bulkSelectedIds.includes(c.id))
        .map((c) => ({
          id: c.id,
          packageFilename: c.packageFilename,
          internalPath: c.internalPath,
        }))
      if (!items.length) return
      try {
        await window.api.contents.setFavoriteBatch({ items, favorite })
      } catch (err) {
        toast(`Failed: ${err.message}`)
      }
    },
    [filtered, bulkSelectedIds],
  )

  const handleBulkVisibilityClick = useCallback(() => {
    const st = bulkVisibilityState
    if (st.disabled) return
    if (st.mixed || st.allVisible) void runBulkHidden(true)
    else void runBulkHidden(false)
  }, [bulkVisibilityState, runBulkHidden])

  const handleBulkFavoriteClick = useCallback(() => {
    const st = bulkFavoriteState
    if (st.mixed || st.allUnfav) void runBulkFavorite(true)
    else void runBulkFavorite(false)
  }, [bulkFavoriteState, runBulkFavorite])

  const bulkLabelStateMap = useMemo(() => {
    const items = filtered.filter((c) => bulkSelectedIds.includes(c.id))
    return bulkStateMap(items.map((c) => c.ownLabelIds || []))
  }, [filtered, bulkSelectedIds])

  const bulkLabelTargets = useMemo(
    () =>
      filtered
        .filter((c) => bulkSelectedIds.includes(c.id))
        .map((c) => ({ packageFilename: c.packageFilename, internalPath: c.internalPath })),
    [filtered, bulkSelectedIds],
  )

  const runBulkLabelToggle = useCallback(
    async (label, currentState) => {
      if (!bulkLabelTargets.length) return
      const apply = currentState !== 'all'
      try {
        await window.api.labels.applyToContents({ id: label.id, items: bulkLabelTargets, applied: apply })
      } catch (err) {
        toast(`Failed to ${apply ? 'apply' : 'remove'} label: ${err.message}`)
      }
    },
    [bulkLabelTargets],
  )

  const runBulkLabelCreate = useCallback(
    async (name) => {
      if (!bulkLabelTargets.length) return
      try {
        const created = await window.api.labels.create({ name })
        await window.api.labels.applyToContents({ id: created.id, items: bulkLabelTargets, applied: true })
      } catch (err) {
        toast(`Failed to create label: ${err.message}`)
      }
    },
    [bulkLabelTargets],
  )

  const selectionAnnounced = bulkActive ? `${bulkSelectedIds.length} selected` : ''

  const contentTableSelectAllRef = useRef(null)
  useLayoutEffect(() => {
    const el = contentTableSelectAllRef.current
    if (!el) return
    el.indeterminate = bulkSelectedIds.length > 0 && bulkSelectedIds.length < filtered.length
  }, [bulkSelectedIds, filtered.length])

  return (
    <div className="h-full flex">
      <FilterPanel search={search} onSearchChange={setSearch} sections={sections} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        {bulkActive ? (
          <div className="h-10 flex items-center px-4 border-b border-border shrink-0 gap-3">
            <button
              type="button"
              disabled={bulkVisibilityState.disabled}
              onClick={handleBulkVisibilityClick}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer border border-border hover:bg-elevated text-[11px] text-text-primary disabled:opacity-40 disabled:pointer-events-none"
            >
              {bulkVisibilityState.allHidden ? (
                <Eye size={16} className="text-text-secondary" />
              ) : (
                <EyeOff
                  size={16}
                  className={bulkVisibilityState.mixed ? 'text-text-tertiary' : 'text-text-secondary'}
                />
              )}
              {bulkVisibilityState.allHidden ? 'Show' : 'Hide'}
            </button>
            <button
              type="button"
              onClick={handleBulkFavoriteClick}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer border border-border hover:bg-elevated text-[11px] text-text-primary"
            >
              <Star
                size={16}
                className={cn(
                  bulkFavoriteState.allFav && !bulkFavoriteState.mixed && 'text-text-secondary',
                  bulkFavoriteState.mixed && 'text-text-tertiary',
                  bulkFavoriteState.allUnfav && !bulkFavoriteState.mixed && 'text-warning',
                )}
                fill={bulkFavoriteState.allFav && !bulkFavoriteState.mixed ? 'none' : 'currentColor'}
              />
              {bulkFavoriteState.allFav && !bulkFavoriteState.mixed ? 'Unfavorite' : 'Favorite'}
            </button>
            <LabelApplyPopover
              align="end"
              labels={labels}
              stateById={bulkLabelStateMap}
              onToggle={runBulkLabelToggle}
              onCreate={runBulkLabelCreate}
            >
              <button
                type="button"
                className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-2 rounded-md cursor-pointer border border-border/90 bg-elevated/60 hover:bg-elevated hover:border-border text-[11px] font-medium text-text-primary shadow-sm transition-colors shrink-0"
              >
                <Tag size={12} className="text-text-tertiary shrink-0" />
                Labels
                <ChevronDown size={14} className="text-text-tertiary shrink-0 opacity-90" strokeWidth={2.25} />
              </button>
            </LabelApplyPopover>
            <span className="text-[11px] text-text-primary font-medium tabular-nums">
              {bulkSelectedIds.length} selected
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="text-[10px] text-accent-blue hover:brightness-125 transition-[filter] cursor-pointer"
                onClick={() => selectAllBulk(orderedContentIds)}
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
            <div className="flex-1" />
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
              {selectionAnnounced}
            </span>
          </div>
        ) : (
          <div className="h-10 flex items-center px-4 border-b border-border shrink-0 gap-2">
            <span className="text-[11px] text-text-tertiary">{filtered.length} items</span>
            <div className="flex-1" />
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
                  onClick={() => setViewMode('grid')}
                  title="Gallery"
                  className={`p-1.5 rounded cursor-pointer ${viewMode === 'grid' ? 'bg-hover text-text-primary' : 'text-text-tertiary'}`}
                >
                  <LayoutGrid size={14} />
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
          </div>
        )}

        {viewMode === 'grid' ? (
          <VirtualGrid
            items={filtered}
            itemWidth={cardWidth}
            itemHeight={cardWidth}
            className="flex-1"
            scrollResetKey={scrollResetKey}
            onLayout={setGridLayout}
            onEmptyAreaPointerDown={bulkActive ? () => clearBulkSelection() : undefined}
            renderItem={(item) => (
              <ContentItemContextMenu
                key={item.id}
                item={item}
                onNavigate={onNavigate}
                onToggleHidden={handleToggleHidden}
                onToggleFavorite={handleToggleFavorite}
              >
                <ContentCard
                  item={item}
                  onClick={handleContentClick}
                  selected={!bulkActive && selectedItem?.id === item.id}
                  bulkMode={bulkActive}
                  bulkSelected={selectedBulkSet.has(item.id)}
                  onToggleHidden={handleToggleHidden}
                  onToggleFavorite={handleToggleFavorite}
                  hideType={selectedTypes.length === 1}
                  suppressHiddenDimming={visibilityFilter === 'hidden'}
                />
              </ContentItemContextMenu>
            )}
          />
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden p-4">
            <div className="border border-border rounded-lg overflow-hidden flex flex-col min-h-0">
              <div className="bg-elevated text-[10px] uppercase tracking-wider text-text-tertiary flex border-b border-border shrink-0">
                {bulkActive && (
                  <div className="w-8 shrink-0 flex items-center justify-center border-r border-border/50 py-2">
                    <input
                      ref={contentTableSelectAllRef}
                      type="checkbox"
                      className="accent-accent-blue cursor-pointer"
                      aria-label="Select all"
                      checked={bulkSelectedIds.length > 0 && bulkSelectedIds.length === filtered.length}
                      onChange={(e) => {
                        if (e.target.checked) selectAllBulk(orderedContentIds)
                        else clearBulkSelection()
                      }}
                    />
                  </div>
                )}
                <div className="flex-3 py-2 px-3 font-medium">Content</div>
                <div className="flex-2 py-2 px-3 font-medium">Author</div>
                {selectedTypes.length !== 1 && <div className="flex-1 min-w-0 py-2 px-3 font-medium">Type</div>}
                <div className="flex-1 min-w-0 py-2 px-3 font-medium">Tags</div>
                <div className="w-14 py-2 px-3 font-medium">Show</div>
                <div className="w-12 py-2 px-3 font-medium">Fav</div>
              </div>
              <VirtualList
                items={filtered}
                rowHeight={37}
                className="flex-1"
                scrollResetKey={scrollResetKey}
                renderRow={(item) => (
                  <ContentItemContextMenu
                    key={item.id}
                    item={item}
                    onNavigate={onNavigate}
                    onToggleHidden={handleToggleHidden}
                    onToggleFavorite={handleToggleFavorite}
                  >
                    <ContentTableRow
                      item={item}
                      selected={!bulkActive && selectedItem?.id === item.id}
                      bulkMode={bulkActive}
                      bulkSelected={selectedBulkSet.has(item.id)}
                      onBulkToggle={handleContentBulkToggle}
                      hideType={selectedTypes.length === 1}
                      onClick={handleContentTableRowClick}
                      onFilterAuthor={handleFilterAuthor}
                      onToggleHidden={handleToggleHidden}
                      onToggleFavorite={handleToggleFavorite}
                      suppressHiddenDimming={visibilityFilter === 'hidden'}
                    />
                  </ContentItemContextMenu>
                )}
              />
            </div>
            {filtered.length === 0 && (
              <div className="text-center py-16 text-text-tertiary text-sm">No content items found</div>
            )}
          </div>
        )}
      </div>

      {selectedItem && !bulkActive ? (
        <ContentDetailPanel
          item={selectedItem}
          pkg={selectedPackage}
          onNavigate={onNavigate}
          onToggleHidden={handleToggleHidden}
          onToggleFavorite={handleToggleFavorite}
          onFilterAuthor={handleFilterAuthor}
          suppressHiddenRowStyle={visibilityFilter === 'hidden'}
          onSelectRelated={(c) => {
            const full = contents.find((x) => x.id === c.id)
            if (full) void runSelectItem(full)
          }}
        />
      ) : bulkActive ? (
        <ContentBulkPanel bulkSelectedIds={bulkSelectedIds} />
      ) : (
        <div className="shrink-0 border-l border-border bg-surface" style={{ width: detailPanelWidth }} />
      )}
    </div>
  )
}

function ContentBulkPanel({ bulkSelectedIds }) {
  const [panelWidth] = usePersistedPanelWidth('panel_width_detail', {
    min: 260,
    max: 500,
    defaultWidth: 340,
  })
  const n = bulkSelectedIds.length
  return (
    <div className="shrink-0 border-l border-border bg-surface" style={{ width: panelWidth }}>
      <div className="p-4">
        <div className="text-sm font-semibold text-text-primary">
          {n} item{n !== 1 ? 's' : ''} selected
        </div>
      </div>
    </div>
  )
}

// --- Detail Panel ---

function ContentDetailPanel({
  item,
  pkg,
  onNavigate,
  onToggleHidden,
  onToggleFavorite,
  onFilterAuthor,
  onSelectRelated,
  suppressHiddenRowStyle = false,
}) {
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
    (delta) => setPanelWidth(Math.min(450, Math.max(220, startWidthRef.current + delta))),
    [setPanelWidth],
  )

  const itemThumbKey = item.thumbnailPath ? `ct:${item.packageFilename}\0${item.thumbnailPath}` : null
  const itemThumbUrl = useThumbnail(itemThumbKey)
  const pkgThumbUrl = useThumbnail(pkg ? `pkg:${pkg.filename}` : null)

  const isLocal = isLocalPackage(item.packageFilename)
  const allContents = useContentStore((s) => s.contents)
  const allLabels = useLabelsStore((s) => s.labels)
  const onApplyLabelToItem = useCallback(
    (id, applied) =>
      window.api.labels.applyToContents({
        id,
        items: [{ packageFilename: item.packageFilename, internalPath: item.internalPath }],
        applied,
      }),
    [item.packageFilename, item.internalPath],
  )
  const { handleApply: handleApplyLabel, handleCreate: handleCreateLabel } = useAddLabel(onApplyLabelToItem)
  const hasLabels = (item.ownLabelIds || []).length > 0
  const inheritedLabels = useLabelObjects(item.inheritedLabelIds)

  const moreGrouped = useMemo(() => {
    if (!pkg) return {}
    const g = {}
    ;(pkg.contents || []).forEach((c) => {
      if (!g[c.category]) g[c.category] = []
      g[c.category].push(c)
    })
    return g
  }, [pkg])

  const moreCount = useMemo(() => Object.values(moreGrouped).reduce((n, arr) => n + arr.length, 0), [moreGrouped])

  const folderPath = useMemo(() => {
    if (!isLocal) return ''
    const segs = item.internalPath.split('/')
    return segs.slice(0, -1).join('/')
  }, [isLocal, item.internalPath])

  const localSiblings = useMemo(() => {
    if (!isLocal) return []
    return allContents.filter(
      (c) =>
        isLocalPackage(c.packageFilename) &&
        c.internalPath.startsWith(folderPath + '/') &&
        c.internalPath.indexOf('/', folderPath.length + 1) === -1,
    )
  }, [isLocal, allContents, folderPath])

  const localGrouped = useMemo(() => {
    const g = {}
    for (const c of localSiblings) {
      if (!g[c.category]) g[c.category] = []
      g[c.category].push(c)
    }
    return g
  }, [localSiblings])

  const pkgTitle = pkg ? displayName(pkg) : ''
  const pkgVersionStr = pkg && pkg.version != null && pkg.version !== '' ? String(pkg.version) : null

  return (
    <div className="flex shrink-0" style={{ width: panelWidth }}>
      <ResizeHandle side="left" onResizeStart={onResizeStart} onResize={onPanelResize} />
      <div className="flex-1 min-w-0 border-l border-border bg-surface overflow-y-auto">
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div
              className={`w-12 h-12 rounded shrink-0 relative overflow-hidden${itemThumbUrl ? ' cursor-pointer' : ''}`}
              onClick={() => openLightbox(itemThumbUrl)}
            >
              <div
                className="absolute inset-0"
                style={{ background: getContentGradient(item.displayName, item.category) }}
              />
              {itemThumbUrl && (
                <img src={itemThumbUrl} className="thumb absolute inset-0 w-full h-full object-cover" alt="" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-text-primary truncate select-text cursor-text">
                {item.displayName}
              </div>
              <div className="text-[10px] text-text-tertiary">
                {item.category}
                {item.tag && (
                  <span className="ml-1" style={{ color: item.tag.color + 'cc' }}>
                    {item.tag.label}
                  </span>
                )}
              </div>
            </div>
            {!hasLabels && (
              <LabelApplyPopover
                labels={allLabels}
                appliedIds={[]}
                onApply={handleApplyLabel}
                onCreate={handleCreateLabel}
                align="end"
              >
                <button
                  type="button"
                  title="Add label"
                  aria-label="Add label"
                  className="shrink-0 p-1 rounded cursor-pointer transition-colors text-text-tertiary hover:text-text-secondary data-[state=open]:text-text-secondary"
                >
                  <Tag size={14} />
                </button>
              </LabelApplyPopover>
            )}
            {!isPackageActive(item.storageState ?? 'enabled') ? (
              <span className="shrink-0 p-1 text-warning opacity-60" title="Package is disabled">
                <EyeOff size={14} />
              </span>
            ) : (
              <button
                onClick={() => onToggleHidden?.(item)}
                className={`shrink-0 p-1 rounded cursor-pointer transition-colors ${item.hidden ? 'text-error hover:text-error/70' : 'text-text-tertiary hover:text-text-secondary'}`}
              >
                {item.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            )}
            <button
              onClick={() => onToggleFavorite?.(item)}
              className={`shrink-0 p-1 rounded cursor-pointer transition-colors ${item.favorite ? 'text-warning hover:text-warning/70' : 'text-text-tertiary hover:text-warning'}`}
            >
              <Star size={14} fill={item.favorite ? 'currentColor' : 'none'} />
            </button>
          </div>
          {hasLabels && (
            <div className="mt-3">
              <LabelsRow appliedIds={item.ownLabelIds} onApplyToTarget={onApplyLabelToItem} />
            </div>
          )}
        </div>

        <div className="p-4 border-b border-border">
          <div className="text-[9px] uppercase tracking-wider text-text-tertiary font-medium mb-2">
            {isLocal ? 'Local File' : 'From Package'}
          </div>
          {isLocal ? (
            <>
              <div className="flex items-start gap-2.5">
                <div className="w-10 h-10 rounded shrink-0 bg-elevated flex items-center justify-center">
                  <FolderOpen size={18} className="text-text-tertiary" strokeWidth={1.5} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text-primary truncate select-text cursor-text">
                    {item.internalPath
                      .split('/')
                      .pop()
                      .replace(/\.[^.]+$/, '')}
                  </div>
                  <div
                    className="text-[10px] text-text-tertiary mt-0.5 truncate select-text cursor-text"
                    title={item.internalPath}
                  >
                    {folderPath.split('/').map((seg, i, arr) => (
                      <span key={i}>
                        {seg}
                        {i < arr.length - 1 && <span className="mx-1 opacity-50">/</span>}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const vamDir = await window.api.settings.get('vam_dir')
                  if (!vamDir) return
                  window.api.shell.showItemInFolder([vamDir, item.internalPath])
                }}
                className="w-full text-[10px] text-accent-blue mt-3"
              >
                <FolderOpen size={12} /> Show in folder
              </Button>
            </>
          ) : pkg ? (
            <>
              <div className="flex items-start gap-2.5">
                <div
                  className={`w-10 h-10 rounded shrink-0 relative overflow-hidden${pkgThumbUrl ? ' cursor-pointer' : ''}`}
                  onClick={() => openLightbox(pkgThumbUrl)}
                >
                  <div className="absolute inset-0" style={{ background: getGradient(pkg.filename) }} />
                  {pkgThumbUrl && (
                    <img src={pkgThumbUrl} className="thumb absolute inset-0 w-full h-full object-cover" alt="" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-sm font-semibold text-text-primary truncate select-text cursor-text min-w-0">
                      {pkgTitle}
                    </span>
                    {pkgVersionStr && (
                      <span className="text-[11px] text-text-tertiary shrink-0 select-text cursor-text font-mono">
                        v{pkgVersionStr}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <AuthorAvatar author={pkg.creator} userId={pkg.hubUserId} size={14} />
                    <span className="text-[10px] text-text-secondary">
                      by <AuthorLink author={pkg.creator} onFilterAuthor={onFilterAuthor} />
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex w-full items-center gap-1.5 mt-2 min-w-0 flex-wrap text-[10px]">
                <span
                  className={`${THUMB_OVERLAY_CHIP} text-white`}
                  style={{ background: (TYPE_COLORS[pkg.type] || '#6366f1') + 'cc' }}
                >
                  {pkg.type}
                </span>
                {!pkg.isDirect && (
                  <span className={`${THUMB_OVERLAY_CHIP} bg-accent-blue/20 text-accent-blue`}>DEP</span>
                )}
                <StorageStateChip storageState={pkg.storageState ?? 'enabled'} />
                {inheritedLabels.map((label) => (
                  <LabelChip key={label.id} label={label} size="sm" outline />
                ))}
                <span
                  className="text-text-tertiary"
                  title={
                    pkg.removableSize > 0
                      ? `${formatBytes(pkg.sizeBytes)} package + ${formatBytes(pkg.removableSize)} unique deps`
                      : 'Size on disk'
                  }
                >
                  {formatBytes(pkg.sizeBytes + (pkg.removableSize || 0))}
                </span>
                {pkg.missingDeps > 0 && (
                  <span className="ml-auto flex items-center gap-1 text-warning shrink-0">
                    <AlertTriangle size={10} className="shrink-0" />
                    {pkg.missingDeps} missing
                  </span>
                )}
              </div>

              <div className="flex gap-2 mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate('library', { selectPackage: pkg.filename })}
                  className={`text-[10px] text-accent-blue ${pkg.hubResourceId ? 'flex-1' : 'w-full'}`}
                >
                  <LibraryIcon size={12} /> Library
                </Button>
                {pkg.hubResourceId && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onNavigate('hub', {
                        openResource: {
                          resource_id: pkg.hubResourceId,
                          title: pkgTitle,
                          username: pkg.creator,
                          type: pkg.type,
                        },
                      })
                    }
                    className="flex-1 text-[10px] text-accent-blue"
                  >
                    <Compass size={12} /> Hub
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-text-tertiary text-sm py-6">
              <Loader2 className="animate-spin shrink-0" size={16} /> Loading package…
            </div>
          )}
        </div>

        {pkg && moreCount > 0 && (
          <div className="p-4 border-b border-border">
            <div className="text-[11px] font-medium text-text-primary mb-2">
              More from this package <span className="text-text-tertiary font-normal">({moreCount})</span>
            </div>
            <MoreFromPackage
              grouped={moreGrouped}
              onSelectRelated={onSelectRelated}
              disabled={!isPackageActive(pkg.storageState ?? 'enabled')}
              suppressHiddenRowStyle={suppressHiddenRowStyle}
            />
          </div>
        )}

        {isLocal && localSiblings.length > 0 && (
          <div className="p-4 border-b border-border">
            <div className="text-[11px] font-medium text-text-primary mb-2">
              Other content in this folder{' '}
              <span className="text-text-tertiary font-normal">({localSiblings.length})</span>
            </div>
            <MoreFromPackage
              grouped={localGrouped}
              onSelectRelated={onSelectRelated}
              disabled={false}
              suppressHiddenRowStyle={suppressHiddenRowStyle}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function MoreFromPackage({ grouped, onSelectRelated, disabled, suppressHiddenRowStyle = false }) {
  const types = Object.keys(grouped).sort(compareContentTypes)

  return (
    <div className="space-y-2">
      {types.map((type) => (
        <ContentCategory
          key={type}
          items={grouped[type]}
          label={type}
          onSelectRow={onSelectRelated}
          disabled={disabled}
          suppressHiddenRowStyle={suppressHiddenRowStyle}
        />
      ))}
    </div>
  )
}
