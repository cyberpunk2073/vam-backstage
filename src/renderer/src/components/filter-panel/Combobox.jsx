import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/** Left-icon input with a clear button; the clear button shows only when `value` is set. */
export function ComboboxField({
  icon: Icon,
  inputRef,
  value,
  onChange,
  onFocus,
  onKeyDown,
  placeholder,
  onClear,
  clearLabel,
}) {
  return (
    <div className="relative">
      <Icon size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary z-10" />
      <Input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        className="h-7 bg-elevated rounded pl-7 pr-7 text-xs"
      />
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onClear}
          className="absolute right-1 top-0.5 text-text-tertiary hover:text-text-secondary"
          aria-label={clearLabel}
        >
          <X size={12} />
        </Button>
      ) : null}
    </div>
  )
}

/** Absolutely-positioned suggestion popup. `listRef` must reach the scroll container. */
export function ComboboxPopup({ listRef, maxHeight = 'max-h-48', children }) {
  return (
    <div
      ref={listRef}
      className={`absolute z-30 left-0 right-0 mt-1 ${maxHeight} overflow-y-auto bg-popover border border-border rounded shadow-lg`}
    >
      {children}
    </div>
  )
}

/**
 * One highlightable suggestion row. `active` drives the highlight styling.
 * `disabled` renders the row dimmed and inert while keeping it visible (and
 * keeps input focus via the mousedown guard). `title` sets a native tooltip.
 */
export function ComboboxRow({ active, disabled = false, negate = false, title, onSelect, onHover, children }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={disabled ? undefined : onSelect}
      onMouseEnter={disabled ? undefined : onHover}
      className={`w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 transition-colors ${
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : `cursor-pointer ${
              active
                ? negate
                  ? 'bg-error/10 text-text-primary'
                  : 'bg-accent-blue/10 text-text-primary'
                : 'hover:bg-hover'
            }`
      }`}
    >
      {children}
    </button>
  )
}

/** Suggestion label with a fixed-width red minus when excluding (matches chip / legend styling). */
export function ComboboxLabel({ negate, children }) {
  return (
    <span className="flex-1 min-w-0 flex items-center gap-0.5">
      {negate ? (
        <span className="shrink-0 w-2.5 text-center text-error font-medium leading-none" aria-hidden>
          −
        </span>
      ) : null}
      <span className="truncate min-w-0">{children}</span>
    </span>
  )
}

/** Wrap-around chip strip with a trailing "Clear" button. */
export function ChipRow({ onClear, showClear = true, children }) {
  return (
    <div className="flex flex-wrap gap-1 mb-1.5">
      {children}
      {showClear && (
        <button
          type="button"
          onClick={onClear}
          className="text-[10px] text-text-tertiary hover:text-text-secondary cursor-pointer px-1"
        >
          Clear
        </button>
      )}
    </div>
  )
}
