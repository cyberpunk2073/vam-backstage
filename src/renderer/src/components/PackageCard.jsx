import { useState, useEffect } from 'react'
import {
  AlertTriangle,
  Archive,
  HardDrive,
  Layers,
  Eye,
  EyeOff,
  Power,
  Star,
  Download,
  ThumbsUp,
  Plus,
  Library,
  Clock,
  ExternalLink,
  Check,
  Pin,
  Trash2,
} from 'lucide-react'
import {
  getGradient,
  getContentGradient,
  TYPE_COLORS,
  HUB_CATEGORY_COLORS,
  libraryTypeBadgeLabel,
  libraryTypeBadgeColor,
  getAuthorColor,
  getAuthorInitials,
  formatBytes,
  formatNumber,
  formatStarRating,
  displayName,
  contentPackageLabel,
  extractDomainLabel,
  THUMB_OVERLAY_CHIP,
} from '@/lib/utils'
import { isLocalPackage } from '@shared/local-package.js'
import { isPackageActive } from '@shared/storage-state-predicates.js'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { TruncateWithTooltip } from './TruncateWithTooltip'
import { useThumbnail, useAvatar } from '@/hooks/createBlobCacheHook'
import { useHubInstallState } from '@/hooks/useHubInstallState'
import { useDownloadStore } from '@/stores/useDownloadStore'
import { useLibraryStore } from '@/stores/useLibraryStore'
import { useWishlistStore } from '@/stores/useWishlistStore'
import { LabelDots } from '@/components/labels/LabelDots'
import { useLabelObjects } from '@/components/labels/useLabelObjects'

/**
 * Derive the "inactive package" visual state (`disabled` or `offloaded`) and
 * whether the user wants those cards dimmed (corner icon) vs full-color (chip).
 */
function useInactiveStyle(pkg) {
  const dimInactive = useLibraryStore((s) => s.dimInactive)
  const isOffloaded = pkg.storageState === 'offloaded'
  const isDisabled = pkg.storageState === 'disabled'
  const inactive = isOffloaded || isDisabled
  return { isOffloaded, isDisabled, inactive, dim: inactive && dimInactive }
}

const inactiveTitle = (isOffloaded) => (isOffloaded ? 'Package offloaded' : 'Package disabled')

/**
 * Describe a package's dependency problems (missing and/or disabled+offloaded)
 * in two shapes so each surface renders consistently:
 *  - `summary`: one consolidated worded label for contexts that show words —
 *    `N missing`, `N disabled`, or `N issues` (total) when mixed, with the
 *    highest-severity icon.
 *  - `segments`: per-type icon+count pairs for icon-only contexts (minimal
 *    card, table, compressed footer), where no words means no crowding.
 * `packageActive` gates the inactive signal — an already-inactive package's
 * inactive deps are expected, not a flag. Returns null when there are no issues.
 */
export function depIssues(pkg, packageActive) {
  const missing = pkg.missingDeps || 0
  const inactive = packageActive ? pkg.inactiveDeps || 0 : 0
  if (!missing && !inactive) return null
  const plural = (n) => (n === 1 ? 'y' : 'ies')
  const segments = []
  // Disabled/offloaded (fixable locally) sits left; missing (may be unresolvable) sits right.
  if (inactive) {
    segments.push({
      key: 'inactive',
      Icon: Power,
      count: inactive,
      tone: 'text-warning',
      title: `${inactive} disabled or offloaded dependenc${plural(inactive)}`,
    })
  }
  if (missing) {
    segments.push({
      key: 'missing',
      Icon: AlertTriangle,
      count: missing,
      tone: 'text-warning',
      title: `${missing} missing dependenc${plural(missing)}`,
    })
  }
  let summary
  if (missing && inactive)
    summary = { Icon: AlertTriangle, count: missing + inactive, word: 'issues', tone: 'text-warning' }
  else if (missing) summary = { Icon: AlertTriangle, count: missing, word: 'missing', tone: 'text-warning' }
  else summary = { Icon: Power, count: inactive, word: 'disabled', tone: 'text-warning' }
  return { segments, summary, title: segments.map((s) => s.title).join(' · ') }
}

/** Drop-shadow for outline/stroke glyphs sitting directly on a thumbnail (Power, Eye, EyeOff, Archive). */
const THUMB_OUTLINE_ICON_SHADOW =
  '[&_svg]:filter-[drop-shadow(0_0_1px_rgba(0,0,0,1))_drop-shadow(0_0_2.5px_rgba(0,0,0,1))_drop-shadow(0_0_5px_rgba(0,0,0,1))_drop-shadow(0_1px_10px_rgba(0,0,0,0.85))]'

/** Drop-shadow for filled glyphs (Star). Filled shapes cast more shadow, so it's lighter than outline. */
const THUMB_FILLED_ICON_SHADOW =
  '[&_svg]:filter-[drop-shadow(0_0_1.5px_rgba(0,0,0,1))_drop-shadow(0_0_3px_rgba(0,0,0,1))_drop-shadow(0_1px_8px_rgba(0,0,0,0.9))]'

/** LibraryCard top-right corner glyph layout. Caller adds the color and the appropriate shadow. */
const LIB_CARD_CORNER_ICON = 'shrink-0 size-[18px] inline-flex items-center justify-center'

/** Eased bottom scrim: gentle top tail (no visible start line), steepest mid, soft vignette into peak. */
const scrimGradient = (peak) =>
  `linear-gradient(to top, rgba(0,0,0,${peak}) 0%, rgba(0,0,0,${peak * 0.91}) 15%, rgba(0,0,0,${peak * 0.81}) 28%, rgba(0,0,0,${peak * 0.7}) 40%, rgba(0,0,0,${peak * 0.59}) 51%, rgba(0,0,0,${peak * 0.47}) 61%, rgba(0,0,0,${peak * 0.35}) 70%, rgba(0,0,0,${peak * 0.24}) 78%, rgba(0,0,0,${peak * 0.15}) 85%, rgba(0,0,0,${peak * 0.08}) 91%, rgba(0,0,0,${peak * 0.03}) 96%, transparent 100%)`

/** Subtle drop-shadow lift so a compact action button reads as a control floating over the thumbnail. */
const THUMB_ACTION_BTN_SHADOW = 'shadow-[0_1px_2px_rgba(0,0,0,0.55),0_2px_6px_rgba(0,0,0,0.35)]'

/** Lift + inset white edge for borderless (gradient) action buttons that would otherwise blend into bright thumbnails. */
const THUMB_ACTION_BTN_POP = `${THUMB_ACTION_BTN_SHADOW} ring-1 ring-inset ring-white/15`

