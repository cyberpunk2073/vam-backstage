import { Eye, EyeOff, Star, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from './Toast'
import { openLightbox } from './ThumbnailLightbox'
import { getContentGradient } from '@/lib/utils'
import { useThumbnail } from '@/hooks/useThumbnail'
import { useContentCategoryExpandedStore } from '@/stores/useContentCategoryExpandedStore'

export function ContentRow({ item, onSelect, disabled, suppressHiddenStyle = false }) {
  const thumbKey = item.thumbnailPath ? `ct:${item.packageFilename}\0${item.thumbnailPath}` : null
  const thumbUrl = useThumbnail(thumbKey)

  const handleToggleHidden = async (e) => {
    e.stopPropagation()
    try {
      await window.api.contents.toggleHidden({
        id: item.id,
        packageFilename: item.packageFilename,
        internalPath: item.internalPath,
      })
    } catch (err) {
      toast(`Failed to toggle hidden: ${err.message}`)
    }
  }
  const handleToggleFavorite = async (e) => {
    e.stopPropagation()
    try {
      await window.api.contents.toggleFavorite({
        id: item.id,
        packageFilename: item.packageFilename,
        internalPath: item.internalPath,
      })
    } catch (err) {
      toast(`Failed to toggle favorite: ${err.message}`)
    }
  }

  return (
    <div
      onClick={onSelect ? () => onSelect(item) : undefined}
      className={`flex items-center gap-2 px-2.5 py-1.5 hover:bg-elevated transition-colors${onSelect ? ' cursor-pointer' : ''}`}
    >
      <div
        className={`w-6 h-6 rounded shrink-0 relative overflow-hidden${thumbUrl ? ' cursor-pointer' : ''}`}
        onClick={
          thumbUrl
            ? (e) => {
                e.stopPropagation()
                openLightbox(thumbUrl)
              }
            : undefined
        }
      >
        <div className="absolute inset-0" style={{ background: getContentGradient(item.displayName, item.category) }} />
        {thumbUrl && <img src={thumbUrl} className="thumb absolute inset-0 w-full h-full object-cover" alt="" />}
      </div>
      <span
        className={`text-[11px] flex-1 min-w-0 truncate ${item.hidden && !suppressHiddenStyle ? 'text-text-tertiary line-through' : 'text-text-primary'}`}
      >
        {item.displayName}
        {item.tag && (
          <span className="ml-1.5 text-[9px] font-medium" style={{ color: item.tag.color + 'bb' }}>
            {item.tag.label}
          </span>
        )}
      </span>
      {disabled ? (
        <span className="text-warning opacity-50" title="Package is disabled">
          {item.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
        </span>
      ) : (
        <button
          type="button"
          onClick={handleToggleHidden}
          className={`cursor-pointer ${item.hidden ? 'text-error' : 'text-text-tertiary hover:text-text-secondary'}`}
        >
          {item.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
      )}
      <button
        type="button"
        onClick={handleToggleFavorite}
        className={`cursor-pointer ${item.favorite ? 'text-warning' : 'text-text-tertiary'}`}
      >
        <Star size={12} fill={item.favorite ? 'currentColor' : 'none'} />
      </button>
    </div>
  )
}

export function ContentCategory({ items, label, onSelectRow, disabled, suppressHiddenRowStyle = false }) {
  const expanded = useContentCategoryExpandedStore((s) => s.expandedByType[label] ?? true)
  const toggleCategory = useContentCategoryExpandedStore((s) => s.toggle)
  const allHidden = items.every((i) => i.hidden)
  const allFavorite = items.every((i) => i.favorite)

  const handleToggleHidden = async (e) => {
    e.stopPropagation()
    const payload = items.map((i) => ({ id: i.id, packageFilename: i.packageFilename, internalPath: i.internalPath }))
    try {
      await window.api.contents.setHiddenBatch({ items: payload, hidden: !allHidden })
    } catch (err) {
      toast(`Failed to toggle hidden: ${err.message}`)
    }
  }

  const handleToggleFavorite = async (e) => {
    e.stopPropagation()
    const payload = items.map((i) => ({ id: i.id, packageFilename: i.packageFilename, internalPath: i.internalPath }))
    try {
      await window.api.contents.setFavoriteBatch({ items: payload, favorite: !allFavorite })
    } catch (err) {
      toast(`Failed to toggle favorite: ${err.message}`)
    }
  }

  return (
    <div className="group/cat">
      <div className="flex items-center gap-1.5 mb-1">
        <button
          type="button"
          onClick={() => toggleCategory(label)}
          className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-text-tertiary font-medium cursor-pointer"
        >
          {expanded ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
          {label}
          <span className="normal-case tracking-normal">({items.length})</span>
        </button>
        <div className="flex items-center gap-0.5 ml-auto opacity-0 group-hover/cat:opacity-100 transition-opacity">
          {disabled ? (
            <span className="p-0.5 text-warning opacity-50" title="Package is disabled">
              {allHidden ? <EyeOff size={10} /> : <Eye size={10} />}
            </span>
          ) : (
            <button
              type="button"
              onClick={handleToggleHidden}
              className={`cursor-pointer p-0.5 rounded hover:bg-elevated transition-colors ${allHidden ? 'text-error' : 'text-text-tertiary hover:text-text-secondary'}`}
              title={allHidden ? 'Show all' : 'Hide all'}
            >
              {allHidden ? <EyeOff size={10} /> : <Eye size={10} />}
            </button>
          )}
          <button
            type="button"
            onClick={handleToggleFavorite}
            className={`cursor-pointer p-0.5 rounded hover:bg-elevated transition-colors ${allFavorite ? 'text-warning' : 'text-text-quaternary hover:text-warning'}`}
            title={allFavorite ? 'Unfavorite all' : 'Favorite all'}
          >
            <Star size={10} fill={allFavorite ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="border border-border rounded overflow-hidden divide-y divide-border">
          {items.map((item) => (
            <ContentRow
              key={item.id}
              item={item}
              onSelect={onSelectRow}
              disabled={disabled}
              suppressHiddenStyle={suppressHiddenRowStyle}
            />
          ))}
        </div>
      )}
    </div>
  )
}
