import { forwardRef, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { isMutedLabel, labelColor } from '../../lib/labels'

/**
 * Visual primitive for a label as it appears on detail panels, in popovers,
 * and in apply widgets. Right-click handling lives in the consumer (wrap in
 * `<LabelManageMenu>`).
 *
 * Three visual modes — all borderless, matching the app-wide flat-tint chip
 * idiom (see `THUMB_OVERLAY_CHIP`: type tags, DEP/LOCAL, Hub tags):
 *  - default: gray pill with a leading colored dot (used on dense card rows)
 *  - `filled`: pill tinted with the label color, no dot (used on detail panels
 *    and the filters sidebar where the color *is* the primary identity).
 *  - `outline`: lighter tint + dimmer text, no dot (used for "inherited from
 *    package" chips on the content detail panel — same family as `filled`,
 *    dimmer voice so the primary chips on the same row stay dominant).
 *
 * Renaming mode: pass `renaming` + `editValue` + `onEditChange` + `onCommit` +
 * `onCancel` to swap the name span for an inline input.
 * Optional `onNameDoubleClick` on the name text (e.g. start inline rename in a
 * detail panel).
 */
export const LabelChip = forwardRef(function LabelChip(
  {
    label,
    onClick,
    onRemove,
    active,
    interactive,
    size = 'default',
    filled = false,
    outline = false,
    className,
    renaming = false,
    editValue = '',
    onEditChange,
    onCommit,
    onCancel,
    onNameDoubleClick,
    error,
    ...rest
  },
  ref,
) {
  const inputRef = useRef(null)
  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [renaming])

  if (!label) return null
  const color = labelColor(label)
  const muted = isMutedLabel(label)
  const isSm = size === 'sm'
  const dotPx = isSm ? 'w-1.5 h-1.5' : 'w-2 h-2'
  // Filled / outline chips drop the dot and project the label color directly.
  // Muted ("None") labels keep the gray pill in all modes — there's no color
  // to project, and the existing muted treatment already reads correctly.
  const useFilled = filled && !outline && !muted
  const useOutline = outline && !muted
  // Hex + 2-digit alpha (RRGGBBAA) is universally supported and survives slot/
  // prop merges that sometimes drop CSS `color-mix()` declarations.
  const colorStyle = useFilled
    ? { backgroundColor: `${color}33`, color }
    : useOutline
      ? { backgroundColor: `${color}1a`, color: `${color}b3` }
      : undefined

  // The outer span is the asChild trigger target — Radix's Slot clones it and
  // appears to drop inline `style` during prop merge. The visible chip lives in
  // an inner span instead so its color/border survives.
  return (
    <span
      ref={ref}
      className={cn('inline-flex max-w-full', className)}
      onClick={renaming ? undefined : onClick}
      {...rest}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded leading-tight max-w-full select-none box-border',
          // Pin to a fixed pixel height so adjacent affordances (the `+` add
          // button, etc.) can match without depending on inherited line-height.
          isSm ? 'h-[18px] px-1.5 text-[10px]' : 'h-5 px-2 text-[11px]',
          !useFilled &&
            !useOutline &&
            (active ? 'bg-accent-blue/15 text-text-primary' : 'bg-elevated text-text-secondary'),
          interactive &&
            !renaming &&
            !useFilled &&
            !useOutline &&
            'cursor-pointer hover:bg-hover hover:text-text-primary',
          interactive && !renaming && (useFilled || useOutline) && 'cursor-pointer',
          muted && !active && !useFilled && !useOutline && 'opacity-80',
          error && 'ring-1 ring-error/60',
        )}
        style={colorStyle}
      >
        {!useFilled && !useOutline && (
          <span
            className={cn(dotPx, 'rounded-full shrink-0')}
            style={{ backgroundColor: color, boxShadow: active ? `0 0 4px ${color}80` : undefined }}
          />
        )}
        {renaming ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => onEditChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onCommit?.()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCancel?.()
              }
              e.stopPropagation()
            }}
            onBlur={() => onCommit?.()}
            onClick={(e) => e.stopPropagation()}
            className="bg-transparent outline-none border-0 p-0 m-0 max-w-full min-w-[2ch] text-text-primary field-sizing-content"
          />
        ) : (
          <span
            className="min-w-0 truncate"
            onDoubleClick={
              onNameDoubleClick
                ? (e) => {
                    e.stopPropagation()
                    onNameDoubleClick()
                  }
                : undefined
            }
          >
            {label.name}
          </span>
        )}
        {onRemove && (
          <button
            type="button"
            tabIndex={renaming ? -1 : undefined}
            aria-hidden={renaming}
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            className={cn(
              'shrink-0 cursor-pointer -mr-0.5 relative top-[0.5px]',
              renaming && 'invisible pointer-events-none',
              useFilled || useOutline
                ? 'text-current opacity-70 hover:opacity-100'
                : 'text-text-tertiary hover:text-text-primary',
            )}
            aria-label={`Remove ${label.name}`}
          >
            <X size={isSm ? 9 : 10} />
          </button>
        )}
      </span>
    </span>
  )
})
