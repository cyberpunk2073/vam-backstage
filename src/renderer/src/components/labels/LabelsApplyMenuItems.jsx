import { useMemo } from 'react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { labelColor } from '@/lib/labels'
import { sortLabelsByName } from './labelHelpers'
import { LabelStateCheckbox } from './LabelStateCheckbox'

/**
 * Right-click Labels submenu: plain Radix menu items with tri-state markers.
 * No search or create (batch bar / "+" chip handle that via `LabelApplyPopover`).
 */
export function LabelsApplyMenuItems({ labels, stateById, onToggle }) {
  const sorted = useMemo(() => sortLabelsByName(labels), [labels])

  if (sorted.length === 0) {
    return <div className="px-2 py-1.5 text-[11px] text-text-tertiary">No labels yet</div>
  }

  return (
    <div className="max-h-64 overflow-y-auto py-1">
      {sorted.map((l) => {
        const state = stateById.get(l.id) || 'none'
        return (
          <ContextMenuItem
            key={l.id}
            textValue={l.name}
            className="w-full justify-start text-left text-xs gap-2 cursor-pointer"
            onSelect={(e) => {
              e.preventDefault()
              onToggle?.(l, state)
            }}
          >
            <LabelStateCheckbox state={state} />
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: labelColor(l) }} />
            <span className="truncate flex-1 text-text-primary">{l.name}</span>
          </ContextMenuItem>
        )
      })}
    </div>
  )
}
