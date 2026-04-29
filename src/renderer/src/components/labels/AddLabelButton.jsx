import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLabelsStore } from '@/stores/useLabelsStore'
import { LabelApplyPopover } from './LabelApplyPopover'
import { useAddLabel } from './useAddLabel'

/**
 * Dashed icon-only `+` chip that opens the label-apply combobox. Used both
 * inline in `LabelsRow` (after applied chips, "add another") and standalone
 * in detail-panel empty states (e.g. the library detail metadata chip row).
 *
 * Sized to match `LabelChip`'s 20px height so it aligns cleanly with chips
 * regardless of inherited line-height.
 */
export function AddLabelButton({ appliedIds = [], onApplyToTarget, ariaLabel = 'Add label', align = 'start' }) {
  const allLabels = useLabelsStore((s) => s.labels)
  const { handleApply, handleCreate } = useAddLabel(onApplyToTarget)
  return (
    <LabelApplyPopover
      labels={allLabels}
      appliedIds={appliedIds}
      onApply={handleApply}
      onCreate={handleCreate}
      align={align}
    >
      <button
        type="button"
        title={ariaLabel}
        aria-label={ariaLabel}
        className={cn(
          'inline-flex items-center justify-center h-5 w-5 box-border rounded cursor-pointer transition-colors',
          'border border-dashed border-border text-text-tertiary hover:text-text-primary hover:border-text-tertiary',
          'data-[state=open]:border-text-tertiary data-[state=open]:text-text-primary',
        )}
      >
        <Plus size={11} />
      </button>
    </LabelApplyPopover>
  )
}
