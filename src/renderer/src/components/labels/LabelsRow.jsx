import { LabelChip } from './LabelChip'
import { LabelManageMenu } from './LabelManageMenu'
import { enableMatchingPackages } from './labelActions'
import { AddLabelButton } from './AddLabelButton'
import { useLabelObjects } from './useLabelObjects'
import { useLabelRename } from './useLabelRename'
import { toast } from '../Toast'

/**
 * Chip-flow + `+` chip for a single subject (one package or one content item).
 * Shown on detail panels. Right-click on a chip opens the management menu;
 * clicking `+` opens a combobox popover (existing labels + create-inline).
 *
 * On the `'item'` surface the row hides itself entirely when there are no
 * applied labels — each detail panel hosts its own empty-state affordance
 * (inline `+` chip in the library metadata chip row, Tag icon in the content
 * header). The `'sidebar'` surface always renders.
 *
 * `onApplyToTarget(labelId, applied)` is the per-target IPC the consumer wires
 * (`labels.applyToPackages` for the Library, `labels.applyToContents` for
 * Content).
 */
export function LabelsRow({ appliedIds = [], onApplyToTarget, surface = 'item' }) {
  const applied = useLabelObjects(appliedIds)
  const { renamingId, renameDraft, setRenameDraft, startRename, commitRename, cancelRename } = useLabelRename()

  if (surface === 'item' && applied.length === 0) return null

  const handleRemoveFromItem = async (label) => {
    try {
      await onApplyToTarget(label.id, false)
    } catch (err) {
      toast(`Failed to remove label: ${err.message}`)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {applied.map((label) => (
        <LabelManageMenu
          key={label.id}
          label={label}
          surface={surface}
          applicationCount={(label.packageCount || 0) + (label.contentCount || 0)}
          onStartRename={() => startRename(label)}
          onRemoveFromItem={surface === 'item' ? () => handleRemoveFromItem(label) : undefined}
          onEnableMatching={() => enableMatchingPackages(label.id, true)}
          onDisableMatching={() => enableMatchingPackages(label.id, false)}
        >
          <LabelChip
            label={label}
            interactive
            filled
            onNameDoubleClick={() => startRename(label)}
            onRemove={() => handleRemoveFromItem(label)}
            renaming={renamingId === label.id}
            editValue={renameDraft}
            onEditChange={setRenameDraft}
            onCommit={commitRename}
            onCancel={cancelRename}
          />
        </LabelManageMenu>
      ))}
      <AddLabelButton appliedIds={appliedIds} onApplyToTarget={onApplyToTarget} />
    </div>
  )
}
