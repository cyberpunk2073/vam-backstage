import { useEffect, useMemo, useState } from 'react'
import { HUB_PER_PAGE } from '@shared/hub-http.js'

/** Fallback when the scroll element reports no gutter (overlay scrollbars); matches
 *  `::-webkit-scrollbar { width: 6px }` in main.css, which is what we normally measure. */
const SCROLLBAR_PX = 6

/** Slack around the measured scrollbar, so a press a pixel off it still counts as a grab. */
const GUTTER_SLACK_PX = 4

/** Don't paint browsed marks on short result sets — the rail only helps once there are
 *  enough pages that scrubbing past loaded chunks is a real concern. */
const MIN_RAIL_PAGES = 10

function railEligible(itemCount) {
  return itemCount > MIN_RAIL_PAGES * HUB_PER_PAGE
}

/** Actual scrollbar width: styling `::-webkit-scrollbar` makes it a classic (space-taking)
 *  scrollbar, so the gutter is the difference between the border box and the content box. */
function scrollbarWidth(el) {
  return el.offsetWidth - el.clientWidth || SCROLLBAR_PX
}

/**
 * Merge 1-based page numbers into contiguous [startItem, endItem) ranges in item space.
 */
export function loadedPageRanges(loadedPages, itemCount, perPage = HUB_PER_PAGE) {
  if (!itemCount || !loadedPages?.size) return []
  const pages = [...loadedPages].sort((a, b) => a - b)
  const ranges = []
  let start = (pages[0] - 1) * perPage
  let end = Math.min(itemCount, pages[0] * perPage)
  for (let i = 1; i < pages.length; i++) {
    const p = pages[i]
    const pStart = (p - 1) * perPage
    const pEnd = Math.min(itemCount, p * perPage)
    if (pStart <= end) {
      end = Math.max(end, pEnd)
    } else {
      ranges.push({ start, end })
      start = pStart
      end = pEnd
    }
  }
  ranges.push({ start, end })
  return ranges
}

/**
 * Synthetic thumb geometry for a scroll element, whose track spans its client height.
 * Matches the browser's mapping (thumbTop = scrollTop/scrollHeight * trackH, which is
 * the travel-based form below).
 */
export function thumbMetrics(el) {
  const trackH = el.clientHeight
  const scrollHeight = el.scrollHeight
  if (trackH <= 0 || scrollHeight <= 0) return { trackH, thumbTop: 0, thumbH: trackH, thumbCenter: trackH / 2 }
  // Chromium never draws the thumb shorter than it is wide.
  const thumbH = Math.max(SCROLLBAR_PX, (trackH / scrollHeight) * trackH)
  const travel = Math.max(0, trackH - thumbH)
  const maxScroll = Math.max(0, scrollHeight - trackH)
  const thumbTop = maxScroll > 0 ? (el.scrollTop / maxScroll) * travel : 0
  return { trackH, thumbTop, thumbH, thumbCenter: thumbTop + thumbH / 2 }
}

/**
 * Map a loaded item range to track pixels. Scroll position is keyed to thumb center;
 * `centerOffsetPx` is (cursorY - thumbCenterY) at the grab — constant for the drag —
 * so marks stay under the cursor for that grab point.
 */
export function trackPaintRange(startItem, endItem, itemCount, trackH, centerOffsetPx) {
  if (itemCount <= 0 || endItem <= startItem || trackH <= 0) return null
  const top = (startItem / itemCount) * trackH + centerOffsetPx
  const bottom = (endItem / itemCount) * trackH + centerOffsetPx
  // Clip to the track.
  const clippedTop = Math.max(0, top)
  const clippedBottom = Math.min(trackH, bottom)
  const height = clippedBottom - clippedTop
  if (height <= 0) return null
  return { top: clippedTop, height }
}

