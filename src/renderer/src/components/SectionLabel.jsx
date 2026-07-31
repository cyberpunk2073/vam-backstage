import { cn } from '@/lib/utils'
import { SECTION_LABEL } from '@/lib/typography'

/**
 * Uppercase group / section chrome label. Not prose — tertiary is correct here.
 * Typical gap over its items: `mb-1` (Downloads, content categories). FilterPanel keeps
 * `mb-1.5` as its own denser rhythm — do not unify without a visual review.
 */
export function SectionLabel({ children, as: Comp = 'span', className, ...props }) {
  return (
    <Comp className={cn(SECTION_LABEL, className)} {...props}>
      {children}
    </Comp>
  )
}
