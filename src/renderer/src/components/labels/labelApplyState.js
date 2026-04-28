/**
 * Pure helpers for the per-target "applied state" map consumed by
 * `LabelsApplyMenuItems` / `LabelApplyPopover`. Lives in its own module so consumers (views,
 * context menus) don't have to import from a `.jsx` component file — that
 * would defeat Vite Fast Refresh.
 *
 * `stateById` is a `Map<id, 'all' | 'partial'>`. Labels not in the map are
 * treated as `'none'` by the consumer.
 */

/** Single target → every applied label is `'all'`, others omitted. */
export function singleTargetStateMap(appliedIds) {
  const m = new Map()
  for (const id of appliedIds || []) m.set(id, 'all')
  return m
}

/** Bulk → `'all'` when every target carries the label, `'partial'` if some do. */
export function bulkStateMap(perTargetAppliedIds) {
  const counts = new Map()
  const total = perTargetAppliedIds.length
  for (const ids of perTargetAppliedIds) {
    for (const id of ids || []) counts.set(id, (counts.get(id) || 0) + 1)
  }
  const m = new Map()
  for (const [id, n] of counts) {
    m.set(id, n === total ? 'all' : 'partial')
  }
  return m
}