/** Non-interactive bulk-selection marker; whole card handles clicks */
function BulkSelectChip({ checked }) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      className={`shrink-0 inline-flex items-center justify-center size-[18px] rounded border pointer-events-none ${
        checked ? 'bg-accent-blue border-accent-blue text-white' : 'border-white/35 bg-black/45 backdrop-blur-sm'
      }`}
    >
      {checked ? <Check size={11} strokeWidth={3} /> : null}
    </span>
  )
}

export function AuthorAvatar({ author, userId, size = 18 }) {
  const avatarUrl = useAvatar(userId)
  const radius = Math.max(3, size * 0.18)
  if (!avatarUrl) {
    return (
      <div
        className="shrink-0 flex items-center justify-center text-white font-semibold select-none"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: getAuthorColor(author),
          fontSize: size * 0.42,
        }}
      >
        {getAuthorInitials(author)}
      </div>
    )
  }
  return (
    <Avatar className="after:hidden" style={{ width: size, height: size, borderRadius: radius }}>
      <AvatarImage src={avatarUrl} alt={author} style={{ borderRadius: radius }} />
      <AvatarFallback
        className="text-white font-semibold"
        style={{ background: getAuthorColor(author), fontSize: size * 0.42, borderRadius: radius }}
      >
        {getAuthorInitials(author)}
      </AvatarFallback>
    </Avatar>
  )
}

export function AuthorLink({ author, className = '', onFilterAuthor }) {
  const handleClick = (e) => {
    e.stopPropagation()
    if (author && onFilterAuthor) onFilterAuthor(author)
  }
  return (
    <span className={`cursor-pointer hover:brightness-150 transition-[filter] ${className}`} onClick={handleClick}>
      {author}
    </span>
  )
}

