import { cn } from '@/lib/utils'
import { BODY, CLARIFY, BODY_DENSE, CLARIFY_DENSE } from '@/lib/typography'

/**
 * Centered empty-state copy. Roomy scale by default (full-page grids and tables).
 *
 * Pass `dense` inside side panels and sub-panels, where the surrounding surface runs at
 * 11-12px and a 14px line reads as a different app.
 *
 * Prefer a single line of body; use `clarification` only when a second tier is needed, and
 * keep interactive elements as siblings rather than nesting them in the clarification.
 *
 * `icon` renders above the title (component owns the icon-to-title gap). `overlay` emits
 * `py-0 pt-16` in that order so twMerge keeps the top padding — never hand-write that pair.
 */
export function EmptyState({ children, clarification, dense, icon, overlay, className, ...props }) {
  return (
    <div
      className={cn(
        'text-center',
        dense ? 'py-8' : 'py-16',
        overlay && 'py-0 pt-16',
        dense ? BODY_DENSE : BODY,
        className,
      )}
      {...props}
    >
      {icon != null && <div className="mb-2 flex justify-center">{icon}</div>}
      {children}
      {clarification != null && (
        <div className={cn(dense ? CLARIFY_DENSE : CLARIFY, 'mt-1', !dense && 'leading-relaxed')}>{clarification}</div>
      )}
    </div>
  )
}
