import { useEffect } from 'react'
import { HelpCircle, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useHintsStore } from '@/stores/useHintsStore'
import { META_DENSE } from '@/lib/typography'
import { cn, IS_MAC } from '@/lib/utils'

const MOD = IS_MAC ? '⌘' : 'Ctrl'

function Key({ children }) {
  return <span className="text-text-primary">{children}</span>
}

function Cheatsheet() {
  return (
    <div className="space-y-2.5">
      <div>
        <div className="mb-1 text-text-tertiary">Mouse</div>
        <div>
          <Key>{MOD}+click</Key> - add or remove
        </div>
        <div>
          <Key>Shift+click</Key> - select a range
        </div>
        <div>
          <Key>{MOD}+Shift+click</Key> - add a range
        </div>
        <div>
          <Key>Click</Key> - select only this
        </div>
      </div>
      <div>
        <div className="mb-1 text-text-tertiary">Keyboard</div>
        <div>
          <Key>{MOD}+A</Key> - select all
        </div>
        <div>
          <Key>Arrows</Key> - move focus
        </div>
        <div>
          <Key>Space</Key> - toggle focused item
        </div>
        <div>
          <Key>Shift+Arrow</Key> - extend range
        </div>
        <div>
          <Key>Shift+Home / End</Key> - extend to first / last
        </div>
        <div>
          <Key>Home / End</Key> - jump to first / last
        </div>
        <div>
          <Key>Esc</Key> - deselect
        </div>
      </div>
    </div>
  )
}

/**
 * Idle: one-shot tip teaching multi-select entry. Bulk: muted "?" cheatsheet.
 * After the tip is dismissed (× or first bulk selection), idle shows nothing.
 *
 * @param {{ bulkActive: boolean }} props
 */
export function SelectionHint({ bulkActive }) {
  const tipDone = useHintsStore((s) => s.multiSelectTipDone)
  const dismiss = useHintsStore((s) => s.dismissMultiSelectTip)

  useEffect(() => {
    if (bulkActive && !tipDone) dismiss()
  }, [bulkActive, tipDone, dismiss])

  if (bulkActive) {
    return (
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Selection shortcuts"
            className="shrink-0 rounded p-0.5 text-text-aside hover:text-text-secondary data-[state=delayed-open]:text-text-secondary data-[state=instant-open]:text-text-secondary cursor-pointer"
          >
            <HelpCircle size={14} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" prose className="w-max min-w-48">
          <Cheatsheet />
        </TooltipContent>
      </Tooltip>
    )
  }

  if (tipDone) return null

  return (
    <span
      className={cn(
        'group/hint flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-elevated',
        META_DENSE,
      )}
    >
      <span aria-hidden="true" className="shrink-0">
        ·
      </span>
      <span className="min-w-0 truncate">
        <span className="text-text-secondary">{MOD}+click</span>
        {' or '}
        <span className="text-text-secondary">Shift+click</span>
        {' to select multiple - like File Explorer'}
      </span>
      <button
        type="button"
        title="Don't show this tip again"
        aria-label="Don't show this tip again"
        onClick={dismiss}
        className="shrink-0 rounded p-0.5 text-text-aside transition-colors hover:text-text-primary group-hover/hint:text-text-secondary cursor-pointer"
      >
        <X size={12} />
      </button>
    </span>
  )
}