export function HubCard({
  resource,
  onClick,
  onViewInLibrary,
  onInstall,
  onPromote,
  onFilterAuthor,
  mode = 'medium',
  hideType,
  linkAction,
  /** Wishlist gallery card: render from the disk-cached hub thumbnail and show an "unavailable" chip. */
  wishlist = false,
}) {
  const minimal = mode === 'minimal'
  const isPaid = resource.category === 'Paid'
  const isExternal = resource.hubDownloadable === 'false' || resource.hubDownloadable === false
  const typeColor = TYPE_COLORS[resource.type] || '#6366f1'

  const rid = String(resource.resource_id)
  const { state: installState, dlInfo, installStatus } = useHubInstallState(rid, { isExternal })
  const libRef = installStatus.filename || resource._localFilename

  const wishlisted = useWishlistStore((s) => s.ids.has(rid))
  const toggleWishlist = useWishlistStore((s) => s.toggle)
  const showWishlistToggle = !linkAction

  let actionBtn
  if (installState === 'downloading') {
    const p = dlInfo.progress
    actionBtn = minimal ? (
      <div className="px-2 py-1 rounded text-[10px] text-white font-medium relative overflow-hidden bg-white/6">
        <div
          className="absolute inset-y-0 left-0 progress-bar rounded transition-[width] duration-200"
          style={{ width: `${Math.max(p, 5)}%` }}
        />
        <span className="relative z-10">
          {dlInfo.completed}/{dlInfo.total} · {p}%
        </span>
      </div>
    ) : (
      <div className="w-full py-1.5 relative rounded overflow-hidden bg-white/6">
        <div
          className="absolute inset-y-0 left-0 progress-bar rounded transition-[width] duration-200"
          style={{ width: `${Math.max(p, 3)}%` }}
        />
        <span className="relative z-10 flex items-center justify-center gap-1 text-[10px] text-white font-medium tracking-wide whitespace-nowrap">
          <span className="@max-[179px]:hidden">Downloading</span>
          <span>
            {dlInfo.completed}/{dlInfo.total} · {p}%
          </span>
        </span>
      </div>
    )
  } else if (installState === 'queued') {
    actionBtn = (
      <div
        className={
          minimal
            ? `px-2 py-1 rounded text-[10px] text-white/60 border border-white/10 bg-black/50 backdrop-blur-sm flex items-center gap-1 ${THUMB_ACTION_BTN_SHADOW}`
            : 'w-full py-1.5 rounded text-[10px] text-text-tertiary border border-border flex items-center justify-center gap-1.5 whitespace-nowrap'
        }
      >
        <Clock size={minimal ? 10 : 11} /> Queued…
      </div>
    )
  } else if (installState === 'installed') {
    actionBtn = (
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (libRef) onViewInLibrary?.({ ...resource, _localFilename: libRef })
        }}
        disabled={!libRef}
        className={
          minimal
            ? `px-2 py-1 rounded text-[10px] text-accent-blue border border-accent-blue/25 bg-black/50 backdrop-blur-sm hover:bg-accent-blue/20 flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-40 disabled:pointer-events-none ${THUMB_ACTION_BTN_SHADOW}`
            : 'w-full py-1.5 rounded text-[10px] text-accent-blue border border-accent-blue/25 hover:bg-accent-blue/10 flex items-center justify-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap disabled:opacity-40 disabled:pointer-events-none'
        }
      >
        {minimal ? (
          <>
            <Library size={10} /> View
          </>
        ) : (
          <>
            <Library size={11} className="@max-[159px]:hidden shrink-0" />
            <span className="hidden @max-[159px]:inline">View</span>
            <span className="@max-[159px]:hidden">View in Library</span>
          </>
        )}
      </button>
    )
  } else if (installState === 'installed-dep') {
    actionBtn = (
      <Button
        variant="gradient"
        onClick={(e) => {
          e.stopPropagation()
          if (installStatus.filename) onPromote?.(installStatus.filename, resource.resource_id)
          else onInstall?.(resource)
        }}
        className={
          minimal
            ? `px-2 py-1 h-auto rounded text-[10px] gap-1 ${THUMB_ACTION_BTN_POP}`
            : 'w-full py-1.5 h-auto rounded text-[10px] gap-1.5 whitespace-nowrap'
        }
      >
        {minimal ? (
          <>
            <Plus size={10} /> Add
          </>
        ) : (
          <>
            <Plus size={11} className="@max-[159px]:hidden shrink-0" />
            <span className="hidden @max-[159px]:inline">Add</span>
            <span className="@max-[159px]:hidden">Add to Library</span>
          </>
        )}
      </Button>
    )
  } else if (installState === 'external') {
    const externalUrl =
      resource.download_url || resource.external_url || `https://hub.virtamate.com/resources/${resource.resource_id}`
    const externalTitle = extractDomainLabel(externalUrl)
    actionBtn = (
      <button
        type="button"
        title={externalUrl}
        onClick={(e) => {
          e.stopPropagation()
          void window.api.shell.openExternal(externalUrl)
        }}
        className={
          minimal
            ? `max-w-[min(100%,9rem)] px-2 py-1 rounded text-[10px] text-accent-blue border border-accent-blue/25 bg-black/50 backdrop-blur-sm hover:bg-accent-blue/20 flex items-center gap-1 cursor-pointer transition-colors min-w-0 ${THUMB_ACTION_BTN_SHADOW}`
            : 'w-full py-1.5 rounded text-[10px] text-accent-blue border border-accent-blue/25 hover:bg-accent-blue/10 flex items-center justify-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap'
        }
      >
        <ExternalLink size={minimal ? 10 : 11} className="shrink-0 @max-[159px]:hidden" />
        <span className={minimal ? 'truncate min-w-0' : 'truncate min-w-0'}>{externalTitle}</span>
      </button>
    )
  } else if (installState === 'failed') {
    const retrySuffix =
      !minimal && resource._installSizeBytes != null ? ` · ${formatBytes(resource._installSizeBytes)}` : ''
    actionBtn = (
      <button
        onClick={(e) => {
          e.stopPropagation()
          onInstall?.(resource)
        }}
        className={
          minimal
            ? `px-2 py-1 rounded text-[10px] text-error border border-error/25 bg-black/50 backdrop-blur-sm flex items-center gap-1 cursor-pointer ${THUMB_ACTION_BTN_SHADOW}`
            : 'w-full py-1.5 rounded text-[10px] text-error border border-error/25 hover:bg-error/10 flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap'
        }
      >
        <Download size={minimal ? 10 : 11} /> Retry{retrySuffix}
      </button>
    )
  } else {
    const sizeSuffix =
      !minimal && resource._installSizeBytes != null ? ` · ${formatBytes(resource._installSizeBytes)}` : ''
    actionBtn = (
      <Button
        variant="gradient"
        onClick={(e) => {
          e.stopPropagation()
          onInstall?.(resource)
        }}
        className={
          minimal
            ? `px-2 py-1 h-auto rounded text-[10px] gap-1 ${THUMB_ACTION_BTN_POP}`
            : 'w-full py-1.5 h-auto rounded text-[10px] gap-1.5 tracking-wide whitespace-nowrap'
        }
      >
        <Download size={minimal ? 10 : 11} className="@max-[129px]:hidden shrink-0" /> Install{sizeSuffix}
      </Button>
    )
  }

  const finalBtn = linkAction ?? actionBtn

  const imgUrl = resource.image_url
  const gradientId = resource.resource_id || resource.title || ''
  const [thumbFailed, setThumbFailed] = useState(false)
  useEffect(() => {
    setThumbFailed(false)
  }, [imgUrl])
  // Wishlist cards read the disk-cached (resource-id keyed) thumbnail so they
  // still render after the resource disappears from the Hub; hub search cards
  // hotlink image_url with a gradient fallback on load error.
  const hubResThumb = useThumbnail(wishlist ? `hub-icon:${rid}` : null)
  const shownThumb = wishlist ? hubResThumb : imgUrl && !thumbFailed ? imgUrl : null
  const unavailable = wishlist && !!resource._unavailable

  return (
    <div
      className={`@container group w-full min-w-0 bg-surface border rounded-lg overflow-hidden text-left transition-all duration-150 flex flex-col border-border ${
        linkAction ? '' : 'card-glow cursor-pointer hover:bg-elevated'
      }`}
    >
      <div onClick={linkAction ? undefined : () => onClick?.(resource)} className="flex-1">
        <div className="relative aspect-square">
          <div className="absolute inset-0" style={{ background: getGradient(String(gradientId)) }} />
          {shownThumb ? <div className="absolute inset-0 bg-elevated" /> : null}
          {shownThumb ? (
            <img
              src={shownThumb}
              className={`thumb absolute inset-0 w-full h-full object-cover ${unavailable ? 'grayscale opacity-60' : ''}`}
              alt=""
              loading="lazy"
              onError={wishlist ? undefined : () => setThumbFailed(true)}
            />
          ) : null}
          <div className="absolute inset-0 bg-linear-to-t from-black/40 to-transparent" />
          {(unavailable || !hideType || isPaid) && (
            <div className="absolute top-2 left-2 z-2 flex max-w-[calc(100%-2.75rem)] items-center gap-1 overflow-x-auto scrollbar-hide flex-nowrap">
              {unavailable ? (
                <div
                  className={`${THUMB_OVERLAY_CHIP} bg-warning/25 text-warning backdrop-blur-sm`}
                  title="No longer available on the Hub — showing your saved snapshot"
                >
                  unavailable
                </div>
              ) : (
                !hideType && (
                  <div className={`${THUMB_OVERLAY_CHIP} text-white`} style={{ background: typeColor + 'cc' }}>
                    {resource.type}
                  </div>
                )
              )}
              {isPaid && (
                <div
                  className={`${THUMB_OVERLAY_CHIP} text-white`}
                  style={{ background: HUB_CATEGORY_COLORS.Paid + 'cc' }}
                >
                  Paid
                </div>
              )}
            </div>
          )}
          {showWishlistToggle && (
            <div className="absolute top-1.5 right-1.5 z-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleWishlist(resource)
                }}
                title={wishlist || wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
                aria-label={wishlist || wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
                className={
                  wishlist
                    ? 'size-7 shrink-0 inline-flex items-center justify-center rounded transition cursor-pointer text-white/70 bg-black/50 backdrop-blur-sm opacity-0 group-hover:opacity-100 hover:text-error'
                    : `size-7 shrink-0 inline-flex items-center justify-center rounded transition cursor-pointer ${
                        wishlisted
                          ? `text-accent-blue opacity-100 bg-transparent ${THUMB_FILLED_ICON_SHADOW} group-hover:bg-black/50 group-hover:backdrop-blur-sm`
                          : 'text-white/60 bg-black/50 backdrop-blur-sm opacity-0 group-hover:opacity-100'
                      }`
                }
              >
                {wishlist ? <Trash2 size={13} /> : <Pin size={13} fill={wishlisted ? 'currentColor' : 'none'} />}
              </button>
            </div>
          )}
          {minimal && (
            <div
              className="absolute bottom-0 inset-x-0 flex items-end gap-2 px-2.5 pb-2 pt-8"
              style={{ background: scrimGradient(0.58) }}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-white truncate leading-tight" title={resource.title}>
                  {resource.title}
                </div>
                <div className="text-[10px] text-white/60 truncate">
                  by{' '}
                  <span
                    className="cursor-pointer hover:text-white transition-colors"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (resource.username && onFilterAuthor) onFilterAuthor(resource.username)
                    }}
                    title={resource.username}
                  >
                    {resource.username}
                  </span>
                </div>
              </div>
              <div className="shrink-0 mb-[1.5px]">{finalBtn}</div>
            </div>
          )}
        </div>
        {!minimal && (
          <div className="p-3 pb-0 min-w-0">
            <div className="flex items-center gap-2">
              <AuthorAvatar author={resource.username} userId={resource.user_id} size={30} />
              <div className="min-w-0 flex-1">
                <div
                  className="text-[13px] font-medium text-text-primary truncate leading-tight"
                  title={resource.title}
                >
                  {resource.title}
                </div>
                <div className="text-[11px] text-text-secondary truncate">
                  by <AuthorLink author={resource.username} onFilterAuthor={onFilterAuthor} />
                </div>
              </div>
            </div>
            <div className="flex flex-nowrap items-center gap-2 @min-[240px]:gap-3 mt-2 min-h-[18px] text-[10px] text-text-tertiary leading-none">
              <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap tabular-nums">
                <Download size={11} className="shrink-0 opacity-80" />
                {formatNumber(parseInt(resource.download_count || '0', 10))}
              </span>
              <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap tabular-nums @max-[120px]:hidden">
                <ThumbsUp size={11} className="shrink-0 opacity-80" />
                {formatNumber(parseInt(resource.reaction_score || '0', 10))}
              </span>
              <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap tabular-nums @max-[150px]:hidden">
                <Star size={11} className="shrink-0 opacity-80" />
                {formatStarRating(resource.rating_avg)}
              </span>
            </div>
          </div>
        )}
      </div>
      {!minimal && <div className="px-3 pb-3 pt-2 min-w-0">{finalBtn}</div>}
    </div>
  )
}

