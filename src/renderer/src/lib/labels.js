/**
 * User-defined Labels — color palette and helpers shared across cards, chips,
 * detail panels, and the filter sidebar.
 *
 * Encoding for `label.color`:
 *   `null` → user picked "None"  → muted gray (renders like Hub Tags)
 *   `-1`   → user picked "Auto"  → derived from id hash; default at creation
 *   `0..N` → explicit palette index → `LABEL_PALETTE[i]`
 */

export const LABEL_PALETTE = [
  '#ef5bed', // pink
  '#8b5cf6', // purple
  '#60a5fa', // sky
  '#22d3ee', // cyan
  '#34d399', // emerald
  '#a3e635', // lime
  '#fbbf24', // amber
  '#fb923c', // orange
  '#f472b6', // rose-pink
  '#94a3b8', // slate
]

export const LABEL_NONE_COLOR = '#82849a' // text-secondary tone — the muted "None" appearance

export const COLOR_NONE = null
export const COLOR_AUTO = -1

/** Stable id → palette index. Keeps the Auto color sticky across renames. */
function paletteIndexFromId(id) {
  let h = 0
  const s = String(id)
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % LABEL_PALETTE.length
}

/** Resolve a label's color value (string css color) — handles None / Auto / explicit. */
export function labelColor(label) {
  if (!label) return LABEL_NONE_COLOR
  if (label.color === null) return LABEL_NONE_COLOR
  if (label.color === COLOR_AUTO || typeof label.color !== 'number') return LABEL_PALETTE[paletteIndexFromId(label.id)]
  if (label.color >= 0 && label.color < LABEL_PALETTE.length) return LABEL_PALETTE[label.color]
  return LABEL_PALETTE[paletteIndexFromId(label.id)]
}

/** Whether the label uses the muted "None" appearance. */
export function isMutedLabel(label) {
  return !!label && label.color === null
}
