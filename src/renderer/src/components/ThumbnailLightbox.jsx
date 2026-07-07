import { useEffect } from 'react'
import { create } from 'zustand'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useThumbnail } from '@/hooks/useThumbnail'

export const useLightboxStore = create((set) => ({
  // Single-image mode: `src` is a blob URL, `items` is null.
  // Gallery mode: `items` is an array of { key, id?, label? }, `index` is the current position.
  src: null,
  items: null,
  index: 0,
  open: (src) => set({ src, items: null, index: 0 }),
  openGallery: (items, index) => set({ src: null, items, index: Math.max(0, index || 0) }),
  setIndex: (index) => set({ index }),
  close: () => set({ src: null, items: null, index: 0 }),
}))

export function openLightbox(src) {
  if (src) useLightboxStore.getState().open(src)
}

/** Open the lightbox as a navigable gallery. `items` is an array of
 *  `{ key, id?, label? }` where `key` is a thumbnail cache key. */
export function openLightboxGallery(items, index = 0) {
  if (items && items.length) useLightboxStore.getState().openGallery(items, index)
}

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'j', 'k'])

export function ThumbnailLightbox() {
  const src = useLightboxStore((s) => s.src)
  const items = useLightboxStore((s) => s.items)
  const index = useLightboxStore((s) => s.index)
  const close = useLightboxStore((s) => s.close)

  const isGallery = !!(items && items.length)
  const open = isGallery || !!src
  const total = isGallery ? items.length : 0
  const safeIndex = isGallery ? Math.min(Math.max(index, 0), total - 1) : 0
  const galleryUrl = useThumbnail(isGallery ? items[safeIndex]?.key || null : null)
  const label = isGallery ? items[safeIndex]?.label : null

  useEffect(() => {
    if (!open) return
    // Capture phase so arrow keys drive the lightbox instead of bubbling to the
    // grid/list keyboard navigation (useKeyboardNav) behind the overlay.
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        useLightboxStore.getState().close()
        return
      }
      if (!NAV_KEYS.has(e.key)) return
      e.preventDefault()
      e.stopPropagation()
      const st = useLightboxStore.getState()
      const list = st.items
      if (!list || !list.length) return
      const n = list.length
      const cur = Math.min(Math.max(st.index, 0), n - 1)
      let next = cur
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'k') next = (cur - 1 + n) % n
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'j') next = (cur + 1) % n
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = n - 1
      if (next !== cur) st.setIndex(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open) return null

  const displaySrc = isGallery ? galleryUrl : src
  const step = (delta) => {
    const st = useLightboxStore.getState()
    const list = st.items
    if (!list || !list.length) return
    const n = list.length
    const cur = Math.min(Math.max(st.index, 0), n - 1)
    st.setIndex((cur + delta + n) % n)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={close}>
      {isGallery && total > 1 && (
        <button
          type="button"
          aria-label="Previous"
          onClick={(e) => {
            e.stopPropagation()
            step(-1)
          }}
          className="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full text-white/70 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
        >
          <ChevronLeft size={28} />
        </button>
      )}
      {displaySrc ? (
        <img
          key={displaySrc}
          src={displaySrc}
          className="thumb max-w-[80vw] max-h-[80vh] rounded-lg shadow-2xl object-contain animate-in zoom-in-90 fade-in duration-100"
          onClick={(e) => e.stopPropagation()}
          alt={label || ''}
          draggable={false}
        />
      ) : (
        <div
          className="flex items-center justify-center w-64 h-64 rounded-lg bg-white/5 text-white/50 text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          No preview
        </div>
      )}
      {isGallery && total > 1 && (
        <button
          type="button"
          aria-label="Next"
          onClick={(e) => {
            e.stopPropagation()
            step(1)
          }}
          className="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-full text-white/70 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
        >
          <ChevronRight size={28} />
        </button>
      )}
      {isGallery && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none">
          {label && <span className="max-w-[70vw] truncate text-[12px] text-white/80">{label}</span>}
          {total > 1 && (
            <span className="text-[11px] text-white/50 tabular-nums">
              {safeIndex + 1} / {total}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
