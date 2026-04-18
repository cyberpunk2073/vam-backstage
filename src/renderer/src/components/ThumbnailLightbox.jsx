import { useEffect } from 'react'
import { create } from 'zustand'

export const useLightboxStore = create((set) => ({
  src: null,
  open: (src) => set({ src }),
  close: () => set({ src: null }),
}))

export function openLightbox(src) {
  if (src) useLightboxStore.getState().open(src)
}

export function ThumbnailLightbox() {
  const src = useLightboxStore((s) => s.src)
  const close = useLightboxStore((s) => s.close)

  useEffect(() => {
    if (!src) return
    const onKey = (e) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [src, close])

  if (!src) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={close}>
      <img
        src={src}
        className="thumb max-w-[80vw] max-h-[80vh] rounded-lg shadow-2xl object-contain animate-in zoom-in-90 fade-in duration-100"
        onClick={(e) => e.stopPropagation()}
        alt=""
        draggable={false}
      />
    </div>
  )
}
