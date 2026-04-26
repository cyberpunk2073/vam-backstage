import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Globe,
  ChevronRight,
  Download,
  Heart,
  Star,
  ExternalLink,
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
  X,
} from 'lucide-react'
import { Button } from '../components/ui/button'
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
} from '../lib/utils'
import { useHubStore } from '../stores/useHubStore'
import { useDownloadStore } from '../stores/useDownloadStore'
import { useInstalledStore } from '../stores/useInstalledStore'
import { useHubInstallState } from '../hooks/useHubInstallState'
import { HubCard, AuthorAvatar, DepRow } from '../components/PackageCard'
import FilterPanel from '../components/FilterPanel'
import ResizeHandle from '../components/ResizeHandle'
import { usePersistedPanelWidth } from '../hooks/usePersistedPanelWidth'
import { LICENSE_FILTER_OPTIONS, getHubResourceLicense } from '../lib/licenses'
import { LicenseTag } from '../components/LicenseTag'
import { Tag } from '../components/ui/tag'
import { ThumbnailSizeSlider } from '../components/ThumbnailSizeSlider'

/** Hub text search: avoid a network request on every keystroke */
const HUB_SEARCH_DEBOUNCE_MS = 320

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
    detailResource,
    cardMode,
    cardWidth,
    filterOptions,
    setSearch,
    setSelectedType,
    setPaidFilter,
    setAuthorSearch,
    setSelectedHubTags,
    setSort,
    setLicense,
    setCardMode,
    setCardWidth,
    fetchResources,
    fetchNextPage,
    openDetail,
    closeDetail,
  } = useHubStore()

  const [searchDraft, setSearchDraft] = useState(search)
  const searchDebounceRef = useRef(null)
  useEffect(() => {
    setSearchDraft(search)
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
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
        searchDebounceRef.current = null
      }
      if (value === '') {
        setSearch('')
        return
      }
      searchDebounceRef.current = setTimeout(() => {
        searchDebounceRef.current = null
        setSearch(value)
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

  // Intersection observer sentinel for infinite scroll
  // Depends on resources.length so the observer is (re)created after each page load —
  // handles both the initial null-ref case and the sentinel-still-visible edge case.
  const sentinelRef = useRef(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) fetchNextPage()
      },
      { rootMargin: '900px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [fetchNextPage, resources.length])

  // When packages change (promote, download completes, uninstall), resync install status + detail from DB
  useEffect(() => {
    return window.api.onPackagesUpdated(async () => {
      const state = useHubStore.getState()
      if (state.detailResource) void state.refreshDetail()
      const { resources } = state
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
      setAuthorSearch(author)
    },
    [setAuthorSearch],
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

  return (
    <div className="h-full flex min-w-0 relative">
      <FilterPanel search={searchDraft} onSearchChange={handleSearchChange} sections={sections} />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Toolbar */}
        <div className="h-10 flex items-center px-4 border-b border-border shrink-0 gap-2">
          <span className="text-[11px] text-text-tertiary">
            {loading && resources.length === 0 ? 'Searching…' : `${totalFound.toLocaleString()} packages`}
          </span>
          <button
            type="button"
            onClick={() => fetchResources(true, { forceRefresh: true })}
            disabled={loading}
            title="Refresh"
            className="p-1 rounded text-text-tertiary hover:text-text-secondary disabled:opacity-30 cursor-pointer disabled:cursor-default"
          >
            <RefreshCw size={13} className={loading && resources.length === 0 ? 'animate-spin' : ''} />
          </button>
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
        <div ref={galleryRef} className="flex-1 overflow-y-auto p-4 relative">
          {error && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-error/10 border border-error/20 text-error text-xs select-text cursor-text">
              {error}
            </div>
          )}
          {resources.length === 0 && (loading || !sort) ? (
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
                {resources.map((r) => (
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
                ))}
              </div>
              {/* Infinite scroll sentinel */}
              {page < totalPages && <div ref={sentinelRef} className="h-1" />}
              {loading && resources.length > 0 && (
                <div className="flex items-center justify-center py-6">
                  <Loader2 size={20} className="animate-spin text-accent-blue" />
                  <span className="text-[11px] text-text-tertiary ml-2">Loading more…</span>
                </div>
              )}
              {!loading && sort && resources.length === 0 && (
                <div className="text-center py-16 text-text-tertiary text-sm">No packages found</div>
              )}
            </>
          )}
        </div>
      </div>
      {detailResource && (
        <HubDetail
          resource={detailResource}
          onBack={closeDetail}
          onNavigate={onNavigate}
          onInstall={handleInstall}
          onFilterAuthor={handleFilterAuthor}
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

// --- Hub Detail ---

function HubDetail({ resource, onBack, onNavigate, onInstall, onFilterAuthor }) {
  const { detailData, detailLoading } = useHubStore()
  const detail = detailData
  const [browserTab, setBrowserTab] = useState('overview')
  const webviewRef = useRef(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)

  const resourceId = detail?.resource_id || resource.resource_id
  const threadId = detail?.discussion_thread_id

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

  // The URL the webview should load — computed synchronously so src is never empty
  const targetUrl = tabUrls[browserTab] || tabUrls.overview
  // Display URL for the address bar — tracks in-page navigation independently
  const [displayUrl, setDisplayUrl] = useState(targetUrl)
  useEffect(() => {
    setDisplayUrl(targetUrl)
  }, [targetUrl])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const syncNav = (e) => {
      setDisplayUrl(e.url)
      setCanGoBack(wv.canGoBack())
      setCanGoForward(wv.canGoForward())
      const tabKey = browserTabMatchingUrl(e.url, tabUrls, tabs)
      if (tabKey) setBrowserTab(tabKey)
    }
    const ignoreAbort = (e) => {
      if (e.errorCode === -3 || e.errorCode === -2) e.preventDefault()
    }

    // Inject a click-interceptor into the guest page so that target="_blank" / target="_top"
    // links and window.open() calls navigate in-place instead of spawning a popup.
    // Hub-origin URLs navigate inside the webview; everything else opens externally via window.open
    // (which the main-process setWindowOpenHandler catches → shell.openExternal).
    const injectLinkHandler = () => {
      wv.executeJavaScript(
        `(function() {
        if (window.__hubNavPatched) return
        window.__hubNavPatched = true
        var hubOrigin = location.origin

        document.addEventListener('click', function(e) {
          var a = e.target.closest('a[href]')
          if (!a) return
          var href = a.getAttribute('href')
          if (!href || href.charAt(0) === '#' || href.startsWith('javascript:')) return
          try {
            var url = new URL(href, location.href)
            if (url.origin === hubOrigin) {
              if (a.target && a.target !== '_self') {
                e.preventDefault()
                e.stopPropagation()
                location.href = url.href
              }
            } else {
              e.preventDefault()
              e.stopPropagation()
              window.open(url.href)
            }
          } catch(err) {}
        }, true)

        var _open = window.open.bind(window)
        window.open = function(url) {
          if (!url) return null
          try {
            var resolved = new URL(url, location.href)
            if (resolved.origin === hubOrigin) {
              location.href = resolved.href
              return null
            }
          } catch(err) {}
          return _open(url)
        }
      })()`,
      ).catch(() => {})
    }

    wv.addEventListener('did-navigate', syncNav)
    wv.addEventListener('did-navigate-in-page', syncNav)
    wv.addEventListener('did-fail-load', ignoreAbort)
    wv.addEventListener('dom-ready', injectLinkHandler)
    return () => {
      wv.removeEventListener('did-navigate', syncNav)
      wv.removeEventListener('did-navigate-in-page', syncNav)
      wv.removeEventListener('did-fail-load', ignoreAbort)
      wv.removeEventListener('dom-ready', injectLinkHandler)
    }
  }, [resourceId, tabUrls, tabs])

  const goBack = useCallback(() => webviewRef.current?.goBack(), [])
  const goForward = useCallback(() => webviewRef.current?.goForward(), [])
  const reload = useCallback(() => webviewRef.current?.reload(), [])

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
  const librarySelectRef = installStatus.filename || dlInfo?.packageRef || pkg._localFilename

  const deps = useMemo(() => {
    const hf = detail?.hubFiles || []
    const depGroups = detail?.dependencies || {}
    const localName = detail?._localFilename
    const seen = new Set()

    const hasDownloadUrl = (f) => (f.downloadUrl && f.downloadUrl !== 'null') || (f.urlHosted && f.urlHosted !== 'null')
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
      <div className="h-10 flex items-center px-4 border-b border-border shrink-0 gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-text-secondary hover:text-text-primary">
          <ArrowLeft size={14} /> Back
        </Button>
        <ChevronRight size={12} className="text-text-tertiary shrink-0" />
        <span className="text-xs text-text-primary font-medium truncate flex-1 min-w-0">{title}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onBack}
          aria-label="Close detail"
          className="shrink-0 text-text-tertiary/45 hover:text-text-tertiary hover:bg-muted/35"
        >
          <X size={12} strokeWidth={1.75} />
        </Button>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Left: Package info panel */}
        <div className="flex shrink-0" style={{ width: panelWidth }}>
          <div className="flex-1 min-w-0 border-r border-border overflow-y-auto p-4">
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

            {/* Author card */}
            <button
              type="button"
              onClick={() => {
                if (!username) return
                onFilterAuthor?.(username)
                onBack()
              }}
              disabled={!username}
              className="w-full flex items-center gap-2.5 mt-2.5 p-2 rounded-lg bg-elevated/50 text-left transition-colors hover:bg-elevated disabled:opacity-60 disabled:pointer-events-none"
            >
              <AuthorAvatar author={username} userId={pkg.user_id} size={32} />
              <div>
                <div className="text-xs text-text-primary font-medium">{username}</div>
                <div className="text-[10px] text-text-tertiary">Package author</div>
              </div>
            </button>

            {pkg.promotional_link && (
              <a
                title={pkg.promotional_link}
                onClick={(e) => {
                  e.preventDefault()
                  void window.api.shell.openExternal(pkg.promotional_link)
                }}
                className="flex items-center gap-1.5 mt-1.5 px-2 py-1 text-[10px] text-accent-blue hover:brightness-125 transition-[filter] cursor-pointer"
              >
                <Heart size={10} /> Support this creator
              </a>
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
              <span className="flex items-center gap-1.5 text-text-tertiary">
                <Heart size={13} />
                <span className="text-text-primary font-medium">
                  {formatNumber(parseInt(pkg.rating_count || '0', 10))}
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-text-tertiary">
                <Star size={13} />
                <span className="text-text-primary font-medium">{formatStarRating(pkg.rating_avg)}</span>
              </span>
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
                    <DepTree deps={deps} />
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
            <Button variant="ghost" size="icon-sm" onClick={reload}>
              <RotateCw size={13} />
            </Button>
            <div className="flex-1 min-w-0 h-7 bg-elevated border border-border rounded px-2.5 flex items-center gap-2 text-[11px] text-text-secondary font-mono truncate ml-1 select-text cursor-text">
              <Globe size={12} className="text-text-tertiary shrink-0" />
              {displayUrl}
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
                onClick={() => setBrowserTab(tab.key)}
                className={`px-4 py-2 text-xs border-b-2 transition-colors cursor-pointer ${browserTab === tab.key ? 'border-accent-blue text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Webview */}
          <div className="flex-1 min-h-0">
            <webview
              key={String(resourceId)}
              ref={webviewRef}
              src={targetUrl}
              partition="persist:hub"
              allowpopups
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

function DepTree({ deps }) {
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
        <DepRow key={dep.ref || i} dep={dep} depth={depth} renderChildren={false} />
      ))}
    </>
  )
}
