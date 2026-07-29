import { useCallback, useEffect, useRef, useState } from 'react'
import { useHubStore } from '@/stores/useHubStore'
import { HUB_PER_PAGE } from '@shared/hub-http.js'

/** Sample the desired window on a fixed cadence — not per scroll event — so a fling
 *  crossing fifty windows produces at most ~5 candidates/sec. */
const SAMPLE_MS = 200

/** After this much quiet, treat velocity as settled so a scrollbar jump can load. */
const SETTLE_MS = 120

/** Extra rows requested beyond the virtualizer's overscan window, so steady scrolling
 *  stays ahead of the viewport. The window itself is the bound on queue size. */
const PREFETCH_ROWS = 4

/** Window the velocity is expressed over: roughly one Hub round trip. Fixed rather than
 *  measured so suppression stays predictable. */
const FUTILITY_MS = 2500

/** Items crossed per `FUTILITY_MS` above which the viewport is scrubbing: a whole page
 *  would scroll past before a response could land. Below `SCRUB_OFF` it isn't — the gap
 *  between the two is hysteresis, so scrolling near the threshold doesn't oscillate. */
const SCRUB_ON = HUB_PER_PAGE
const SCRUB_OFF = HUB_PER_PAGE / 2

/**
 * Wire VirtualGrid's `onRangeChange` to the hub store's `loadRange` with request
 * discipline: cadence sampling, bounded prefetch, and a velocity check that skips
 * fetches only while actively moving too fast for a response to land on-screen (not
 * after a jump has already settled).
 *
 * Returns that same velocity judgement as `scrubbing`, which the gallery uses to hold
 * back CDN thumbnail requests for cards nobody will see.
 */
export function useHubRangeLoader({ enabled, cols }) {
  const [scrubbing, setScrubbing] = useState(false)
  const desiredRef = useRef({ start: 0, end: 0 })
  const velocityRef = useRef({ index: 0, at: 0, itemsPerMs: 0 })
  const settleTimerRef = useRef(null)
  const colsRef = useRef(cols)
  colsRef.current = Math.max(1, cols || 1)
  // The hidden hub grid still reports ranges in wishlist mode (<Activity> re-runs its
  // effects), so ignore them there rather than tracking a viewport nobody is looking at.
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const tryLoad = useCallback(() => {
    const { start, end } = desiredRef.current
    if (end < start) return

    const now = performance.now()
    const { itemsPerMs, at } = velocityRef.current
    // Only suppress while the viewport is still moving. After a scrub/fling the EMA
    // stays high for a long time if we don't treat a quiet gap as "settled" — that
    // delayed the first fetch by seconds after the user already stopped.
    const stillMoving = now - at < SETTLE_MS
    if (stillMoving && itemsPerMs * FUTILITY_MS > SCRUB_ON) return

    // The window is already bounded by the virtualizer's overscan, so a fixed row margin
    // is the whole bound. loadRange fetches nearest-to-anchor pages first, so the viewport
    // is served before the prefetch edges.
    const prefetch = PREFETCH_ROWS * colsRef.current
    useHubStore.getState().loadRange(start - prefetch, end + prefetch, { anchor: Math.floor((start + end) / 2) })
  }, [])

  /** Motion has stopped: thumbnails are worth loading again, and so is the window. */
  const settle = useCallback(() => {
    setScrubbing(false)
    tryLoad()
  }, [tryLoad])

  const onRangeChange = useCallback(
    (start, end) => {
      if (!enabledRef.current) return
      desiredRef.current = { start, end }
      const mid = (start + end) / 2
      const now = performance.now()
      const prev = velocityRef.current
      // The very first sample has no baseline to measure against; velocity starts at 0.
      const dt = now - prev.at
      const itemsPerMs =
        prev.at > 0 && dt > 0 ? prev.itemsPerMs * 0.6 + (Math.abs(mid - prev.index) / dt) * 0.4 : prev.itemsPerMs
      velocityRef.current = { index: mid, at: now, itemsPerMs }

      const crossed = itemsPerMs * FUTILITY_MS
      setScrubbing((was) => crossed > (was ? SCRUB_OFF : SCRUB_ON))

      // Fire as soon as motion stops, instead of waiting for the next sampler tick
      // (and instead of waiting for the EMA to decay).
      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = setTimeout(settle, SETTLE_MS)
    },
    [settle],
  )

  useEffect(() => {
    if (!enabled) return
    const id = setInterval(tryLoad, SAMPLE_MS)
    return () => {
      clearInterval(id)
      clearTimeout(settleTimerRef.current)
      setScrubbing(false)
    }
  }, [enabled, tryLoad])

  return { onRangeChange, scrubbing }
}
