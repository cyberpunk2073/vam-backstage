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
  Calendar,
  Clock,
  Plus,
  Pin,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  TYPE_COLORS,
  HUB_CATEGORY_COLORS,
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
import { useViewStore } from '@/stores/useViewStore'
import { useInstalledStore } from '@/stores/useInstalledStore'
import { useHubInstallState } from '@/hooks/useHubInstallState'
import { useHubInteractions } from '@/hooks/useHubInteractions'
import { AuthorAvatar, DepRow } from '@/components/PackageCard'
import ResizeHandle from '@/components/ResizeHandle'
import { usePersistedPanelWidth } from '@/hooks/usePersistedPanelWidth'
import { useIsDev } from '@/hooks/useIsDev'
import { getHubResourceLicense } from '@/lib/licenses'
import { LicenseTag } from '@/components/LicenseTag'
import { Tag } from '@/components/ui/tag'
import { toFullHubUrl } from '@/lib/hub-panel-url'

const HUB_INTERACTIONS_ENABLED = true

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

export default function HubDetail({
  resource,
  onBack,
  onClose,
  onNavigate,
  onInstall,
  onFilterAuthor,
  onPrev,
  onNext,
  canPrev,
  canNext,
  position,
  backLabel,
}) {
  const { detailData, detailLoading } = useHubStore()
  const detail = detailData
  // Hub stays mounted across tabs (<Activity>), so gate the Chromium guest on Hub
  // being active — otherwise it lingers in the background. The rest of the panel
  // stays mounted; returning restores the detail and reloads the guest page.
  const hubActive = useViewStore((s) => s.view === 'hub')
  const [browserTab, setBrowserTab] = useState('overview')
  const webviewRef = useRef(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)

  const resourceId = detail?.resource_id || resource.resource_id
  const threadId = detail?.discussion_thread_id
  // Full close (X / author filter) — falls back to onBack when not split.
  const handleClose = onClose || onBack

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
    // `hubActive` dep: reattach to the freshly-mounted <webview> on return to Hub.
  }, [resourceId, tabUrls, tabs, hubActive])

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
        resourceId: f.resource_id != null && f.resource_id !== '' ? String(f.resource_id) : null,
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

  const handleNavigateDep = useCallback(
    (targetId) => {
      const rid = String(targetId)
      if (!rid || rid === String(resourceId)) return
      const store = useHubStore.getState()
      const known = store.resources?.find((r) => String(r.resource_id) === rid)
      store.openDetail(known || { resource_id: rid }, { pushHistory: true })
    },
    [resourceId],
  )

  const hubUrl = `https://hub.virtamate.com/resources/${resourceId}`
  const externalOpenUrl = pkg.download_url || pkg.external_url || hubUrl
  // Address-bar copy / open-in-browser: map known *-panel URLs to full pages.
  const fullBrowserUrl = toFullHubUrl(displayUrl)

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
        <div className="flex items-center gap-1 shrink-0 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            title={backLabel ? `Back to ${backLabel}` : 'Back to gallery'}
            className="text-text-secondary hover:text-text-primary min-w-0 max-w-[min(280px,40vw)]"
          >
            <ArrowLeft size={14} className="shrink-0" />
            <span className="truncate">{backLabel ? `Back to ${backLabel}` : 'Back'}</span>
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
          onClick={handleClose}
          aria-label="Close detail"
          className="shrink-0 text-text-tertiary hover:text-text-secondary hover:bg-muted/35"
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
                  handleClose()
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
                    <DepTree deps={deps} onInstall={handleInstallDep} onNavigate={handleNavigateDep} />
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
                navigator.clipboard.writeText(fullBrowserUrl).then(() => {
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
                href={fullBrowserUrl}
                target="_blank"
                rel="noreferrer"
                title="Open in browser"
                onClick={(e) => {
                  e.preventDefault()
                  void window.api.shell.openExternal(fullBrowserUrl)
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

          {/* Webview — only mounted while Hub is the active view (see hubActive) */}
          <div className="flex-1 min-h-0">
            {hubActive && (
              <webview
                key={browserResourceId}
                ref={webviewRef}
                src={navUrl}
                partition="persist:hub"
                allowpopups="true"
                className="w-full h-full"
                style={{ display: 'flex', pointerEvents: hubPanelResizeDrag ? 'none' : 'auto' }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Expandable dep list for hub detail ---

function DepTree({ deps, onInstall, onNavigate }) {
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
        <DepRow
          key={dep.ref || i}
          dep={dep}
          depth={depth}
          renderChildren={false}
          onInstall={onInstall}
          onNavigate={onNavigate}
        />
      ))}
    </>
  )
}
