import { describe, expect, it } from 'vitest'
import { loadedPageRanges, thumbMetrics, trackPaintRange } from './HubBrowsedRail.jsx'

describe('loadedPageRanges', () => {
  it('merges contiguous pages into one range', () => {
    expect(loadedPageRanges(new Set([1, 2, 3]), 500, 60)).toEqual([{ start: 0, end: 180 }])
  })

  it('keeps gaps as separate ranges', () => {
    expect(loadedPageRanges(new Set([1, 3]), 500, 60)).toEqual([
      { start: 0, end: 60 },
      { start: 120, end: 180 },
    ])
  })

  it('clips the last page to itemCount', () => {
    expect(loadedPageRanges(new Set([2]), 70, 60)).toEqual([{ start: 60, end: 70 }])
  })
})

describe('thumbMetrics', () => {
  it('places the thumb center at mid-track when scrolled to mid content', () => {
    // 200px track over 1000px of content → thumb is 20% of the track; mid scrollTop = 400
    const m = thumbMetrics({ clientHeight: 200, scrollHeight: 1000, scrollTop: 400 })
    expect(m.thumbH).toBe(40)
    expect(m.thumbCenter).toBe(100)
  })
})

describe('trackPaintRange', () => {
  it('paints content fractions of the track when offset is 0 (grab at center)', () => {
    // Items 25–50 of 100 on a 400px track → 100–200px
    expect(trackPaintRange(25, 50, 100, 400, 0)).toEqual({ top: 100, height: 100 })
  })

  it('shifts by the press offset from thumb center', () => {
    // Grab 20px above center → marks move up 20px
    expect(trackPaintRange(25, 50, 100, 400, -20)).toEqual({ top: 80, height: 100 })
  })

  it('clips to the track', () => {
    expect(trackPaintRange(0, 10, 100, 400, -30)).toEqual({ top: 0, height: 10 })
    expect(trackPaintRange(90, 100, 100, 400, 30)).toEqual({ top: 390, height: 10 })
  })
})