export function LibraryCard({
  pkg,
  onClick,
  selected,
  onFilterAuthor,
  mode = 'medium',
  hideType,
  bulkMode = false,
  bulkSelected = false,
  dimmed = false,
}) {
  const minimal = mode === 'minimal'
  const inactiveStyle = useInactiveStyle(pkg)
  const { isOffloaded, inactive } = inactiveStyle
  const dim = inactiveStyle.dim || dimmed
  const depIssue = depIssues(pkg, !inactive)
  const name = displayName(pkg)
  const thumbUrl = useThumbnail(`pkg:${pkg.filename}`)
  const versionStr = pkg.version != null && pkg.version !== '' ? String(pkg.version) : null
  const showBulk = bulkMode || bulkSelected
  const labelObjs = useLabelObjects(pkg.labelIds)

  return (
    <button
      type="button"
      data-grid-card
      tabIndex={-1}
      onClick={(e) => onClick?.(pkg, e)}
      className={`@container w-full bg-surface border rounded-lg overflow-hidden text-left transition-all duration-150 card-glow cursor-pointer shrink-0 group outline-none
        ${selected || bulkSelected ? 'border-accent-blue/40 bg-elevated' : 'border-border hover:bg-elevated'}
        ${dim ? 'opacity-60 hover:opacity-90' : ''}`}
    >
      <div
        className={`relative aspect-square ${dim ? 'saturate-25 brightness-80 group-hover:saturate-100 group-hover:brightness-100 transition-[filter] duration-200' : ''}`}
      >
        <div className="absolute inset-0" style={{ background: getGradient(pkg.filename) }} />
        {thumbUrl && <div className="absolute inset-0 bg-elevated" />}
        {thumbUrl && <img src={thumbUrl} className="thumb absolute inset-0 w-full h-full object-cover" alt="" />}
        <div className="absolute inset-0 bg-linear-to-t from-black/40 to-transparent" />
        {bulkSelected && <div className="absolute inset-0 bg-accent-blue/10 pointer-events-none" />}
        {(showBulk ||
          !hideType ||
          !pkg.isDirect ||
          pkg.isLocalOnly ||
          pkg.noLookPresetTag ||
          (minimal && !!depIssue)) && (
          <div className="absolute top-2 left-2 z-2 flex max-w-[calc(100%-2.75rem)] items-center gap-1 overflow-x-auto scrollbar-hide flex-nowrap">
            {bulkMode && <BulkSelectChip checked={bulkSelected} />}
            {!hideType && (
              <div
                className={`${THUMB_OVERLAY_CHIP} text-white`}
                style={{ background: libraryTypeBadgeColor(pkg.type) + 'cc' }}
              >
                {libraryTypeBadgeLabel(pkg.type)}
              </div>
            )}
            {pkg.noLookPresetTag && (
              <div
                className={`${THUMB_OVERLAY_CHIP} bg-white/15 text-white/80 backdrop-blur-sm gap-0.5`}
                title={
                  pkg.hasExtractedAppearancePreset
                    ? 'No preset items in this package, but a matching appearance preset has been extracted to your library'
                    : 'No Custom/Atom appearance, Saves/Person/Appearance, or Custom/Atom/Person/Skin items in this package'
                }
              >
                no preset
                {pkg.hasExtractedAppearancePreset && <Check size={11} strokeWidth={3} className="shrink-0" />}
              </div>
            )}
            {!pkg.isDirect && (
              <div
                className={`${THUMB_OVERLAY_CHIP} bg-accent-blue/30 text-accent-blue backdrop-blur-sm`}
                title="Installed only as a dependency of another package, not directly"
              >
                DEP
              </div>
            )}
            {pkg.isLocalOnly && (
              <div
                className={`${THUMB_OVERLAY_CHIP} bg-white/15 text-white/75 backdrop-blur-sm`}
                title="Not available on the hub"
              >
                LOCAL
              </div>
            )}
            {minimal &&
              depIssue &&
              depIssue.segments.map((s) => (
                <div
                  key={s.key}
                  className={`${THUMB_OVERLAY_CHIP} bg-warning/15 backdrop-blur-sm flex items-center gap-0.5 ${s.tone}`}
                  title={s.title}
                >
                  <s.Icon size={10} className="shrink-0" /> {s.count}
                </div>
              ))}
          </div>
        )}
        <div className="absolute top-2 right-2 flex items-center gap-1 z-1">
          {inactive && (
            <span
              className={`${LIB_CARD_CORNER_ICON} text-error ${THUMB_OUTLINE_ICON_SHADOW}`}
              title={inactiveTitle(isOffloaded)}
            >
              {isOffloaded ? <Archive size={11} className="shrink-0" /> : <Power size={11} className="shrink-0" />}
            </span>
          )}
          {pkg.isCorrupted && (
            <div
              className={`${THUMB_OVERLAY_CHIP} bg-error/25 text-error backdrop-blur-sm`}
              title="Unreadable file or invalid metadata"
            >
              CORRUPTED
            </div>
          )}
          {pkg.favoriteContentCount > 0 && (
            <span
              title={`${pkg.favoriteContentCount} favorited item${pkg.favoriteContentCount === 1 ? '' : 's'}`}
              className={`${LIB_CARD_CORNER_ICON} text-warning ${THUMB_FILLED_ICON_SHADOW}`}
            >
              <Star size={11} fill="currentColor" />
            </span>
          )}
        </div>
        {minimal && (
          <div className="absolute bottom-0 inset-x-0 px-2.5 pb-2 pt-8" style={{ background: scrimGradient(0.58) }}>
            <div className="flex items-baseline gap-1.5 min-w-0">
              <span className="text-[12px] font-medium text-white truncate leading-tight">{name}</span>
            </div>
            <div className="text-[10px] text-white/60 truncate">
              by{' '}
              <span
                className="cursor-pointer hover:text-white transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  if (pkg.creator && onFilterAuthor) onFilterAuthor(pkg.creator)
                }}
              >
                {pkg.creator}
              </span>
            </div>
          </div>
        )}
        <LabelDots labels={labelObjs} />
      </div>
      {!minimal && (
        <div className="p-3 min-w-0">
          <div className="flex items-center gap-2">
            <AuthorAvatar author={pkg.creator} userId={pkg.hubUserId} size={30} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-[13px] font-medium text-text-primary truncate min-w-0">{name}</span>
                {versionStr && (
                  <span className="text-[11px] text-text-tertiary font-mono shrink-0 whitespace-nowrap">
                    v{versionStr}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-text-secondary truncate">
                by <AuthorLink author={pkg.creator} onFilterAuthor={onFilterAuthor} />
              </div>
            </div>
          </div>
          <div className="flex w-full min-w-0 flex-nowrap items-center gap-2 @min-[240px]:gap-3 mt-2 min-h-[18px] text-[10px] text-text-tertiary leading-none">
            <span
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums"
              title={
                pkg.removableSize > 0
                  ? `${formatBytes(pkg.sizeBytes)} package + ${formatBytes(pkg.removableSize)} unique deps`
                  : 'Size on disk'
              }
            >
              <HardDrive size={11} className="shrink-0 opacity-80" />
              {formatBytes(pkg.sizeBytes + (pkg.removableSize || 0))}
            </span>
            <span
              className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden @max-[108px]:hidden"
              title={`${pkg.contentCount} items`}
            >
              <Layers size={11} className="shrink-0 flex-none opacity-80" />
              <span className="min-w-0 truncate tabular-nums">
                {pkg.contentCount}
                <span className="@max-[158px]:hidden"> items</span>
              </span>
            </span>
            {depIssue && (
              <span className="inline-flex shrink-0 items-center whitespace-nowrap tabular-nums" title={depIssue.title}>
                <span className={`hidden items-center gap-1 @min-[228px]:inline-flex ${depIssue.summary.tone}`}>
                  <depIssue.summary.Icon size={10} className="shrink-0" />
                  <span>{depIssue.summary.count}</span>
                  <span>{depIssue.summary.word}</span>
                </span>
                <span className="inline-flex items-center gap-2 @min-[228px]:hidden">
                  {depIssue.segments.map((s) => (
                    <span key={s.key} className={`inline-flex items-center gap-1 ${s.tone}`}>
                      <s.Icon size={10} className="shrink-0" />
                      <span>{s.count}</span>
                    </span>
                  ))}
                </span>
              </span>
            )}
          </div>
        </div>
      )}
    </button>
  )
}

