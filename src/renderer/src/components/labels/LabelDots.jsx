import { cn } from '../../lib/utils'
import { isMutedLabel, labelColor } from '../../lib/labels'
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip'

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
 * Hover tooltip lists every label, one per line, with its own colored dot,
 * under a "Labels" header. Content cards may pass `inheritedLabels` (from
 * the parent package); those appear under a separate "From package" header
 * with slightly muted text so users can see the full effective set without
 * leaving the card. The cluster itself only renders dots for the card's
 * *own* labels — inherited ones live visibly on the package card.
 *
 * Tooltip prefers the bottom side so it doesn't cover the card title; Radix
 * auto-flips it above when there isn't room (e.g. last row of the grid).
 *
 * The trigger keeps default pointer-events so Radix can hear hover; clicks
 * bubble up to the card so selection still works.
 */
const MAX_DOTS_NO_COUNTER = 4
const MAX_DOTS_WITH_COUNTER = 3

function LabelRow({ label, muted }) {
  return (
    <div className={cn('flex items-center gap-2 leading-tight', muted && 'text-popover-foreground/65')}>
      <span className="block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: labelColor(label) }} />
      <span className="truncate">{label.name}</span>
    </div>
  )
}

export function LabelDots({ labels, inheritedLabels, className }) {
  if (!labels?.length) return null
  const ownIds = new Set(labels.map((l) => l.id))
  const extraInherited = (inheritedLabels || []).filter((l) => !ownIds.has(l.id))
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

  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'absolute top-7 left-2 inline-flex h-3.5 items-center gap-[3px] px-1 rounded-full bg-black/55',
            className,
          )}
          data-slot="label-dots"
        >
          {visibleColored.map((l) => (
            <span key={l.id} className="block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: labelColor(l) }} />
          ))}
          {muted.length > 0 && (
            <span className="block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: labelColor(muted[0]) }} />
          )}
          {overflowCount > 0 && (
            <span className="text-[9px] leading-none text-white/85 font-medium tabular-nums pl-px">
              +{overflowCount}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex flex-col gap-1 items-start py-2 max-w-xs">
        <div className="text-xs font-semibold">Labels</div>
        {labels.map((l) => (
          <LabelRow key={l.id} label={l} />
        ))}
        {extraInherited.length > 0 && (
          <>
            <div className="text-xs font-semibold mt-1.5 text-popover-foreground/65">From package</div>
            {extraInherited.map((l) => (
              <LabelRow key={l.id} label={l} muted />
            ))}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
