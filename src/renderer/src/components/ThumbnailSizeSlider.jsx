import { useMemo } from 'react'
import { Mountain } from 'lucide-react'

const MIN_CARD_WIDTH = 100
const MAX_CARD_WIDTH = 500

/**
 * Column-count slider that stores an itemWidth under the hood.
 *
 * Detents map to column counts. The first and last positions pin to
 * MAX_CARD_WIDTH / MIN_CARD_WIDTH so they stay stable across window resizes
 * (the slider range may grow/shrink but the endpoints never jitter).
 * Middle positions compute the exact width for N columns at the current width.
 *
 * Left = fewer columns (larger cards), right = more columns (smaller cards).
 */
export function ThumbnailSizeSlider({ cardWidth, availableWidth, gap = 12, onCardWidthChange }) {
  const { minCols, maxCols, currentCols } = useMemo(() => {
    if (!availableWidth) return { minCols: 1, maxCols: 1, currentCols: 1 }
    const max = Math.max(1, Math.floor((availableWidth + gap) / (MIN_CARD_WIDTH + gap)))
    const min = Math.max(1, Math.ceil((availableWidth + gap) / (MAX_CARD_WIDTH + gap)))
    const current = Math.max(1, Math.floor((availableWidth + gap) / (cardWidth + gap)))
    return { minCols: min, maxCols: max, currentCols: Math.min(Math.max(current, min), max) }
  }, [availableWidth, cardWidth, gap])

  const handleChange = (e) => {
    const targetCols = Number(e.target.value)
    if (targetCols <= minCols) {
      // Left edge — pin to max card width so it's stable across resizes
      onCardWidthChange(MAX_CARD_WIDTH)
    } else if (targetCols >= maxCols) {
      // Right edge — pin to min card width so it's stable across resizes
      onCardWidthChange(MIN_CARD_WIDTH)
    } else {
      // Middle — exact width for N columns at current available width
      onCardWidthChange(Math.floor((availableWidth - (targetCols - 1) * gap) / targetCols))
    }
  }

  if (maxCols <= minCols) return null

  return (
    <div className="flex items-center gap-1.5 text-text-tertiary">
      <Mountain size={14} />
      <input
        type="range"
        min={minCols}
        max={maxCols}
        step={1}
        value={currentCols}
        onChange={handleChange}
        className="thumbnail-size-slider"
        title={`${currentCols} columns`}
      />
      <Mountain size={10} />
    </div>
  )
}
