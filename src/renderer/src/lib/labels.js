/**
 * User-defined Labels — color palette and helpers shared across cards, chips,
 * detail panels, and the filter sidebar.
 *
 * Encoding for `label.color`:
 *   `null` → user picked "None"  → muted gray (renders like Hub Tags)
 *   `-1`   → user picked "Auto"  → derived from id hash; default at creation
 *   `0..N` → explicit palette index → `LABEL_PALETTE[i].hex`
 */

/**
 * Curated label palette. Two groups, packed into a single index space so DB
 * `color` integers stay simple:
 *
 *   Sharp (slots 0–7, 9) — vivid primary tagging. Each color sits in OKLCH
 *   lightness band ~0.71–0.78 so no single dot dominates a multi-label
 *   cluster, with hues spaced to stay distinguishable at the 6px dot size
 *   used on cards. Hexes track Tailwind v4's OKLCH-curated stops (mostly
 *   *-400) — except `lime` / `amber`, which use *-500 because their *-400
 *   stops sit perceptually around L≈0.85 and would always shout louder than
 *   neighbours on the dark surface.
 *
 *   Soft (slots 8, 10) — low-chroma "calm" alternatives (mauve, slate). Same
 *   lightness band, C≈0.06–0.08. Useful for backlog / low-priority / personal
 *   tags. One warm + one cool gives users semantic vocabulary; more would
 *   just pad the picker.
 *
 * Brand colors inform but don't define this palette. Brand pink (`#ef5bed`)
 * fits the band as-is and anchors slot 0. Brand purple (`#8b5cf6`) and brand
 * blue (`#4a91f1`) sit perceptually heavy at 6px, so the matching label slots
 * use lifted siblings (Tailwind violet-400 / blue-400) that read better as
 * small dots while staying in the same hue family.
 *
 * Indices are append-only / stable: the DB stores the integer index, so we
 * tweak hexes in place but only ever extend the array. Slot 8 used to be a
 * sharp rose-pink — nearly a duplicate of slot 0 — and now hosts the soft
 * mauve. Slot 10 is the new soft slate.
 */
export const LABEL_PALETTE = [
  { hex: '#ef5bed', name: 'Pink' }, // 0  brand pink
  { hex: '#a78bfa', name: 'Violet' }, // 1  lifted from brand purple
  { hex: '#60a5fa', name: 'Blue' }, // 2  lifted from brand blue
  { hex: '#2dd4bf', name: 'Teal' }, // 3
  { hex: '#34d399', name: 'Emerald' }, // 4
  { hex: '#84cc16', name: 'Lime' }, // 5  pulled darker for balance
  { hex: '#f59e0b', name: 'Amber' }, // 6  pulled darker for balance
  { hex: '#fb923c', name: 'Orange' }, // 7
  { hex: '#b78a9a', name: 'Mauve', soft: true }, // 8  replaces rose-pink
  { hex: '#f87171', name: 'Red' }, // 9
  { hex: '#7a8da8', name: 'Slate', soft: true }, // 10 new soft cool
]

// Neutral chrome gray for the "None" dot. Deliberately near-zero chroma and
// a step darker than the soft slate slot, so the dot reads as "no color
// chosen" rather than as another cool-blue label. Slate sits at L≈0.62 with a
// clear blue tint; this lands at L≈0.55 with effectively no hue, giving the
// two clearly distinct identities at the 6px dot size.
export const LABEL_NONE_COLOR = '#71717a'

export const COLOR_NONE = null
export const COLOR_AUTO = -1

/**
 * Sharp-only index list used by the Auto-color hash. Auto labels deliberately
 * skip soft slots — those are user picks ("calm" semantics), not auto-assigned.
 */
const SHARP_PALETTE_INDICES = LABEL_PALETTE.map((_, i) => i).filter((i) => !LABEL_PALETTE[i].soft)

/** Stable id → sharp palette index. Keeps the Auto color sticky across renames. */
function paletteIndexFromId(id) {
  let h = 0
  const s = String(id)
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return SHARP_PALETTE_INDICES[Math.abs(h) % SHARP_PALETTE_INDICES.length]
}

/** Resolve a label's color value (string css color) — handles None / Auto / explicit. */
export function labelColor(label) {
  if (!label) return LABEL_NONE_COLOR
  if (label.color === null) return LABEL_NONE_COLOR
  if (label.color === COLOR_AUTO || typeof label.color !== 'number')
    return LABEL_PALETTE[paletteIndexFromId(label.id)].hex
  if (label.color >= 0 && label.color < LABEL_PALETTE.length) return LABEL_PALETTE[label.color].hex
  return LABEL_PALETTE[paletteIndexFromId(label.id)].hex
}

/** Whether the label uses the muted "None" appearance. */
export function isMutedLabel(label) {
  return !!label && label.color === null
}
