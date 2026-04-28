import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, Minus, Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '../../lib/utils'
import { labelColor } from '../../lib/labels'

/**
 * Combobox for applying labels with search + optional inline create. Two modes:
 * - **Bulk** (`stateById` + `onToggle`): tri-state checkboxes; stays open for multi-toggle.
 * - **Add** (`appliedIds` + `onApply`): only unapplied labels; closes after pick or create.
 */
export function LabelApplyPopover({
  labels,
  stateById,
  appliedIds,
  onToggle,
  onApply,
  onCreate,
  children,
  align = 'end',
  contentClassName,
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeValue, setActiveValue] = useState('')
  const inputRef = useRef(null)

  const isBulk = stateById != null && typeof onToggle === 'function'

  const sorted = useMemo(
    () => [...labels].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [labels],
  )

  const visibleLabels = useMemo(() => {
    if (isBulk) return sorted
    const applied = new Set(appliedIds || [])
    return sorted.filter((l) => !applied.has(l.id))
  }, [sorted, appliedIds, isBulk])

  const trimmed = search.trim()
  const q = trimmed.toLowerCase()
  const exact = labels.find((l) => l.name.toLowerCase() === trimmed.toLowerCase())
  const showCreate = !!trimmed && !exact

  /** Manual filter so list order is stable; cmdk's default sort would bury the create row. */
  const filteredLabels = useMemo(() => {
    if (!q) return visibleLabels
    const prefix = []
    const rest = []
    for (const l of visibleLabels) {
      const lower = l.name.toLowerCase()
      if (lower.startsWith(q)) prefix.push(l)
      else if (lower.includes(q)) rest.push(l)
    }
    return [...prefix, ...rest]
  }, [visibleLabels, q])

  const createItemValue = showCreate ? `__create__:${trimmed}` : ''

  const emptyMessage = useMemo(() => {
    if (labels.length === 0) return 'No labels yet — type to create'
    if (!isBulk && visibleLabels.length === 0 && !trimmed) return 'All labels applied'
    return 'No matches'
  }, [labels.length, isBulk, visibleLabels.length, trimmed])

  const handleOpenChange = (next) => {
    setOpen(next)
    if (!next) setSearch('')
  }

  /** Default highlight when opening or when the query changes (not when only arrow keys move). */
  useLayoutEffect(() => {
    if (!open) return
    if (showCreate) setActiveValue(createItemValue)
    else if (filteredLabels.length > 0) setActiveValue(filteredLabels[0].name)
    else setActiveValue('')
  }, [open, search, showCreate, trimmed, createItemValue, filteredLabels])

  const handleItem = (l) => {
    if (isBulk) {
      const state = stateById.get(l.id) || 'none'
      onToggle(l, state)
      // Keep search across toggles so users can keep filtering and pick more.
      return
    }
    onApply?.(l)
    setOpen(false)
    setSearch('')
  }

  const handleCreate = () => {
    onCreate?.(trimmed)
    setSearch('')
    if (!isBulk) setOpen(false)
  }

  const listIsEmpty = !showCreate && filteredLabels.length === 0

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        className={cn('p-0 w-56', contentClassName)}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          queueMicrotask(() => inputRef.current?.focus())
        }}
      >
        <Command label="Labels" shouldFilter={false} loop value={activeValue} onValueChange={setActiveValue}>
          <CommandInput ref={inputRef} placeholder="Search or create…" value={search} onValueChange={setSearch} />
          <CommandList>
            {listIsEmpty ? (
              <div className="py-2 px-2 text-center text-[11px] text-text-tertiary">{emptyMessage}</div>
            ) : (
              <>
                {showCreate && (
                  <CommandItem value={createItemValue} onSelect={() => handleCreate()}>
                    <Plus size={12} className="shrink-0 text-accent-blue" />
                    <span className="truncate text-text-primary">
                      Create &ldquo;<span className="font-medium">{trimmed}</span>&rdquo;
                    </span>
                  </CommandItem>
                )}
                {filteredLabels.map((l) => {
                  const state = isBulk ? stateById.get(l.id) || 'none' : null
                  return (
                    <CommandItem key={l.id} value={l.name} onSelect={() => handleItem(l)}>
                      {isBulk && (
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
                      )}
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: labelColor(l) }} />
                      <span className="truncate flex-1 text-text-primary">{l.name}</span>
                    </CommandItem>
                  )
                })}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
