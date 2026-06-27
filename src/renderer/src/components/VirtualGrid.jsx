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
  restoreIndex = null,
  restoreKey = '',
  onLayout,
  onFirstVisibleIndexChange,
  /** When bulk selection is on, clear it on pointer down outside any `[data-grid-card]` (gaps, padding, empty scroll area). */
  onEmptyAreaPointerDown,
}) {
  const rowGap = gapY ?? gap
  const scrollRef = useRef(null)
  const [layout, setLayout] = useState({ cols: 1, cellWidth: itemWidth })
  const [layoutReady, setLayoutReady] = useState(false)
  const layoutRef = useRef(layout)
  const layoutReadyRef = useRef(false)
  const scrollFixRef = useRef(null)
  const anchorRef = useRef(0)
  const suppressAnchorRef = useRef(false)
  const consumedRestoreKeyRef = useRef('')
  const lastFirstVisibleIndexRef = useRef(null)
  const onFirstVisibleIndexChangeRef = useRef(onFirstVisibleIndexChange)

  useLayoutEffect(() => {
    onFirstVisibleIndexChangeRef.current = onFirstVisibleIndexChange
  }, [onFirstVisibleIndexChange])

  const emitFirstVisibleIndex = useCallback((index) => {
    if (lastFirstVisibleIndexRef.current === index) return
    lastFirstVisibleIndexRef.current = index
    onFirstVisibleIndexChangeRef.current?.(index)
  }, [])

  const markLayoutReady = useCallback(() => {
    if (layoutReadyRef.current) return
    layoutReadyRef.current = true
    setLayoutReady(true)
  }, [])

  const markLayoutNotReady = useCallback(() => {
    if (!layoutReadyRef.current) return
    layoutReadyRef.current = false
    setLayoutReady(false)
  }, [])

  const measureLayout = useCallback(
    (el) => {
      const avail = el.clientWidth - padding * 2
      if (avail <= 0) return null
      const cols = Math.max(1, Math.floor((avail + gap) / (itemWidth + gap)))
      const cellWidth = (avail - (cols - 1) * gap) / cols
      if (cellWidth <= 0) return null
      return { cols, cellWidth, availableWidth: avail }
    },
    [gap, itemWidth, padding],
  )

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
      emitFirstVisibleIndex(anchorRef.current)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [calcRowHeight, rowGap, padding, emitFirstVisibleIndex])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (restoreKey && consumedRestoreKeyRef.current !== restoreKey) return
    if (el.scrollTop === 0) {
      anchorRef.current = 0
      emitFirstVisibleIndex(0)
      return
    }
    suppressAnchorRef.current = true
    el.scrollTop = 0
    anchorRef.current = 0
    emitFirstVisibleIndex(0)
    requestAnimationFrame(() => {
      suppressAnchorRef.current = false
    })
  }, [scrollResetKey, restoreKey, emitFirstVisibleIndex])

  useLayoutEffect(() => {
    if (!layoutReady || !restoreKey || consumedRestoreKeyRef.current === restoreKey) return
    if (restoreIndex == null || restoreIndex < 0) return
    const el = scrollRef.current
    if (!el) return
    const measured = measureLayout(el)
    if (!measured) {
      markLayoutNotReady()
      return
    }
    const prev = layoutRef.current
    const layoutChanged = prev.cols !== measured.cols || Math.abs(prev.cellWidth - measured.cellWidth) >= 0.5
    if (layoutChanged) {
      const next = { cols: measured.cols, cellWidth: measured.cellWidth }
      layoutRef.current = next
      setLayout(next)
      onLayout?.(measured)
    }
    const { cols, cellWidth } = measured
    const rowH = calcRowHeight(cellWidth) + rowGap
    const row = Math.floor(restoreIndex / Math.max(1, cols))
    const targetTop = padding + row * rowH
    consumedRestoreKeyRef.current = restoreKey
    suppressAnchorRef.current = true
    el.scrollTop = targetTop
    anchorRef.current = row * cols
    emitFirstVisibleIndex(anchorRef.current)
    requestAnimationFrame(() => {
      suppressAnchorRef.current = false
    })
  }, [
    layoutReady,
    restoreIndex,
    restoreKey,
    calcRowHeight,
    rowGap,
    padding,
    emitFirstVisibleIndex,
    measureLayout,
    markLayoutNotReady,
    onLayout,
  ])

  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const measured = measureLayout(el)
    if (!measured) {
      markLayoutNotReady()
      return
    }
    const { cols: newCols, cellWidth: newCellWidth, availableWidth: avail } = measured

    const prev = layoutRef.current
    const colsChanged = prev.cols !== newCols || Math.abs(prev.cellWidth - newCellWidth) >= 0.5
    // Always report availableWidth so the size slider stays in sync after resize,
    // but only update internal layout state (and fix scroll) when columns actually change.
    if (!colsChanged) {
      onLayout?.({ cols: newCols, cellWidth: newCellWidth, availableWidth: avail })
      markLayoutReady()
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
    markLayoutReady()
  }, [calcRowHeight, rowGap, padding, onLayout, markLayoutReady, markLayoutNotReady, measureLayout])

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
    <div
      ref={scrollRef}
      data-page-nav-scroll
      className={`overflow-y-auto ${className}`}
      onMouseDown={onScrollMouseDown}
    >
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
export function VirtualList({
  items,
  rowHeight = 37,
  renderRow,
  className = '',
  overscan = 5,
  scrollResetKey,
  restoreIndex = null,
  restoreKey = '',
  onFirstVisibleIndexChange,
}) {
  const scrollRef = useRef(null)
  const consumedRestoreKeyRef = useRef('')
  const lastFirstVisibleIndexRef = useRef(null)
  const onFirstVisibleIndexChangeRef = useRef(onFirstVisibleIndexChange)

  useLayoutEffect(() => {
    onFirstVisibleIndexChangeRef.current = onFirstVisibleIndexChange
  }, [onFirstVisibleIndexChange])

  const emitFirstVisibleIndex = useCallback((index) => {
    if (lastFirstVisibleIndexRef.current === index) return
    lastFirstVisibleIndexRef.current = index
    onFirstVisibleIndexChangeRef.current?.(index)
  }, [])

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
    if (!el) return
    if (restoreKey && consumedRestoreKeyRef.current !== restoreKey) return
    if (el.scrollTop === 0) {
      emitFirstVisibleIndex(0)
      return
    }
    el.scrollTop = 0
    emitFirstVisibleIndex(0)
  }, [scrollResetKey, restoreKey, emitFirstVisibleIndex])

  useLayoutEffect(() => {
    if (!restoreKey || consumedRestoreKeyRef.current === restoreKey) return
    if (restoreIndex == null || restoreIndex < 0) return
    const el = scrollRef.current
    if (!el) return
    consumedRestoreKeyRef.current = restoreKey
    el.scrollTop = restoreIndex * rowHeight
    emitFirstVisibleIndex(restoreIndex)
  }, [restoreIndex, restoreKey, rowHeight, emitFirstVisibleIndex])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      emitFirstVisibleIndex(Math.max(0, Math.floor(el.scrollTop / rowHeight)))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [rowHeight, emitFirstVisibleIndex])

  return (
    <div ref={scrollRef} data-page-nav-scroll className={`overflow-y-auto ${className}`}>
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
