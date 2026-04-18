import { useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

/**
 * Virtualised grid: column count follows min track width; cells share row width
 * (same idea as CSS `repeat(auto-fill, minmax(itemWidth, 1fr))`).
 *
 * On reflow the row containing the anchor item (top-left of the viewport at last
 * user scroll) is kept at the top so toggling column counts never drifts.
 */
export function VirtualGrid({
  items,
  itemWidth,
  itemHeight,
  fixedHeight = 0,
  gap = 12,
  /** Space between rows (virtual stride). Defaults to `gap`; use a larger value if row height is tight vs column gap. */
  gapY,
  renderItem,
  className = '',
  overscan = 3,
  padding = 16,
  scrollResetKey,
  onLayout,
  /** When bulk selection is on, clear it on pointer down outside any `[data-grid-card]` (gaps, padding, empty scroll area). */
  onEmptyAreaPointerDown,
}) {
  const rowGap = gapY ?? gap
  const scrollRef = useRef(null)
  const [layout, setLayout] = useState({ cols: 1, cellWidth: itemWidth })
  const layoutRef = useRef(layout)
  const scrollFixRef = useRef(null)
  const anchorRef = useRef(0)
  const suppressAnchorRef = useRef(false)

  const scalingHeight = itemHeight - fixedHeight
  const calcRowHeight = useCallback(
    (cw) => Math.round(scalingHeight * (cw / itemWidth) + fixedHeight),
    [scalingHeight, itemWidth, fixedHeight],
  )

  // Keep anchor in sync with user-initiated scrolls only.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      if (suppressAnchorRef.current) return
      const { cols, cellWidth } = layoutRef.current
      const rowH = calcRowHeight(cellWidth) + rowGap
      const topRow = Math.max(0, Math.floor((el.scrollTop - padding) / rowH))
      anchorRef.current = topRow * cols
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [calcRowHeight, rowGap, padding])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || el.scrollTop === 0) return
    suppressAnchorRef.current = true
    el.scrollTop = 0
    anchorRef.current = 0
    requestAnimationFrame(() => {
      suppressAnchorRef.current = false
    })
  }, [scrollResetKey])

  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const avail = el.clientWidth - padding * 2
    const newCols = Math.max(1, Math.floor((avail + gap) / (itemWidth + gap)))
    const newCellWidth = (avail - (newCols - 1) * gap) / newCols

    const prev = layoutRef.current
    const colsChanged = prev.cols !== newCols || Math.abs(prev.cellWidth - newCellWidth) >= 0.5
    // Always report availableWidth so the size slider stays in sync after resize,
    // but only update internal layout state (and fix scroll) when columns actually change.
    if (!colsChanged) {
      onLayout?.({ cols: newCols, cellWidth: newCellWidth, availableWidth: avail })
      return
    }

    if (el.scrollTop > padding) {
      const newRowH = calcRowHeight(newCellWidth) + rowGap
      const newRow = Math.floor(anchorRef.current / newCols)
      scrollFixRef.current = padding + newRow * newRowH
    }

    const next = { cols: newCols, cellWidth: newCellWidth }
    layoutRef.current = next
    setLayout(next)
    onLayout?.({ cols: newCols, cellWidth: newCellWidth, availableWidth: avail })
  }, [itemWidth, calcRowHeight, gap, rowGap, padding, onLayout])

  useEffect(() => {
    measure()
    const ro = new ResizeObserver(measure)
    if (scrollRef.current) ro.observe(scrollRef.current)
    return () => ro.disconnect()
  }, [measure])

  const { cols, cellWidth } = layout
  const rowHeight = calcRowHeight(cellWidth)
  const rowCount = Math.ceil(items.length / cols)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight + rowGap,
    overscan,
  })

  useLayoutEffect(() => {
    virtualizer.measure()
    if (scrollFixRef.current != null) {
      const el = scrollRef.current
      if (el) {
        suppressAnchorRef.current = true
        el.scrollTop = scrollFixRef.current
        scrollFixRef.current = null
        requestAnimationFrame(() => {
          suppressAnchorRef.current = false
        })
      }
    }
  }, [cols, cellWidth, rowHeight, rowGap, virtualizer])

  const onScrollMouseDown = useCallback(
    (e) => {
      if (!onEmptyAreaPointerDown) return
      if (e.metaKey || e.ctrlKey) return
      const el = e.target
      if (el instanceof Element && el.closest('[data-grid-card]')) return
      onEmptyAreaPointerDown()
    },
    [onEmptyAreaPointerDown],
  )

  return (
    <div ref={scrollRef} className={`overflow-y-auto ${className}`} onMouseDown={onScrollMouseDown}>
      <div style={{ height: virtualizer.getTotalSize() + padding * 2, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vRow) => {
          const startIdx = vRow.index * cols
          const rowItems = items.slice(startIdx, startIdx + cols)
          return (
            <div
              key={vRow.key}
              style={{
                position: 'absolute',
                top: vRow.start + padding,
                left: padding,
                right: padding,
                display: 'flex',
                gap,
              }}
            >
              {rowItems.map((item, colIdx) => (
                <div key={startIdx + colIdx} style={{ width: cellWidth, flexShrink: 0, minWidth: 0 }}>
                  {renderItem(item, startIdx + colIdx)}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {items.length === 0 && <div className="text-center py-16 text-text-tertiary text-sm">No items found</div>}
    </div>
  )
}

/**
 * Virtualised list for table-style layouts. Uses divs with flex for
 * consistent column sizing without nested <table> hacks.
 */
export function VirtualList({ items, rowHeight = 37, renderRow, className = '', overscan = 5, scrollResetKey }) {
  const scrollRef = useRef(null)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  })

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [rowHeight, virtualizer])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || el.scrollTop === 0) return
    el.scrollTop = 0
  }, [scrollResetKey])

  return (
    <div ref={scrollRef} className={`overflow-y-auto ${className}`}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vRow) => (
          <div key={vRow.key} style={{ position: 'absolute', top: vRow.start, left: 0, right: 0, height: rowHeight }}>
            {renderRow(items[vRow.index], vRow.index)}
          </div>
        ))}
      </div>
    </div>
  )
}
