import { X } from 'lucide-react'
import { VirtualGrid } from '@/components/VirtualGrid'
import { LibraryPackageContextMenu } from '@/components/LibraryPackageContextMenu'
import { ContentItemContextMenu } from '@/components/ContentItemContextMenu'
import { usePersistedPanelWidth } from '@/hooks/usePersistedPanelWidth'
import { useThumbnail } from '@/hooks/createBlobCacheHook'
import { META_DENSE } from '@/lib/typography'
import { cn, displayName, formatBytes, getGradient, getContentGradient } from '@/lib/utils'

const TILE = 72
const NAME_H = 34

/**
 * Right-panel gallery of the current multi-selection. Tiles are overview + remove;
 * click is a no-op (avoid accidental deselect). Right-click opens the single-item
 * menu with "Select only this" at the top.
 */
export function SelectionPanel({ kind, items, onRemove, onNavigate, onToggleHidden, onToggleFavorite }) {
  const [panelWidth] = usePersistedPanelWidth('panel_width_detail', {
    min: 260,
    max: 500,
    defaultWidth: 340,
  })
  const n = items.length
  const totalSize = kind === 'library' ? items.reduce((s, p) => s + (p.sizeBytes || 0), 0) : null
  const noun = kind === 'library' ? 'package' : 'item'

  return (
    <div className="shrink-0 border-l border-border bg-surface flex flex-col min-h-0" style={{ width: panelWidth }}>
      <div className="p-4 pb-2 shrink-0">
        <div className="text-sm font-semibold text-text-primary">
          {n} {noun}
          {n !== 1 ? 's' : ''} selected
        </div>
        {totalSize != null && <div className={cn(META_DENSE, 'mt-1')}>{formatBytes(totalSize)}</div>}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <VirtualGrid
          items={items}
          itemWidth={TILE}
          itemHeight={TILE + NAME_H}
          fixedHeight={NAME_H}
          gap={8}
          padding={12}
          className="flex-1"
          hideEmptyMessage
          renderItem={(item) =>
            kind === 'library' ? (
              <LibrarySelectionTile key={item.filename} pkg={item} onRemove={onRemove} onNavigate={onNavigate} />
            ) : (
              <ContentSelectionTile
                key={item.id}
                item={item}
                onRemove={onRemove}
                onNavigate={onNavigate}
                onToggleHidden={onToggleHidden}
                onToggleFavorite={onToggleFavorite}
              />
            )
          }
        />
      </div>
    </div>
  )
}

function LibrarySelectionTile({ pkg, onRemove, onNavigate }) {
  const name = displayName(pkg)
  const thumbUrl = useThumbnail(`pkg:${pkg.filename}`)
  const tip = [name, pkg.creator, pkg.sizeBytes != null ? formatBytes(pkg.sizeBytes) : null].filter(Boolean).join(' · ')

  return (
    <LibraryPackageContextMenu pkg={pkg} scope="item" onNavigate={onNavigate}>
      <div data-grid-card className="w-full outline-none" title={tip}>
        <SelectionTileChrome
          name={name}
          thumbUrl={thumbUrl}
          gradient={getGradient(pkg.filename)}
          onRemove={() => onRemove?.(pkg)}
        />
      </div>
    </LibraryPackageContextMenu>
  )
}

function ContentSelectionTile({ item, onRemove, onNavigate, onToggleHidden, onToggleFavorite }) {
  const name = item.displayName || ''
  const thumbKey = item.thumbnailPath ? `ct:${item.packageFilename}\0${item.thumbnailPath}` : null
  const thumbUrl = useThumbnail(thumbKey)
  const owner = item.sourcePackage ?? item.package
  const tip = [name, owner?.creator, item.category].filter(Boolean).join(' · ')

  return (
    <ContentItemContextMenu
      item={item}
      scope="item"
      onNavigate={onNavigate}
      onToggleHidden={onToggleHidden}
      onToggleFavorite={onToggleFavorite}
    >
      <div data-grid-card className="w-full outline-none" title={tip}>
        <SelectionTileChrome
          name={name}
          thumbUrl={thumbUrl}
          gradient={getContentGradient(item.displayName, item.category)}
          onRemove={() => onRemove?.(item)}
        />
      </div>
    </ContentItemContextMenu>
  )
}

function SelectionTileChrome({ name, thumbUrl, gradient, onRemove }) {
  return (
    <div className="w-full group">
      <div className="relative aspect-square rounded-md overflow-hidden bg-elevated ring-1 ring-border/60">
        <div className="absolute inset-0" style={{ background: gradient }} />
        {thumbUrl && <div className="absolute inset-0 bg-elevated" />}
        {thumbUrl && <img src={thumbUrl} className="thumb absolute inset-0 w-full h-full object-cover" alt="" />}
        <button
          type="button"
          title="Remove from selection"
          aria-label={`Remove ${name || 'item'} from selection`}
          onClick={(e) => {
            e.stopPropagation()
            onRemove?.()
          }}
          className="absolute top-1 right-1 size-6 inline-flex items-center justify-center rounded-md bg-black/55 text-white opacity-80 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/75 transition-opacity cursor-pointer"
        >
          <X size={13} strokeWidth={2.5} />
        </button>
      </div>
      <div className="mt-1 px-0.5 text-[10px] leading-snug text-text-secondary line-clamp-2 break-words">
        {name || '—'}
      </div>
    </div>
  )
}