/**
 * Marks on the scrollbar track for regions already loaded this query.
 * Visible only while dragging the scroll thumb; shifted by the grab offset from
 * thumb center so the cursor stays aligned with those regions.
 *
 * Chromium handles scrollbar presses natively, so a press on the thumb never reaches
 * the scroll element as a DOM event. Window-level pointer tracking sees it anyway:
 * grabbing the thumb arms immediately (giving the exact offset, measured before the
 * thumb moves), and a press on the *track* — which jumps the thumb first — arms on the
 * scroll that jump produces, measuring the offset once the thumb has landed.
 */
export function HubBrowsedRail({ scrollEl, itemCount, loadedPages }) {
  const [drag, setDrag] = useState(null) // { centerOffsetPx, trackH, top, left, width } while dragging

  // Only ever needed for the duration of a drag, so there's nothing to keep warm.
  const paintRanges = useMemo(() => {
    if (!drag) return []
    return loadedPageRanges(loadedPages, itemCount)
      .map(({ start, end }) => trackPaintRange(start, end, itemCount, drag.trackH, drag.centerOffsetPx))
      .filter(Boolean)
  }, [loadedPages, itemCount, drag])

  useEffect(() => {
    if (!scrollEl || !railEligible(itemCount)) {
      setDrag(null)
      return
    }

    let clientX = 0
    let clientY = 0
    let primaryDown = false
    let armed = false

    const inGutter = () => {
      const rect = scrollEl.getBoundingClientRect()
      return (
        clientX >= rect.right - scrollbarWidth(scrollEl) - GUTTER_SLACK_PX &&
        clientX <= rect.right + GUTTER_SLACK_PX &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      )
    }

    const arm = () => {
      if (armed) return
      armed = true
      const rect = scrollEl.getBoundingClientRect()
      const width = scrollbarWidth(scrollEl)
      const { trackH, thumbCenter } = thumbMetrics(scrollEl)
      // Anchored to the scroll element's own box, not the containing panel, so an error
      // banner above the gallery can't shift every mark down by its height.
      setDrag({
        centerOffsetPx: clientY - rect.top - thumbCenter,
        trackH,
        top: rect.top,
        left: rect.right - width,
        width,
      })
    }

    const disarm = () => {
      if (!armed) return
      armed = false
      setDrag(null)
    }

    /**
     * True when the cursor is over the thumb itself rather than the empty track. Slack
     * because at catalog depth the thumb sits at Chromium's minimum length, where the
     * synthetic geometry and the drawn thumb can disagree by a pixel or two — and a miss
     * here downgrades a clean grab to the track-press path, which measures the offset
     * mid-drag and lands slightly off.
     */
    const onThumb = () => {
      const { thumbTop, thumbH } = thumbMetrics(scrollEl)
      const y = clientY - scrollEl.getBoundingClientRect().top
      return y >= thumbTop - GUTTER_SLACK_PX && y <= thumbTop + thumbH + GUTTER_SLACK_PX
    }

    const onPointerDown = (e) => {
      if (e.button !== 0) return
      clientX = e.clientX
      clientY = e.clientY
      primaryDown = true
      if (inGutter() && onThumb()) arm()
    }

    const onPointerMove = (e) => {
      clientX = e.clientX
      clientY = e.clientY
      primaryDown = (e.buttons & 1) !== 0
      if (!primaryDown) disarm()
    }

    const onPointerUp = (e) => {
      if (e.button === 0 || (e.buttons & 1) === 0) {
        primaryDown = false
        disarm()
      }
    }

    const onScroll = () => {
      if (!primaryDown || !inGutter()) return
      arm()
    }

    // Capture on window: native scrollbar presses often never reach the scroll element.
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      scrollEl.removeEventListener('scroll', onScroll)
      setDrag(null)
    }
  }, [scrollEl, itemCount])

  if (!drag || !railEligible(itemCount) || paintRanges.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed z-10"
      style={{ top: drag.top, left: drag.left, width: drag.width, height: drag.trackH }}
      aria-hidden="true"
    >
      {paintRanges.map(({ top, height }, i) => (
        <div
          key={i}
          className="absolute right-0 w-full rounded-sm bg-accent-blue/40"
          style={{ top, height: Math.max(height, 2) }}
        />
      ))}
    </div>
  )
}
