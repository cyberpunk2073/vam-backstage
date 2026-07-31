import { cn } from '@/lib/utils'
import { TITLE_GROUP } from '@/lib/typography'

/**
 * Heading for a group of content inside a detail side-panel, optionally with a count.
 *
 * The count is deliberately quieter than the name — it is a fact about the group, not part
 * of its title. Pass `count` rather than writing the parenthetical inline so the two never
 * drift apart across panels.
 *
 * Margin-free by design: block use gets `mb-2` at the call site (heading over its content);
 * when the heading sits inline in a flex row, the row owns the margin.
 */
export function GroupHeading({ children, count, as: Comp = 'div', className, ...props }) {
  return (
    <Comp className={cn(TITLE_GROUP, className)} {...props}>
      {children}
      {count != null && <span className="text-text-tertiary font-normal"> ({count})</span>}
    </Comp>
  )
}
