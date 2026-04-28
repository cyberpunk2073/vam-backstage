import { toast } from '../Toast'

/**
 * Shared apply / create-and-apply handlers for label "add" affordances on a
 * single subject. Both the in-row dashed `+` chip and the per-panel one-off
 * empty-state buttons (e.g. the content detail Tag icon) plug in here so the
 * IPC + toast boilerplate isn't duplicated.
 *
 * `onApplyToTarget(labelId, applied)` is the per-target IPC the consumer wires
 * (`labels.applyToPackages` for the Library, `labels.applyToContents` for
 * Content).
 */
export function useAddLabel(onApplyToTarget) {
  const handleApply = async (label) => {
    try {
      await onApplyToTarget(label.id, true)
    } catch (err) {
      toast(`Failed to apply label: ${err.message}`)
    }
  }
  const handleCreate = async (name) => {
    try {
      const created = await window.api.labels.create({ name })
      await onApplyToTarget(created.id, true)
    } catch (err) {
      toast(`Failed to create label: ${err.message}`)
    }
  }
  return { handleApply, handleCreate }
}
