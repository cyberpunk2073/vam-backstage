import { useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ScrollToTopButton } from '@/components/ScrollToTopButton'

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
  /** Flat index of the selected item; keeps keyboard selection visible in the viewport. */
  selectedIndex,
  /** Fired when the last visible row is within `endReachedThreshold` rows of the end (infinite scroll). */
  onEndReached,
  /** How many rows from the bottom trigger `onEndReached`. `range.endIndex` already includes `overscan`,
   *  so a small value fires roughly a viewport-plus before the end (matches the old ~1600px prefetch margin). */
  endReachedThreshold = 4,
  /** Rendered below the virtualised rows, inside the scroll container (e.g. "Loading more…"). */
  footer,
  /** When true, suppress the default "No items found" message (caller renders its own empty state). */
  hideEmptyMessage = false,
}) {
  const rowGap = gapY ?? gap
  const scrollRef = useRef(null)
  const [layout, setLayout] = useState({ cols: 1, cellWidth: itemWidth })
  const layoutRef = useRef(layout)
  const scrollFixRef = useRef(null)
  const anchorRef = useRef(0)
  const suppressAnchorRef = useRef(false)
  const committedKeyRef = useRef(scrollResetKey)
  const scrollTopRef = useRef(0)

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
      // Hiding via <Activity> (display:none) clamps scrollTop to 0 and can fire a
      // scroll event before this listener is cleaned up — don't let it zero the anchor.
      if (el.clientHeight === 0) return
      if (suppressAnchorRef.current) return
      const { cols, cellWidth } = layoutRef.current
      const rowH = calcRowHeight(cellWidth) + rowGap
      const topRow = Math.max(0, Math.floor((el.scrollTop - padding) / rowH))
      anchorRef.current = topRow * cols
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [calcRowHeight, rowGap, padding])

  const measure = useCallback(() => {
    const el = scrollRef.current
    // The ResizeObserver fires with a 0-size box when <Activity> hides us; a
    // 0-width measure would commit cols:1 / negative cellWidth, collapsing the
    // virtual height so the scroll restore on reveal gets clamped back to 0.
    if (!el || el.clientWidth === 0) return
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

  const onEndReachedRef = useRef(onEndReached)
  onEndReachedRef.current = onEndReached
  const rangeEndIndex = virtualizer.range?.endIndex ?? -1
  useEffect(() => {
    if (!onEndReachedRef.current || rowCount === 0) return
    if (rangeEndIndex < 0) return
    if (rangeEndIndex >= rowCount - 1 - endReachedThreshold) onEndReachedRef.current()
  }, [rangeEndIndex, rowCount, endReachedThreshold, items.length])

  // Scroll to the selection only when it actually changes. <Activity> re-runs all
  // effects on reveal regardless of deps, and right after reveal the virtualizer's
  // scroll rect is still the stale hidden one (0-height), so align:'auto' treats the
  // selected row as out of view and scrolls to it — clobbering the offset the
  // reset/restore effect below just restored.
  const lastScrolledSelectionRef = useRef(null)
  useEffect(() => {
    if (selectedIndex == null || selectedIndex < 0 || !items.length) return
    if (lastScrolledSelectionRef.current === selectedIndex) return
    lastScrolledSelectionRef.current = selectedIndex
    const row = Math.floor(selectedIndex / cols)
    virtualizer.scrollToIndex(row, { align: 'auto' })
  }, [selectedIndex, cols, items.length, virtualizer])

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

  // Scroll reset/restore. Reset to top only when scrollResetKey actually changes (a
  // real filter change); otherwise restore the last user offset. <Activity> re-runs
  // every effect on hide/reveal regardless of deps, and hiding (display:none) clamps
  // scrollTop to 0 — so a reveal lands in the unchanged-key branch and restores.
  //
  // Two ordering constraints, both of which silently break restore if violated:
  // - Capture the offset in this effect's CLEANUP, which <Activity> runs just before
  //   applying display:none — the last moment the offset is readable. Don't rely on
  //   scroll events for capture: their dispatch is not guaranteed (e.g. programmatic
  //   scrolls in an occluded window fire no event at all).
  // - This effect must be declared AFTER the useVirtualizer() call: on reveal the
  //   virtualizer re-attaches to the scroll element and scrollTo()s its own cached
  //   (stale) offset from a layout effect, so ours must run later to win.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    suppressAnchorRef.current = true
    if (committedKeyRef.current !== scrollResetKey) {
      committedKeyRef.current = scrollResetKey
      el.scrollTop = 0
      anchorRef.current = 0
      scrollTopRef.current = 0
    } else if (scrollTopRef.current > 0) {
      el.scrollTop = scrollTopRef.current
    }
    requestAnimationFrame(() => {
      suppressAnchorRef.current = false
    })
    return () => {
      // clientHeight is 0 when already hidden (unmount of a hidden Activity) — keep
      // the previously captured offset instead of overwriting it with a clamped 0.
      if (el.clientHeight > 0) scrollTopRef.current = el.scrollTop
    }
  }, [scrollResetKey])

  const onScrollMouseDown = useCallback(
    (e) => {
      if (!onEmptyAreaPointerDown) return
      if (e.metaKey || e.ctrlKey) return
      // React synthetic events bubble through portals along the React tree, so a
      // pointerdown inside a portaled overlay (e.g. a card's context menu) reaches
      // this handler even though the overlay is not a DOM child of the scroll
      // container. Only treat clicks that truly landed inside the scroll element
      // as empty-area clicks; otherwise a right-click menu interaction would clear
      // the bulk selection mid-flight.
      const el = e.target
      if (!(el instanceof Element) || !e.currentTarget.contains(el)) return
      if (el.closest('[data-grid-card]')) return
      onEmptyAreaPointerDown()
    },
    [onEmptyAreaPointerDown],
  )

  return (
    <div className={`relative ${className}`}>
      <div ref={scrollRef} className="absolute inset-0 overflow-y-auto" onMouseDown={onScrollMouseDown}>
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
        {footer}
        {items.length === 0 && !hideEmptyMessage && (
          <div className="text-center py-16 text-text-tertiary text-sm">No items found</div>
        )}
      </div>
      <ScrollToTopButton scrollRef={scrollRef} />
    </div>
  )
}

