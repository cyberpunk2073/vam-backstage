import { cn } from '../../lib/utils'

/**
 * Consistent-size tag / badge / chip.
 *
 * Every variant renders a 1px border (filled uses border-transparent) so
 * tags are always the same dimensions whether or not a visible border is
 * shown.  Padding is reduced by 1px on each axis to compensate.
 *
 * Variants:
 *   filled   – transparent border, opaque/tinted background  (default)
 *   outlined – visible border + lighter fill
 */
export function Tag({ children, className, variant = 'filled', style, ...props }) {
  return (
    <span
      className={cn(
        'uppercase px-[calc(0.375rem-1px)] py-[calc(0.125rem-1px)] rounded border leading-tight inline-block whitespace-nowrap',
        variant === 'filled' && 'border-transparent',
        className,
      )}
      style={style}
      {...props}
    >
      {children}
    </span>
  )
}
