import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Tri-state applied marker shared by the label apply menu and popover:
 * `all` = filled check, `partial` = dashed/half, `none` = empty outline.
 */
export function LabelStateCheckbox({ state }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center w-3.5 h-3.5 rounded border shrink-0',
        state === 'all' && 'bg-accent-blue border-accent-blue',
        state === 'partial' && 'bg-accent-blue/30 border-accent-blue',
        state === 'none' && 'border-text-tertiary/60',
      )}
    >
      {state === 'all' && <Check size={9} className="text-white" strokeWidth={3} />}
      {state === 'partial' && <Minus size={9} className="text-white" strokeWidth={3} />}
    </span>
  )
}
