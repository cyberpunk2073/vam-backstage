import { cn } from '@/lib/utils'
import { LABEL, CLARIFY_DENSE } from '@/lib/typography'

/**
 * Settings row: dense label + clarification description, optional trailing control.
 *
 * Description uses the clarify tier (11px secondary) so it steps down in size from the
 * 12px label — same color family, clearer hierarchy than a shared-size pair.
 *
 * Stack rows in a `space-y-5` container. At tighter gaps the next row's label crowds the
 * previous description and the list reads as one flat block rather than discrete settings.
 *
 * Use `as="label"` when wrapping a Switch or similar so the whole row is clickable.
 * Pass leading icons via `icon`. Description accepts React nodes for inline emphasis.
 * Override alignment with `className="items-start"` when the control is taller than one line.
 */
export function SettingRow({
  label,
  description,
  icon,
  children,
  as: Comp = 'div',
  className,
  labelClassName,
  descriptionClassName,
  ...props
}) {
  return (
    <Comp className={cn('flex items-start gap-3', Comp === 'label' && 'cursor-pointer', className)} {...props}>
      <div className="flex-1 min-w-0">
        <div className={cn(LABEL, icon != null && 'flex items-center gap-1.5', labelClassName)}>
          {icon}
          {label}
        </div>
        {description != null && description !== false && (
          <div className={cn(CLARIFY_DENSE, 'mt-0.5', descriptionClassName)}>{description}</div>
        )}
      </div>
      {children != null && <div className="shrink-0 mt-0.5">{children}</div>}
    </Comp>
  )
}
