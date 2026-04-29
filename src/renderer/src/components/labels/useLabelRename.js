import { useState } from 'react'
import { toast } from '@/components/Toast'
import { useLabelsStore } from '@/stores/useLabelsStore'

/**
 * State + handlers for inline renaming of a label chip. Used by `LabelsRow`
 * (detail panels) and `FilterPanel`'s `LabelsAutocomplete`. Both surfaces
 * render the rename input as part of `LabelChip` (`renaming` + `editValue` +
 * `onEditChange` + `onCommit` + `onCancel`).
 *
 * Resolves the original name from `useLabelsStore.byId` rather than the
 * caller's local list — the store is the single source of truth and both
 * existing call sites already render off it.
 */
export function useLabelRename() {
  const [renamingId, setRenamingId] = useState(null)
  const [renameDraft, setRenameDraft] = useState('')

  const startRename = (label) => {
    setRenamingId(label.id)
    setRenameDraft(label.name)
  }
  const cancelRename = () => setRenamingId(null)
  const commitRename = async () => {
    const id = renamingId
    if (id == null) return
    const trimmed = renameDraft.trim()
    const original = useLabelsStore.getState().byId.get(id)
    if (!trimmed || trimmed === original?.name) {
      setRenamingId(null)
      return
    }
    try {
      await window.api.labels.rename({ id, name: trimmed })
      useLabelsStore.getState().applyLabelPatch(id, { name: trimmed })
      setRenamingId(null)
    } catch (err) {
      toast(err.code === 'LABEL_NAME_EXISTS' ? `A label named "${trimmed}" already exists` : err.message, 'error')
    }
  }

  return { renamingId, renameDraft, setRenameDraft, startRename, commitRename, cancelRename }
}