/**
 * Virtualised list for table-style layouts. Uses divs with flex for
 * consistent column sizing without nested <table> hacks.
 */
export function VirtualList({ items, rowHeight = 37, renderRow, className = '', overscan = 5, scrollResetKey }) {
  const scrollRef = useRef(null)
  const committedKeyRef = useRef(scrollResetKey)
  const scrollTopRef = useRef(0)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  })

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [rowHeight, virtualizer])

  // Reset only on a real key change; restore the last offset on mount / <Activity>
  // reveal, captured by the cleanup at hide time (see VirtualGrid for the full rationale).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (committedKeyRef.current !== scrollResetKey) {
      committedKeyRef.current = scrollResetKey
      el.scrollTop = 0
      scrollTopRef.current = 0
    } else if (scrollTopRef.current > 0) {
      el.scrollTop = scrollTopRef.current
    }
    return () => {
      if (el.clientHeight > 0) scrollTopRef.current = el.scrollTop
    }
  }, [scrollResetKey])

  return (
    <div className={`relative ${className}`}>
      <div ref={scrollRef} className="absolute inset-0 overflow-y-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vRow) => (
            <div key={vRow.key} style={{ position: 'absolute', top: vRow.start, left: 0, right: 0, height: rowHeight }}>
              {renderRow(items[vRow.index], vRow.index)}
            </div>
          ))}
        </div>
      </div>
      <ScrollToTopButton scrollRef={scrollRef} />
    </div>
  )
}
