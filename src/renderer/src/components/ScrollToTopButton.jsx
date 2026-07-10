import { useState, useCallback, useEffect } from 'react'
import { ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Floating "scroll to top" affordance for a scroll container. Appears once the
 *  user has scrolled past roughly one viewport height and smooth-scrolls back up.
 *  `scrollRef` must point at the scrolling element (a positioned ancestor is
 *  expected so the button pins to the viewport corner). */
export function ScrollToTopButton({ scrollRef }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setVisible(el.scrollTop > el.clientHeight)
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(onScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [scrollRef])
  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [scrollRef])
  return (
    <button
      type="button"
      title="Scroll to top"
      aria-label="Scroll to top"
      onClick={scrollToTop}
      className={cn(
        'absolute bottom-4 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full',
        'bg-elevated/75 text-text-secondary ring-1 ring-white/10 backdrop-blur-xl',
        'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_2px_6px_0_rgba(0,0,0,0.3),0_10px_28px_-6px_rgba(0,0,0,0.45)]',
        'transition-all duration-200 hover:bg-elevated/90 hover:text-text-primary hover:ring-white/20',
        visible ? 'cursor-pointer opacity-100' : 'pointer-events-none translate-y-1 opacity-0',
      )}
    >
      <ArrowUp size={16} strokeWidth={2} />
    </button>
  )
}