export function LibraryTableRow({
  pkg,
  onClick,
  selected,
  onFilterAuthor,
  hideType,
  bulkMode = false,
  bulkSelected = false,
  onBulkToggle,
  dimmed = false,
}) {
  const typeColor = libraryTypeBadgeColor(pkg.type)
  const inactiveStyle = useInactiveStyle(pkg)
  const { isOffloaded, inactive } = inactiveStyle
  const dim = inactiveStyle.dim || dimmed
  const depIssue = depIssues(pkg, !inactive)
  const name = displayName(pkg)
  const versionStr = pkg.version != null && pkg.version !== '' ? String(pkg.version) : null
  const thumbUrl = useThumbnail(`pkg:${pkg.filename}`)

  return (
    <div
      onClick={(e) => onClick?.(pkg, e)}
      className={`flex items-center cursor-pointer transition-colors border-b border-border h-full ${selected || bulkSelected ? 'bg-elevated' : 'hover:bg-elevated/50'} ${dim ? 'opacity-60 hover:opacity-90' : ''}`}
    >
      {bulkMode && (
        <div
          className="w-8 shrink-0 flex items-center justify-center self-stretch border-r border-border/50"
          onClick={(e) => {
            e.stopPropagation()
            onBulkToggle?.(pkg)
          }}
        >
          <BulkSelectChip checked={bulkSelected} />
        </div>
      )}
      <div className="flex-3 py-2 px-3 flex items-center gap-2.5 min-w-0">
        <div className="w-7 h-7 rounded shrink-0 overflow-hidden relative">
          <div className="absolute inset-0" style={{ background: getGradient(pkg.filename) }} />
          {thumbUrl && <div className="absolute inset-0 bg-elevated" />}
          {thumbUrl && <img src={thumbUrl} className="thumb absolute inset-0 w-full h-full object-cover" alt="" />}
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[12px] font-medium text-text-primary truncate">{name}</span>
            {versionStr && <span className="text-[10px] text-text-tertiary font-mono shrink-0">v{versionStr}</span>}
          </div>
          <div className="text-[10px] text-text-tertiary truncate">{pkg.filename}</div>
        </div>
      </div>
      <div
        className={`flex-2 py-2 px-3 text-[11px] truncate ${pkg.creator && onFilterAuthor ? 'text-text-secondary cursor-pointer hover:brightness-150 transition-[filter]' : 'text-text-secondary'}`}
        onClick={
          pkg.creator && onFilterAuthor
            ? (e) => {
                e.stopPropagation()
                onFilterAuthor(pkg.creator)
              }
            : undefined
        }
      >
        {pkg.creator}
      </div>
      {!hideType && (
        <div className="flex-1 py-2 px-3">
          <span className={THUMB_OVERLAY_CHIP} style={{ color: typeColor, background: typeColor + '18' }}>
            {libraryTypeBadgeLabel(pkg.type)}
          </span>
        </div>
      )}
      <div className="flex-1 py-2 px-3 flex items-center justify-start gap-0 flex-nowrap text-[10px]">
        {pkg.isCorrupted ? (
          <span
            className="whitespace-nowrap text-error font-medium"
            title="Package file is unreadable or has invalid metadata"
          >
            Corrupted
          </span>
        ) : inactive ? (
          <span className="whitespace-nowrap text-warning inline-flex items-center gap-1">
            {isOffloaded ? <Archive size={10} className="shrink-0" /> : <Power size={10} className="shrink-0" />}
            {isOffloaded ? 'Offloaded' : 'Disabled'}
          </span>
        ) : pkg.isDirect ? (
          <span className="whitespace-nowrap text-success">Installed</span>
        ) : (
          <span
            className="whitespace-nowrap text-accent-blue"
            title="Installed only as a dependency of another package, not directly"
          >
            Dep
          </span>
        )}
        {pkg.isLocalOnly && (
          <span className="whitespace-nowrap text-text-tertiary" title="Not available on the hub">
            {' · Local'}
          </span>
        )}
      </div>
      <div
        className="flex-1 py-2 px-3 text-[11px] text-text-secondary font-mono"
        title={
          pkg.removableSize > 0
            ? `${formatBytes(pkg.sizeBytes)} package + ${formatBytes(pkg.removableSize)} unique deps`
            : undefined
        }
      >
        {formatBytes(pkg.sizeBytes + (pkg.removableSize || 0))}
      </div>
      <div
        className="w-16 py-2 px-3 text-[11px] text-text-tertiary flex items-center gap-1 min-w-0"
        title={
          pkg.favoriteContentCount > 0
            ? pkg.favoriteContentCount === 1
              ? '1 favorited item'
              : `${pkg.favoriteContentCount} favorited items`
            : undefined
        }
      >
        {pkg.favoriteContentCount > 0 && <Star size={12} className="text-warning shrink-0" fill="currentColor" />}
        <span className="tabular-nums">{pkg.contentCount}</span>
      </div>
      <div className="w-14 py-2 px-3">
        {depIssue ? (
          <span className="inline-flex items-center gap-1.5 text-[10px]" title={depIssue.title}>
            {depIssue.segments.map((s) => (
              <span key={s.key} className={`inline-flex items-center gap-0.5 ${s.tone}`}>
                <s.Icon size={10} className="shrink-0" /> {s.count}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-[10px] text-text-tertiary">{pkg.depCount}</span>
        )}
      </div>
    </div>
  )
}

export function ContentTableRow({
  item,
  selected,
  hideType,
  onClick,
  onFilterAuthor,
  onToggleHidden,
  onToggleFavorite,
  bulkMode = false,
  bulkSelected = false,
  onBulkToggle,
  /** When true, user-hidden items render at full saturation/opacity (e.g. Hidden visibility filter). Inactive-package dimming follows Settings → dim inactive packages. */
  suppressHiddenDimming = false,
}) {
  const typeColor = TYPE_COLORS[item.category] || '#6366f1'
  const isHidden = item.hidden
  const isExtracted = !!item.extractedFrom
  const ownerPkg = item.sourcePackage ?? item.package
  const isDisabledPkg = item.localDisabled || !isPackageActive(ownerPkg?.storageState ?? 'enabled')
  const dimInactive = useLibraryStore((s) => s.dimInactive)
  const dimHiddenChrome = (isHidden && !suppressHiddenDimming) || (isDisabledPkg && dimInactive)
  const thumbKey = item.thumbnailPath ? `ct:${item.packageFilename}\0${item.thumbnailPath}` : null
  const thumbUrl = useThumbnail(thumbKey)
  const isLocalContent = isLocalPackage(item.packageFilename)
  const pkgLabel = contentPackageLabel(item)
  const creator = ownerPkg?.creator

  return (
    <div
      onClick={(e) => onClick?.(item, e)}
      className={`flex items-center cursor-pointer transition-colors border-b border-border h-full ${selected || bulkSelected ? 'bg-elevated' : 'hover:bg-elevated/50'} ${dimHiddenChrome ? 'opacity-75 hover:opacity-100' : ''}`}
    >
      {bulkMode && (
        <div
          className="w-8 shrink-0 flex items-center justify-center self-stretch border-r border-border/50"
          onClick={(e) => {
            e.stopPropagation()
            onBulkToggle?.(item)
          }}
        >
          <BulkSelectChip checked={bulkSelected} />
        </div>
      )}
      <div className="flex-3 py-2 px-3 flex items-center gap-2.5 min-w-0">
        <div
          className={`w-7 h-7 rounded shrink-0 overflow-hidden relative ${dimHiddenChrome ? 'saturate-25 brightness-90' : ''}`}
        >
          <div
            className="absolute inset-0"
            style={{ background: getContentGradient(item.displayName, item.category) }}
          />
          {thumbUrl && <div className="absolute inset-0 bg-elevated" />}
          {thumbUrl && <img src={thumbUrl} className="thumb absolute inset-0 w-full h-full object-cover" alt="" />}
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[12px] font-medium text-text-primary truncate">{item.displayName}</span>
          </div>
          <div className="text-[10px] text-text-tertiary truncate flex items-center gap-1 min-w-0">
            {isDisabledPkg && <Power size={9} className="shrink-0 text-error" />}
            <span className="truncate">{pkgLabel}</span>
          </div>
        </div>
      </div>
      <div
        className={`flex-2 py-2 px-3 text-[11px] truncate ${dimHiddenChrome ? 'opacity-45' : ''} ${creator ? 'text-text-secondary cursor-pointer hover:brightness-150 transition-[filter]' : 'text-text-secondary'}`}
        onClick={
          creator && onFilterAuthor
            ? (e) => {
                e.stopPropagation()
                onFilterAuthor(creator)
              }
            : undefined
        }
      >
        {creator}
      </div>
      {!hideType && (
        <div className={`flex-1 min-w-0 py-2 px-3 ${dimHiddenChrome ? 'opacity-45' : ''}`}>
          <span className={THUMB_OVERLAY_CHIP} style={{ color: typeColor, background: typeColor + '18' }}>
            {item.category}
          </span>
        </div>
      )}
      <div className={`flex-1 min-w-0 py-2 px-3 ${dimHiddenChrome ? 'opacity-45' : ''}`}>
        <div className="flex w-full min-w-0 flex-nowrap items-center gap-1 overflow-x-auto scrollbar-hide">
          {item.tag && (
            <span
              className={`${THUMB_OVERLAY_CHIP} gap-0.5`}
              style={{
                color: item.tag.color,
                background: `color-mix(in srgb, ${item.tag.color} 14%, transparent)`,
              }}
              title={
                item.hasExtractedAppearancePreset
                  ? 'An appearance preset has already been extracted from this legacy look'
                  : undefined
              }
            >
              {item.tag.label}
              {item.hasExtractedAppearancePreset && <Check size={11} strokeWidth={3} className="shrink-0" />}
            </span>
          )}
          {isExtracted ? (
            <span
              className={`${THUMB_OVERLAY_CHIP} bg-cyan-400/15 text-cyan-300 shrink-0`}
              title="Preset extracted from this package's scene; follows the package lifecycle"
            >
              extracted
            </span>
          ) : (
            isLocalContent && (
              <span
                className={`${THUMB_OVERLAY_CHIP} bg-white/12 text-white/80 shrink-0`}
                title="Loose file in your VaM folder, not from a .var package"
              >
                local
              </span>
            )
          )}
        </div>
      </div>
      <div className="w-14 py-2 px-3 text-[11px]">
        {bulkMode ? (
          <span className={item.hidden ? 'text-error' : 'text-text-tertiary'}>
            {item.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
          </span>
        ) : (
          <button
            type="button"
            className={`cursor-pointer ${item.hidden ? 'text-error' : 'text-text-tertiary hover:text-text-secondary'}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggleHidden?.(item)
            }}
          >
            {item.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        )}
      </div>
      <div className="w-12 py-2 px-3 text-[11px]">
        {bulkMode ? (
          <span className={item.favorite ? 'text-warning' : 'text-text-tertiary'}>
            <Star size={12} fill={item.favorite ? 'currentColor' : 'none'} />
          </span>
        ) : (
          <button
            type="button"
            className={`cursor-pointer ${item.favorite ? 'text-warning' : 'text-text-tertiary hover:text-warning'}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggleFavorite?.(item)
            }}
          >
            <Star size={12} fill={item.favorite ? 'currentColor' : 'none'} />
          </button>
        )}
      </div>
    </div>
  )
}

export function ContentCard({
  item,
  onClick,
  selected,
  onToggleHidden,
  onToggleFavorite,
  hideType,
  bulkMode = false,
  bulkSelected = false,
  suppressHiddenDimming = false,
}) {
  const typeColor = TYPE_COLORS[item.category] || '#6366f1'
  const isHidden = item.hidden
  const isExtracted = !!item.extractedFrom
  const ownerPkg = item.sourcePackage ?? item.package
  const isDisabledPkg = item.localDisabled || !isPackageActive(ownerPkg?.storageState ?? 'enabled')
  const dimInactive = useLibraryStore((s) => s.dimInactive)
  const dimHiddenChrome = (isHidden && !suppressHiddenDimming) || (isDisabledPkg && dimInactive)
  const pkgLabel = contentPackageLabel(item)
  const thumbKey = item.thumbnailPath ? `ct:${item.packageFilename}\0${item.thumbnailPath}` : null
  const thumbUrl = useThumbnail(thumbKey)
  const showBulk = bulkMode || bulkSelected
  const isLocalContent = isLocalPackage(item.packageFilename)
  // Dots show *own* labels only — inherited (package) labels live visibly on the
  // package card. The hover tooltip still lists inherited labels for context so
  // users don't have to navigate to the package card to see the full set.
  const labelObjs = useLabelObjects(item.ownLabelIds)
  const inheritedLabelObjs = useLabelObjects(item.package?.labelIds)

  return (
    <div
      data-grid-card
      onClick={(e) => onClick?.(item, e)}
      className={`w-full bg-surface border rounded-lg overflow-hidden transition-all duration-150 card-glow cursor-pointer shrink-0 group outline-none
        ${selected || bulkSelected ? 'border-accent-blue/40 bg-elevated' : 'border-border hover:bg-elevated'}
        ${dimHiddenChrome ? 'opacity-75 hover:opacity-100' : ''}`}
    >
      <div className="relative aspect-square">
        <div
          className={`absolute inset-0 transition-[filter] duration-200 ${dimHiddenChrome ? 'saturate-25 brightness-90 group-hover:saturate-100 group-hover:brightness-100' : ''}`}
        >
          <div
            className="absolute inset-0"
            style={{ background: getContentGradient(item.displayName, item.category) }}
          />
          {thumbUrl && <div className="absolute inset-0 bg-elevated" />}
          {thumbUrl && <img src={thumbUrl} className="thumb absolute inset-0 w-full h-full object-cover" alt="" />}
          {dimHiddenChrome && (
            <div className="absolute inset-0 bg-base/15 transition-opacity duration-200 group-hover:opacity-0" />
          )}
        </div>
        {bulkSelected && <div className="absolute inset-0 bg-accent-blue/10 pointer-events-none z-1" />}
        {(showBulk || !hideType || item.tag || isLocalContent) && (
          <div className="absolute top-2 left-2 z-2 flex max-w-[calc(100%-2.75rem)] items-center gap-1 overflow-x-auto scrollbar-hide flex-nowrap">
            {bulkMode && <BulkSelectChip checked={bulkSelected} />}
            {!hideType && (
              <span className={`${THUMB_OVERLAY_CHIP} text-white`} style={{ background: typeColor + 'cc' }}>
                {item.category}
              </span>
            )}
            {item.tag && (
              <span
                className={`${THUMB_OVERLAY_CHIP} backdrop-blur-md gap-0.5`}
                style={{
                  color: item.tag.color,
                  background: `color-mix(in srgb, ${item.tag.color} 12%, rgba(0,0,0,0.3))`,
                  textShadow: `0 0 8px ${item.tag.color}60, 0 1px 2px rgba(0,0,0,0.8)`,
                }}
                title={
                  item.hasExtractedAppearancePreset
                    ? 'An appearance preset has already been extracted from this legacy look'
                    : undefined
                }
              >
                {item.tag.label}
                {item.hasExtractedAppearancePreset && <Check size={11} strokeWidth={3} className="shrink-0" />}
              </span>
            )}
            {isExtracted ? (
              <span
                className={`${THUMB_OVERLAY_CHIP} bg-cyan-400/20 text-cyan-200 backdrop-blur-sm`}
                title="Preset extracted from this package's scene; follows the package lifecycle"
              >
                extracted
              </span>
            ) : (
              isLocalContent && (
                <span
                  className={`${THUMB_OVERLAY_CHIP} bg-white/15 text-white/80 backdrop-blur-sm`}
                  title="Loose file in your VaM folder, not from a .var package"
                >
                  local
                </span>
              )
            )}
          </div>
        )}
        {/* Corner slot: disabled indicator; visibility/favorite are interactive except in bulk (static badges, like disabled) */}
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 z-2">
          {isDisabledPkg && (
            <div
              title="Package disabled"
              className={`size-7 shrink-0 inline-flex items-center justify-center rounded text-error ${THUMB_OUTLINE_ICON_SHADOW}`}
            >
              <Power size={13} />
            </div>
          )}
          <button
            type="button"
            disabled={bulkMode}
            onClick={(e) => {
              e.stopPropagation()
              onToggleHidden?.(item)
            }}
            className={`size-7 shrink-0 inline-flex items-center justify-center rounded transition ${bulkMode ? 'pointer-events-none' : 'cursor-pointer'} ${
              isHidden
                ? `opacity-100 text-error bg-transparent ${THUMB_OUTLINE_ICON_SHADOW} ${bulkMode ? '' : 'group-hover:text-error/70 group-hover:bg-black/50 group-hover:backdrop-blur-sm'}`
                : `opacity-0 text-white/70 bg-black/50 backdrop-blur-sm ${bulkMode ? '' : 'group-hover:opacity-100'}`
            }`}
          >
            {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            type="button"
            disabled={bulkMode}
            onClick={(e) => {
              e.stopPropagation()
              onToggleFavorite?.(item)
            }}
            className={`size-7 shrink-0 inline-flex items-center justify-center rounded transition ${bulkMode ? 'pointer-events-none' : 'cursor-pointer'} ${
              item.favorite
                ? `text-warning opacity-100 bg-transparent ${THUMB_FILLED_ICON_SHADOW} ${bulkMode ? '' : 'group-hover:bg-black/50 group-hover:backdrop-blur-sm'}`
                : `text-white/50 bg-black/50 backdrop-blur-sm opacity-0 ${bulkMode ? '' : 'group-hover:opacity-100'}`
            }`}
          >
            <Star size={13} fill={item.favorite ? 'currentColor' : 'none'} />
          </button>
        </div>
        <div className="absolute bottom-0 inset-x-0 px-2.5 pb-2 pt-8" style={{ background: scrimGradient(0.66) }}>
          <div className="text-[11px] font-medium text-white truncate leading-tight">{item.displayName}</div>
          <div className="text-[9px] text-white/50 truncate">{pkgLabel}</div>
        </div>
        <LabelDots labels={labelObjs} inheritedLabels={inheritedLabelObjs} />
      </div>
    </div>
  )
}

const TAG = 'text-[9px] font-medium px-2 py-0.5 rounded min-w-[4.5rem] text-center inline-block'

function depStatusTag(dep, dlStatus, dlProgress, onInstall) {
  // Installed status always takes priority over stale download data
  if (dep.resolution === 'exact' || dep.resolution === 'latest')
    return <span className={`${TAG} text-success bg-success/8`}>Installed</span>
  if (dep.resolution === 'fallback')
    return (
      <span
        title="Required version isn't available — using a different installed version as fallback"
        className={`${TAG} text-warning bg-warning/8`}
      >
        Fallback
      </span>
    )
  if (dlStatus === 'active')
    return (
      <span className={`${TAG} relative overflow-hidden bg-white/6`}>
        <span
          className="absolute inset-y-0 left-0 progress-bar rounded transition-[width] duration-300"
          style={{ width: `${Math.max(dlProgress, 8)}%` }}
        />
        <span className="relative text-white">{dlProgress}%</span>
      </span>
    )
  if (dlStatus === 'queued') return <span className={`${TAG} text-text-tertiary bg-white/4 animate-pulse`}>Queued</span>
  if (dlStatus === 'failed')
    return (
      <span title="Last download attempt failed" className={`${TAG} text-error bg-error/8`}>
        Failed
      </span>
    )
  if (dep.resolution === 'hub')
    return onInstall ? (
      <button
        type="button"
        title="Install from the hub"
        onClick={(e) => {
          e.stopPropagation()
          onInstall(dep)
        }}
        className={`${TAG} bg-linear-to-br from-[#3a7cf4] to-[#c740e8] text-white cursor-pointer hover:brightness-110 transition-all`}
      >
        Install
      </button>
    ) : (
      <span title="Available to install from the hub" className={`${TAG} text-accent-blue bg-accent-blue/8`}>
        On Hub
      </span>
    )
  return (
    <span title="Not found on the hub — no install source available" className={`${TAG} text-error bg-error/8`}>
      Missing
    </span>
  )
}

export function DepRow({ dep, depth = 0, renderChildren = true, onNavigate, onInstall }) {
  // `dep.ref` is the verbatim dep ref for display (may be flexible like ".latest").
  // `dep.downloadRef` is the concrete `packageName.N.var` the downloads table keys on;
  // fall back to `ref` for roots whose filename is already a concrete `.var`.
  const lookupKey = dep.downloadRef || dep.ref
  const dl = useDownloadStore((s) => {
    const d = s.byPackageRef.get(lookupKey)
    if (!d || d.status === 'completed' || d.status === 'cancelled') return null
    if (d.status === 'active') return `active|${s.liveProgress[d.id]?.progress ?? 0}`
    return d.status
  })
  // Optimistic queued state — set synchronously when the user clicks Install so
  // the row reacts before the IPC + fetchItems round-trip surfaces the real entry.
  const pendingDep = useDownloadStore((s) => s.pendingDepInstalls.has(lookupKey))
  const dlStatus = dl?.startsWith('active') ? 'active' : dl || (pendingDep ? 'queued' : null)
  const dlProgress = dl?.startsWith('active') ? Number(dl.split('|')[1]) || 0 : 0
  const canNavigate = !!dep.filename && !!onNavigate

  return (
    <>
      <div
        onClick={canNavigate ? () => onNavigate(dep.filename) : undefined}
        className={`flex items-center gap-2 py-1.5 transition-colors ${canNavigate ? 'cursor-pointer' : ''} ${dep.isRoot ? 'bg-elevated/30' : 'hover:bg-elevated/50'}`}
        style={{ paddingLeft: `${10 + depth * 16}px`, paddingRight: 10 }}
      >
        {dep.filename &&
          (dep.storageState === 'offloaded' ? (
            <Archive size={11} className="shrink-0 text-warning" />
          ) : dep.storageState === 'disabled' ? (
            <Power size={11} className="shrink-0 text-warning" />
          ) : null)}
        <TruncateWithTooltip
          text={dep.ref}
          className={`flex-1 min-w-0 truncate ${canNavigate ? '' : 'select-text cursor-text'} ${dep.isRoot ? 'text-[11px] font-medium text-text-primary' : `text-[11px] ${dep.resolution === 'exact' || dep.resolution === 'latest' ? 'text-text-primary' : 'text-text-secondary'}`}`}
        />
        {dep.sizeBytes != null && (
          <span className="text-[10px] text-text-tertiary font-mono shrink-0">{formatBytes(dep.sizeBytes)}</span>
        )}
        {depStatusTag(dep, dlStatus, dlProgress, onInstall)}
      </div>
      {renderChildren &&
        dep.children?.map((child, i) => (
          <DepRow
            key={`${child.ref}-${depth}-${i}`}
            dep={child}
            depth={depth + 1}
            renderChildren={renderChildren}
            onNavigate={onNavigate}
            onInstall={onInstall}
          />
        ))}
    </>
  )
}
