import { toast } from '@/components/Toast'

/**
 * Non-JSX label helpers shared by views, context menus and the apply popover.
 * Kept out of the `.jsx` component files so importing them doesn't pull a
 * component module (which would defeat Vite Fast Refresh).
 *
 * Two concerns live here:
 *  - IPC apply/remove actions (`applyLabelTo*`)
 *  - the per-target "applied state" map (`*StateMap`) consumed by
 *    `LabelsApplyMenuItems` / `LabelApplyPopover`, a `Map<id, 'all' | 'partial'>`
 *    where labels absent from the map are treated as `'none'`.
 */

/**
 * Apply or remove `labelId` on N packages in one IPC call. Toast on failure;
 * caller-side updates come from the `packages:updated` / `labels:updated`
 * notifications fired by the main-process handler.
 */
export async function applyLabelToFilenames(id, filenames, applied) {
  if (!filenames.length) return
  try {
    await window.api.labels.applyToPackages({ id, filenames, applied })
  } catch (err) {
    toast(`Failed to ${applied ? 'apply' : 'remove'} label: ${err.message}`)
  }
}

/**
 * Apply or remove `labelId` on N content items in one IPC call. Same toast +
 * notify rules as `applyLabelToFilenames`.
 */
export async function applyLabelToContentItems(id, items, applied) {
  if (!items.length) return
  try {
    await window.api.labels.applyToContents({ id, items, applied })
  } catch (err) {
    toast(`Failed to ${applied ? 'apply' : 'remove'} label: ${err.message}`)
  }
}

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
