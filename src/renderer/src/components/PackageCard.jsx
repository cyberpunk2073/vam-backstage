import { useState, useRef, useLayoutEffect, useEffect } from 'react'
import {
  AlertTriangle,
  HardDrive,
  Layers,
  Eye,
  EyeOff,
  Star,
  Download,
  Heart,
  Plus,
  Library,
  Clock,
  ExternalLink,
  Check,
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
  extractDomainLabel,
  THUMB_OVERLAY_CHIP,
} from '../lib/utils'
import { Button } from './ui/button'
import { Avatar, AvatarImage, AvatarFallback } from './ui/avatar'
import { useThumbnail } from '../hooks/useThumbnail'
import { useHubInstallState } from '../hooks/useHubInstallState'
import { useDownloadStore } from '../stores/useDownloadStore'
import { useAvatar } from '../hooks/useAvatar'

/** Non-interactive bulk-selection marker; whole card handles clicks */
function BulkSelectChip({ checked }) {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      className={`shrink-0 inline-flex items-center justify-center w-5 h-5 rounded border pointer-events-none ${
        checked ? 'bg-accent-blue border-accent-blue text-white' : 'border-white/35 bg-black/45 backdrop-blur-sm'
      }`}
    >
      {checked ? <Check size={12} strokeWidth={3} /> : null}
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
}) {
  const minimal = mode === 'minimal'
  const isPaid = resource.category === 'Paid'
  const isExternal = resource.hubDownloadable === 'false' || resource.hubDownloadable === false
  const typeColor = TYPE_COLORS[resource.type] || '#6366f1'

  const rid = String(resource.resource_id)
  const { state: installState, dlInfo, installStatus } = useHubInstallState(rid, { isExternal })
  const libRef = installStatus.filename || resource._localFilename

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
        <span className="relative z-10 flex items-center justify-center text-[10px] text-white font-medium tracking-wide whitespace-nowrap">
          <span className="@max-[179px]:hidden">Downloading </span>
          {dlInfo.completed}/{dlInfo.total} · {p}%
        </span>
      </div>
    )
  } else if (installState === 'queued') {
    actionBtn = (
      <div
        className={
          minimal
            ? 'px-2 py-1 rounded text-[10px] text-white/60 border border-white/10 bg-black/50 backdrop-blur-sm flex items-center gap-1'
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
            ? 'px-2 py-1 rounded text-[10px] text-accent-blue border border-accent-blue/25 bg-black/50 backdrop-blur-sm hover:bg-accent-blue/20 flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-40 disabled:pointer-events-none'
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
            ? 'px-2 py-1 h-auto rounded text-[10px] gap-1'
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
            ? 'max-w-[min(100%,9rem)] px-2 py-1 rounded text-[10px] text-accent-blue border border-accent-blue/25 bg-black/50 backdrop-blur-sm hover:bg-accent-blue/20 flex items-center gap-1 cursor-pointer transition-colors min-w-0'
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
            ? 'px-2 py-1 rounded text-[10px] text-error border border-error/25 bg-black/50 backdrop-blur-sm flex items-center gap-1 cursor-pointer'
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
            ? 'px-2 py-1 h-auto rounded text-[10px] gap-1'
            : 'w-full py-1.5 h-auto rounded text-[10px] gap-1.5 tracking-wide whitespace-nowrap'
        }
      >
        <Download size={minimal ? 10 : 11} className="@max-[129px]:hidden shrink-0" /> Install{sizeSuffix}
      </Button>
    )
  }

  const imgUrl = resource.image_url
  const gradientId = resource.resource_id || resource.title || ''
  const [thumbFailed, setThumbFailed] = useState(false)
  useEffect(() => {
    setThumbFailed(false)
  }, [imgUrl])

  return (
    <div
      className={`@container w-full min-w-0 bg-surface border rounded-lg overflow-hidden text-left transition-all duration-150 card-glow cursor-pointer flex flex-col border-border hover:bg-elevated`}
    >
      <div onClick={() => onClick?.(resource)} className="flex-1">
        <div className="relative aspect-square">
          <div className="absolute inset-0" style={{ background: getGradient(String(gradientId)) }} />
          {imgUrl && !thumbFailed ? <div className="absolute inset-0 bg-elevated" /> : null}
          {imgUrl && !thumbFailed ? (
            <img
              src={imgUrl}
              className="thumb absolute inset-0 w-full h-full object-cover"
              alt=""
              loading="lazy"
              onError={() => setThumbFailed(true)}
            />
          ) : null}
          <div className="absolute inset-0 bg-linear-to-t from-black/40 to-transparent" />
          {!hideType && (
            <div
              className={`absolute top-2 left-2 ${THUMB_OVERLAY_CHIP} text-white`}
              style={{ background: typeColor + 'cc' }}
            >
              {resource.type}
            </div>
          )}
          {isPaid && (
            <div
              className={`absolute top-2 right-2 ${THUMB_OVERLAY_CHIP} text-white`}
              style={{ background: HUB_CATEGORY_COLORS.Paid + 'cc' }}
            >
              Paid
            </div>
          )}
          {minimal && (
            <div className="absolute bottom-0 inset-x-0 flex items-end gap-2 px-2.5 pb-2 pt-6 bg-linear-to-t from-black/70 to-transparent">
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
              <div className="shrink-0 mb-[1.5px]">{actionBtn}</div>
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
                <Heart size={11} className="shrink-0 opacity-80" />
                {formatNumber(parseInt(resource.rating_count || '0', 10))}
              </span>
              <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap tabular-nums @max-[150px]:hidden">
                <Star size={11} className="shrink-0 opacity-80" />
                {formatStarRating(resource.rating_avg)}
              </span>
            </div>
          </div>
        )}
      </div>
      {!minimal && <div className="px-3 pb-3 pt-2 min-w-0">{actionBtn}</div>}
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
}) {
  const minimal = mode === 'minimal'
  const disabled = !pkg.isEnabled
  const name = displayName(pkg)
  const thumbUrl = useThumbnail(`pkg:${pkg.filename}`)
  const versionStr = pkg.version != null && pkg.version !== '' ? String(pkg.version) : null
  const showBulk = bulkMode || bulkSelected

  return (
    <button
      type="button"
      data-grid-card
      onClick={(e) => onClick?.(pkg, e)}
      className={`@container w-full bg-surface border rounded-lg overflow-hidden text-left transition-all duration-150 card-glow cursor-pointer shrink-0 group
        ${selected || bulkSelected ? 'border-accent-blue/40 bg-elevated' : 'border-border hover:bg-elevated'}
        ${disabled ? 'opacity-60 hover:opacity-90' : ''}`}
    >
      <div
        className={`relative aspect-square ${disabled ? 'saturate-25 brightness-80 group-hover:saturate-100 group-hover:brightness-100 transition-[filter] duration-200' : ''}`}
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
          (minimal && pkg.missingDeps > 0)) && (
          <div className="absolute top-2 left-2 z-[2] flex max-w-[calc(100%-2.75rem)] items-center gap-1 overflow-x-auto [scrollbar-width:thin] flex-nowrap">
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
                className={`${THUMB_OVERLAY_CHIP} bg-white/15 text-white/80 backdrop-blur-sm`}
                title="No Custom/Atom appearance, Saves/Person/Appearance, or Custom/Atom/Person/Skin items in this package"
              >
                no preset
              </div>
            )}
            {!pkg.isDirect && (
              <div className={`${THUMB_OVERLAY_CHIP} bg-accent-blue/30 text-accent-blue backdrop-blur-sm`}>DEP</div>
            )}
            {pkg.isLocalOnly && (
              <div className={`${THUMB_OVERLAY_CHIP} bg-white/15 text-white/75 backdrop-blur-sm`}>LOCAL</div>
            )}
            {minimal && pkg.missingDeps > 0 && !bulkMode && (
              <div
                className={`${THUMB_OVERLAY_CHIP} bg-warning/20 text-warning backdrop-blur-sm flex items-center gap-0.5`}
              >
                <AlertTriangle size={10} className="shrink-0" /> {pkg.missingDeps}
              </div>
            )}
          </div>
        )}
        <div className="absolute top-2 right-2 flex items-center gap-1 z-[1]">
          {disabled && (
            <div className={`${THUMB_OVERLAY_CHIP} bg-warning/25 text-warning backdrop-blur-sm`}>
              <EyeOff size={10} className="shrink-0" />
            </div>
          )}
          {pkg.isCorrupted && (
            <div className={`${THUMB_OVERLAY_CHIP} bg-error/25 text-error backdrop-blur-sm`}>CORRUPTED</div>
          )}
          {pkg.favoriteContentCount > 0 && (
            <span
              title={
                pkg.favoriteContentCount === 1
                  ? '1 favorited item in this package'
                  : `${pkg.favoriteContentCount} favorited items in this package`
              }
              className="shrink-0 size-[18px] inline-flex items-center justify-center text-warning pointer-events-none [&_svg]:filter-[drop-shadow(0_0_1.5px_rgba(0,0,0,1))_drop-shadow(0_0_3px_rgba(0,0,0,1))_drop-shadow(0_1px_8px_rgba(0,0,0,0.9))]"
            >
              <Star size={11} fill="currentColor" />
            </span>
          )}
        </div>
        {minimal && (
          <div className="absolute bottom-0 inset-x-0 px-2.5 pb-2 pt-6 bg-linear-to-t from-black/70 to-transparent">
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
            {pkg.missingDeps > 0 && (
              <span
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-warning tabular-nums @max-[138px]:hidden"
                title={`${pkg.missingDeps} missing dependencies`}
              >
                <AlertTriangle size={10} className="shrink-0" />
                <span>{pkg.missingDeps}</span>
                <span className="@max-[228px]:hidden">missing</span>
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
}) {
  const typeColor = libraryTypeBadgeColor(pkg.type)
  const disabled = !pkg.isEnabled
  const name = displayName(pkg)
  const versionStr = pkg.version != null && pkg.version !== '' ? String(pkg.version) : null
  const thumbUrl = useThumbnail(`pkg:${pkg.filename}`)

  return (
    <div
      onClick={(e) => onClick?.(pkg, e)}
      className={`flex items-center cursor-pointer transition-colors border-b border-border h-full ${selected || bulkSelected ? 'bg-elevated' : 'hover:bg-elevated/50'} ${disabled ? 'opacity-60 hover:opacity-90' : ''}`}
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
      <div className="flex-1 py-2 px-3 flex items-center gap-1 flex-wrap min-w-0">
        {pkg.isCorrupted ? (
          <span className="text-[10px] text-error font-medium">Corrupted</span>
        ) : disabled ? (
          <span className="text-[10px] text-warning flex items-center gap-1">
            <EyeOff size={10} /> Disabled
          </span>
        ) : pkg.isDirect ? (
          <span className="text-[10px] text-success">Installed</span>
        ) : (
          <span className="text-[10px] text-accent-blue">Dep</span>
        )}
        {pkg.isLocalOnly && <span className="text-[10px] text-text-tertiary"> · Local</span>}
        {pkg.noLookPresetTag && (
          <span
            className={`${THUMB_OVERLAY_CHIP} text-text-tertiary bg-border/40 shrink-0`}
            title="No Custom/Atom appearance, Saves/Person/Appearance, or Custom/Atom/Person/Skin items in this package"
          >
            no preset
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
        {pkg.missingDeps > 0 ? (
          <span className="text-[10px] text-warning">
            <AlertTriangle size={10} className="inline" /> {pkg.missingDeps}
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
  /** When true, content that is only user-hidden (not disabled package) renders at full saturation/opacity — for the gallery "Hidden" visibility filter */
  suppressHiddenDimming = false,
}) {
  const typeColor = TYPE_COLORS[item.category] || '#6366f1'
  const isHidden = item.hidden
  const isDisabledPkg = !item.isEnabled
  const dimHiddenChrome = isDisabledPkg || (isHidden && !suppressHiddenDimming)
  const thumbKey = item.thumbnailPath ? `ct:${item.packageFilename}\0${item.thumbnailPath}` : null
  const thumbUrl = useThumbnail(thumbKey)
  const pkgLabel = displayName({
    hubDisplayName: item.packageHubDisplayName,
    title: item.packageTitle,
    packageName: item.packageName,
    filename: item.packageFilename,
  })

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
          <div className="text-[10px] text-text-tertiary truncate">{pkgLabel}</div>
        </div>
      </div>
      <div
        className={`flex-2 py-2 px-3 text-[11px] truncate ${dimHiddenChrome ? 'opacity-45' : ''} ${item.creator ? 'text-text-secondary cursor-pointer hover:brightness-150 transition-[filter]' : 'text-text-secondary'}`}
        onClick={
          item.creator && onFilterAuthor
            ? (e) => {
                e.stopPropagation()
                onFilterAuthor(item.creator)
              }
            : undefined
        }
      >
        {item.creator}
      </div>
      {!hideType && (
        <div className={`flex-2 min-w-0 py-2 px-3 ${dimHiddenChrome ? 'opacity-45' : ''}`}>
          <div className="flex w-full min-w-0 flex-nowrap items-center gap-1 overflow-x-auto [scrollbar-width:thin]">
            <span className={THUMB_OVERLAY_CHIP} style={{ color: typeColor, background: typeColor + '18' }}>
              {item.category}
            </span>
            {item.tag && (
              <span
                className={THUMB_OVERLAY_CHIP}
                style={{
                  color: item.tag.color,
                  background: `color-mix(in srgb, ${item.tag.color} 14%, transparent)`,
                }}
              >
                {item.tag.label}
              </span>
            )}
          </div>
        </div>
      )}
      <div className="w-14 py-2 px-3 text-[11px]">
        {isDisabledPkg ? (
          <span className="text-warning opacity-60" title="Package is disabled">
            <EyeOff size={12} />
          </span>
        ) : bulkMode ? (
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
  const isDisabledPkg = !item.isEnabled
  const dimHiddenChrome = isDisabledPkg || (isHidden && !suppressHiddenDimming)
  const pkgLabel = displayName({
    hubDisplayName: item.packageHubDisplayName,
    title: item.packageTitle,
    packageName: item.packageName,
    filename: item.packageFilename,
  })
  const thumbKey = item.thumbnailPath ? `ct:${item.packageFilename}\0${item.thumbnailPath}` : null
  const thumbUrl = useThumbnail(thumbKey)
  const showBulk = bulkMode || bulkSelected

  return (
    <div
      data-grid-card
      onClick={(e) => onClick?.(item, e)}
      className={`w-full bg-surface border rounded-lg overflow-hidden transition-all duration-150 card-glow cursor-pointer shrink-0 group
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
        {bulkSelected && <div className="absolute inset-0 bg-accent-blue/10 pointer-events-none z-[1]" />}
        {(showBulk || !hideType || item.tag) && (
          <div className="absolute top-2 left-2 z-[2] flex max-w-[calc(100%-2.75rem)] items-center gap-1 overflow-x-auto [scrollbar-width:thin] flex-nowrap">
            {bulkMode && <BulkSelectChip checked={bulkSelected} />}
            {!hideType && (
              <span className={`${THUMB_OVERLAY_CHIP} text-white`} style={{ background: typeColor + 'cc' }}>
                {item.category}
              </span>
            )}
            {item.tag && (
              <span
                className={`${THUMB_OVERLAY_CHIP} backdrop-blur-md`}
                style={{
                  color: item.tag.color,
                  background: `color-mix(in srgb, ${item.tag.color} 12%, rgba(0,0,0,0.3))`,
                  textShadow: `0 0 8px ${item.tag.color}60, 0 1px 2px rgba(0,0,0,0.8)`,
                }}
              >
                {item.tag.label}
              </span>
            )}
          </div>
        )}
        {!bulkMode && (
          <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 z-[2]">
            {isDisabledPkg ? (
              <div
                title="Package is disabled"
                className="size-7 shrink-0 inline-flex items-center justify-center rounded opacity-60 text-warning [&_svg]:filter-[drop-shadow(0_0_1px_rgba(0,0,0,1))_drop-shadow(0_0_2.5px_rgba(0,0,0,1))_drop-shadow(0_0_5px_rgba(0,0,0,1))_drop-shadow(0_1px_10px_rgba(0,0,0,0.85))]"
              >
                <EyeOff size={13} />
              </div>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleHidden?.(item)
                }}
                className={`size-7 shrink-0 inline-flex items-center justify-center rounded cursor-pointer transition-opacity ${
                  isHidden
                    ? 'opacity-100 text-error bg-transparent [&_svg]:filter-[drop-shadow(0_0_1px_rgba(0,0,0,1))_drop-shadow(0_0_2.5px_rgba(0,0,0,1))_drop-shadow(0_0_5px_rgba(0,0,0,1))_drop-shadow(0_1px_10px_rgba(0,0,0,0.85))] group-hover:[&_svg]:filter-none group-hover:text-error/70 group-hover:bg-black/50 group-hover:backdrop-blur-sm'
                    : 'opacity-0 group-hover:opacity-100 text-white/70 bg-black/50 backdrop-blur-sm'
                }`}
              >
                {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onToggleFavorite?.(item)
              }}
              className={`size-7 shrink-0 inline-flex items-center justify-center rounded cursor-pointer transition-opacity ${
                item.favorite
                  ? 'text-warning opacity-100 bg-transparent [&_svg]:filter-[drop-shadow(0_0_1.5px_rgba(0,0,0,1))_drop-shadow(0_0_3px_rgba(0,0,0,1))_drop-shadow(0_1px_8px_rgba(0,0,0,0.9))] group-hover:[&_svg]:filter-none group-hover:bg-black/50 group-hover:backdrop-blur-sm'
                  : 'text-white/50 bg-black/50 backdrop-blur-sm opacity-0 group-hover:opacity-100'
              }`}
            >
              <Star size={13} fill={item.favorite ? 'currentColor' : 'none'} />
            </button>
          </div>
        )}
        <div className="absolute bottom-0 inset-x-0 px-2.5 pb-2 pt-8 bg-linear-to-t from-black/80 to-transparent">
          <div className="text-[11px] font-medium text-white truncate leading-tight">{item.displayName}</div>
          <div className="text-[9px] text-white/50 truncate">{pkgLabel}</div>
        </div>
      </div>
    </div>
  )
}

const TAG = 'text-[9px] font-medium px-2 py-0.5 rounded min-w-[4.5rem] text-center inline-block'

function depStatusTag(dep, dlStatus, dlProgress) {
  // Installed status always takes priority over stale download data
  if (dep.resolution === 'exact' || dep.resolution === 'latest')
    return <span className={`${TAG} text-success bg-success/8`}>Installed</span>
  if (dep.resolution === 'fallback') return <span className={`${TAG} text-warning bg-warning/8`}>Fallback</span>
  // Not installed — show download progress if actively downloading
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
  if (dlStatus === 'failed') return <span className={`${TAG} text-error bg-error/8`}>Failed</span>
  // Not installed, no active download
  if (dep.resolution === 'hub') return <span className={`${TAG} text-accent-blue bg-accent-blue/8`}>On Hub</span>
  return <span className={`${TAG} text-error bg-error/8`}>Missing</span>
}

/** Ellipsis via CSS; native tooltip only when text overflows (no :overflow in CSS). */
function TruncateWithTooltip({ text, className }) {
  const ref = useRef(null)
  const [clipped, setClipped] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setClipped(el.scrollWidth > el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])

  return (
    <span ref={ref} className={className} title={clipped ? text : undefined}>
      {text}
    </span>
  )
}

export function DepRow({ dep, depth = 0, renderChildren = true, onNavigate }) {
  const dl = useDownloadStore((s) => {
    const d = s.byPackageRef.get(dep.ref)
    if (!d || d.status === 'completed' || d.status === 'cancelled') return null
    if (d.status === 'active') return `active|${s.liveProgress[d.id]?.progress ?? 0}`
    return d.status
  })
  const dlStatus = dl?.startsWith('active') ? 'active' : dl
  const dlProgress = dl?.startsWith('active') ? Number(dl.split('|')[1]) || 0 : 0
  const canNavigate = !!dep.filename && !!onNavigate

  return (
    <>
      <div
        onClick={canNavigate ? () => onNavigate(dep.filename) : undefined}
        className={`flex items-center gap-2 py-1.5 transition-colors ${canNavigate ? 'cursor-pointer' : ''} ${dep.isRoot ? 'bg-elevated/30' : 'hover:bg-elevated/50'}`}
        style={{ paddingLeft: `${10 + depth * 16}px`, paddingRight: 10 }}
      >
        {dep.filename && !dep.isEnabled && <EyeOff size={11} className="shrink-0 text-warning" />}
        <TruncateWithTooltip
          text={dep.ref}
          className={`flex-1 min-w-0 truncate ${canNavigate ? '' : 'select-text cursor-text'} ${dep.isRoot ? 'text-[11px] font-medium text-text-primary' : `text-[11px] ${dep.resolution === 'exact' || dep.resolution === 'latest' ? 'text-text-primary' : 'text-text-secondary'}`}`}
        />
        {dep.sizeBytes != null && (
          <span className="text-[10px] text-text-tertiary font-mono shrink-0">{formatBytes(dep.sizeBytes)}</span>
        )}
        {depStatusTag(dep, dlStatus, dlProgress)}
      </div>
      {renderChildren &&
        dep.children?.map((child, i) => (
          <DepRow
            key={`${child.ref}-${depth}-${i}`}
            dep={child}
            depth={depth + 1}
            renderChildren={renderChildren}
            onNavigate={onNavigate}
          />
        ))}
    </>
  )
}
