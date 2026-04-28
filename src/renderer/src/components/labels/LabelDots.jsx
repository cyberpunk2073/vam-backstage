import { cn } from '../../lib/utils'
import { isMutedLabel, labelColor } from '../../lib/labels'

/**
 * Small colored-dot cluster anchored top-left on card thumbnails, one row below
 * the type/DEP/LOCAL chip row. Self-hides when there are no labels. The fixed
 * position is intentional: across a mixed grid (some cards with top-left chips,
 * some without) the dots stay in the same place rather than jittering with a
 * conditional shift.
 *
 * Up to 4 dots when everything fits; once there are 5+ labels we drop to 3
 * dots + "+N" so the counter is always meaningful (a "+1" counter would take
 * the same width as the dot it's standing in for). Any None-color labels
 * collapse into a single muted dot at the cluster's end.
 *
 * `pointer-events-none` so clicks fall through to the card. Hover title shows
 * the full list (cheap; full Radix Tooltip is overkill on every card).
 */
const MAX_DOTS_NO_COUNTER = 4
const MAX_DOTS_WITH_COUNTER = 3

export function LabelDots({ labels, className }) {
  if (!labels?.length) return null
  const colored = []
  const muted = []
  for (const l of labels) {
    if (isMutedLabel(l)) muted.push(l)
    else colored.push(l)
  }
  const showCounter = labels.length > MAX_DOTS_NO_COUNTER
  const cap = showCounter ? MAX_DOTS_WITH_COUNTER : MAX_DOTS_NO_COUNTER
  const mutedSlot = muted.length > 0 ? 1 : 0
  const visibleColored = colored.slice(0, Math.max(0, cap - mutedSlot))
  const overflowCount = showCounter ? labels.length - visibleColored.length - mutedSlot : 0
  const title = labels.map((l) => l.name).join(', ')

  return (
    <div
      className={cn(
        'absolute top-7 left-2 inline-flex h-3.5 items-center gap-[3px] px-1 rounded-full bg-black/55 pointer-events-none',
        className,
      )}
      title={title}
      data-slot="label-dots"
    >
      {visibleColored.map((l) => (
        <span key={l.id} className="block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: labelColor(l) }} />
      ))}
      {muted.length > 0 && (
        <span className="block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: labelColor(muted[0]) }} />
      )}
      {overflowCount > 0 && (
        <span className="text-[9px] leading-none text-white/85 font-medium tabular-nums pl-px">+{overflowCount}</span>
      )}
    </div>
  )
}
