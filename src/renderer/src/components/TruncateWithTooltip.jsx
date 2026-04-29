import { useLayoutEffect, useRef, useState } from 'react'

/** Ellipsis via CSS; native tooltip only when text overflows (no :overflow in CSS). */
export function TruncateWithTooltip({ text, className, children }) {
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
  }, [text, children])

  return (
    <span ref={ref} className={className} title={clipped ? text : undefined}>
      {children ?? text}
    </span>
  )
}
