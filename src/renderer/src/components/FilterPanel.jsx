import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Search, X, ChevronDown, ChevronRight, Check, Tag, Hash, User } from 'lucide-react'
import { usePersistedPanelWidth } from '@/hooks/usePersistedPanelWidth'
import ResizeHandle from './ResizeHandle'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { LabelChip } from '@/components/labels/LabelChip'
import { LabelManageMenu } from '@/components/labels/LabelManageMenu'
import { useLabelRename } from '@/components/labels/useLabelRename'
import { labelColor } from '@/lib/labels'

export default function FilterPanel({
  search,
  onSearchChange,
  sections = [],
  defaultWidth = 220,
  minWidth = 160,
  maxWidth = 340,
  /** Render the panel in place but inert (e.g. hub wishlist mode has no filters yet). */
  disabled = false,
}) {
  const [width, setWidth] = usePersistedPanelWidth('panel_width_filters', {
    min: minWidth,
    max: maxWidth,
    defaultWidth,
  })

  const startWidthRef = useRef(width)
  const onResizeStart = useCallback(() => {
    startWidthRef.current = width
  }, [width])
  const onResize = useCallback(
    (delta) => setWidth(Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + delta))),
    [minWidth, maxWidth, setWidth],
  )

  return (
    <div className="flex shrink-0" style={{ width }} aria-hidden={disabled}>
      <div
        className={`flex-1 min-w-0 bg-surface border-r border-border flex flex-col overflow-y-auto ${disabled ? 'opacity-40 pointer-events-none select-none' : ''}`}
      >
        {/* Search */}
        <div className="p-3 pb-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary z-10" />
            <Input
              type="text"
              placeholder="Search…"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className="h-8 bg-elevated pl-8 pr-7 text-xs"
            />
            {search && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onSearchChange('')}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
              >
                <X size={12} />
              </Button>
            )}
          </div>
        </div>

        {sections.map((section) => (
          <SectionWrapper key={section.key} section={section}>
            {section.type === 'list' && <ListSection section={section} />}

            {section.type === 'tags' && (
              <div className="space-y-px">
                {section.items.map((item) => {
                  const active = section.value.size === 0 ? item.value === 'All' : section.value.has(item.value)
                  const selected = item.value !== 'All' && section.value.has(item.value)
                  const pinned = section.value.size > 1 && selected
                  return (
                    <button
                      type="button"
                      key={item.value}
                      onClick={() => section.onChange(item.value)}
                      className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-2 transition-colors cursor-pointer
                        ${active ? 'bg-hover text-text-primary' : 'text-text-secondary hover:bg-elevated hover:text-text-primary'}`}
                    >
                      {item.color ? (
                        <div className="group/dot shrink-0 relative flex items-center justify-center w-3.5 h-3.5 -m-1 p-1 box-content">
                          <div
                            className={`w-2 h-2 rounded-full transition-opacity ${pinned ? 'opacity-0' : 'group-hover/dot:opacity-0'}`}
                            style={{ background: item.color, boxShadow: active ? `0 0 4px ${item.color}60` : 'none' }}
                          />
                          <div
                            className={`absolute inset-0 m-1 rounded border transition-opacity flex items-center justify-center ${pinned ? 'opacity-100' : 'opacity-0 group-hover/dot:opacity-100'}`}
                            style={{
                              borderColor: selected
                                ? item.color
                                : 'color-mix(in srgb, ' + item.color + ' 45%, transparent)',
                              background: selected ? item.color : 'transparent',
                            }}
                            onClick={(e) => {
                              e.stopPropagation()
                              section.onToggle?.(item.value)
                            }}
                          >
                            {selected && <Check size={10} className="text-white" strokeWidth={2.5} />}
                          </div>
                        </div>
                      ) : null}
                      <span className="truncate">{item.label}</span>
                      {item.count != null && (
                        <span className="text-text-tertiary ml-auto text-[11px] shrink-0">{item.count}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {section.type === 'text' && (
              <div className="relative">
                <Input
                  type="text"
                  placeholder={section.placeholder || 'Search…'}
                  value={section.value}
                  onChange={(e) => section.onChange(e.target.value)}
                  className="h-7 bg-elevated rounded pl-2.5 pr-7 text-xs"
                />
                {section.value ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => section.onChange('')}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
                    aria-label={`Clear ${section.label}`}
                  >
                    <X size={12} />
                  </Button>
                ) : null}
              </div>
            )}

            {section.type === 'text-autocomplete' &&
              (section.onExcludedChange ? (
                <AuthorAutocomplete
                  value={section.value}
                  onChange={section.onChange}
                  excluded={section.excluded}
                  onExcludedChange={section.onExcludedChange}
                  suggestions={section.suggestions}
                  placeholder={section.placeholder}
                />
              ) : (
                <TextAutocomplete
                  value={section.value}
                  onChange={section.onChange}
                  suggestions={section.suggestions}
                  placeholder={section.placeholder}
                />
              ))}

            {section.type === 'tags-autocomplete' && (
              <TagsAutocomplete
                value={section.value}
                onChange={section.onChange}
                suggestions={section.suggestions}
                placeholder={section.placeholder}
                allowNegate={!!section.allowNegate}
              />
            )}

            {section.type === 'labels-autocomplete' && (
              <LabelsAutocomplete
                value={section.value}
                onChange={section.onChange}
                labels={section.labels}
                placeholder={section.placeholder}
                allowNegate={!!section.allowNegate}
              />
            )}

            {section.type === 'select' && (
              <Select value={String(section.value)} onValueChange={section.onChange}>
                <SelectTrigger className="w-full h-8 bg-elevated text-xs text-text-secondary">
                  <SelectValue placeholder={section.placeholder} />
                </SelectTrigger>
                <SelectContent>
                  {section.options.map((opt) => {
                    const val = typeof opt === 'string' ? opt : opt.value
                    const key = String(val)
                    if (typeof opt === 'string') {
                      return (
                        <SelectItem key={key} value={key}>
                          {opt}
                        </SelectItem>
                      )
                    }
                    const hasCount = opt.count != null
                    if (hasCount) {
                      return (
                        <SelectItem key={key} value={key} selectLabel={opt.label ?? key}>
                          <span className="text-text-tertiary text-[11px] shrink-0 ml-auto">{opt.count}</span>
                        </SelectItem>
                      )
                    }
                    const menuText = opt.menuLabel ?? opt.label ?? key
                    return (
                      <SelectItem key={key} value={key}>
                        {menuText}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            )}
          </SectionWrapper>
        ))}
      </div>
      <ResizeHandle side="right" onResizeStart={onResizeStart} onResize={onResize} />
    </div>
  )
}

/** Normalize filter chip lists: plain values → `{ value, negate: false }`. */
function toPolarityItems(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) =>
    item && typeof item === 'object' && 'value' in item
      ? { value: item.value, negate: !!item.negate }
      : { value: item, negate: false },
  )
}

function emitPolarityItems(items, allowNegate) {
  return allowNegate ? items : items.map((i) => i.value)
}

/** Strip a leading `-` / `!` for autocomplete matching; returns `{ negate, query }`. */
function stripNegationPrefix(raw) {
  const t = String(raw || '')
  if (t[0] === '-' || t[0] === '!') return { negate: true, query: t.slice(1) }
  return { negate: false, query: t }
}

/** Close the popover when a mousedown lands outside `ref`. `setOpen` is a stable useState setter. */
function useDismissOnOutside(ref, setOpen) {
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, setOpen])
}

/** setHlIndex updater that wraps around and scrolls the target row into view. */
function moveHighlight(dir, len, listRef) {
  return (i) => {
    const next = dir === 'down' ? (i < len - 1 ? i + 1 : 0) : i > 0 ? i - 1 : len - 1
    listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' })
    return next
  }
}

/**
 * Rank `{ name: count }` suggestions for a query: prefix matches first, then
 * substring matches, each ordered by count desc then name. Empty query returns
 * the full list by count. `isExcluded(name)` drops already-chosen entries.
 */
function rankSuggestions(suggestions, q, isExcluded, limit = 20) {
  const byCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  const entries = Object.entries(suggestions).filter(([name]) => !isExcluded?.(name))
  if (!q) return entries.sort(byCount).slice(0, limit)
  const prefix = []
  const rest = []
  for (const entry of entries) {
    const lower = entry[0].toLowerCase()
    if (lower.startsWith(q)) prefix.push(entry)
    else if (lower.includes(q)) rest.push(entry)
  }
  return [...prefix.sort(byCount), ...rest.sort(byCount)].slice(0, limit)
}

function PolarityTagChip({ label, negate, onToggle, onRemove }) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] leading-tight ${
        negate ? 'bg-error/15 text-error' : 'bg-accent-blue/15 text-accent-blue'
      } ${onToggle ? 'cursor-pointer' : ''}`}
      onClick={onToggle}
      title={onToggle ? (negate ? 'Click to include' : 'Click to exclude') : undefined}
    >
      {negate && <span className="font-medium leading-none">−</span>}
      <span>{label}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        className="hover:text-text-primary cursor-pointer"
      >
        <X size={10} />
      </button>
    </span>
  )
}

function TagsAutocomplete({
  value = [],
  onChange,
  suggestions = {},
  placeholder = 'Filter by tags…',
  allowNegate = false,
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [hlIndex, setHlIndex] = useState(-1)
  const containerRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const items = useMemo(() => toPolarityItems(value), [value])
  const selectedSet = useMemo(() => new Set(items.map((i) => i.value)), [items])

  useDismissOnOutside(containerRef, setOpen)

  const { negate: rawPendingNegate, query: matchQuery } = stripNegationPrefix(query)
  const pendingNegate = allowNegate && rawPendingNegate
  const commitText = allowNegate ? matchQuery : query
  const q = commitText.trim().toLowerCase()

  const matches = useMemo(
    () => rankSuggestions(suggestions, q, (tag) => selectedSet.has(tag)),
    [suggestions, selectedSet, q],
  )

  useEffect(() => {
    setHlIndex(-1)
  }, [matches])

  const addTag = (tag, negate = false) => {
    const trimmed = tag.trim()
    if (!trimmed || selectedSet.has(trimmed)) {
      setQuery('')
      inputRef.current?.focus()
      return
    }
    const next = [...items, { value: trimmed, negate: allowNegate && negate }]
    onChange(emitPolarityItems(next, allowNegate))
    setQuery('')
    inputRef.current?.focus()
  }
  const removeTag = (tag) => {
    onChange(
      emitPolarityItems(
        items.filter((t) => t.value !== tag),
        allowNegate,
      ),
    )
  }
  const toggleTag = (tag) => {
    if (!allowNegate) return
    onChange(items.map((t) => (t.value === tag ? { ...t, negate: !t.negate } : t)))
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' && open && matches.length > 0) {
      e.preventDefault()
      setHlIndex(moveHighlight('down', matches.length, listRef))
    } else if (e.key === 'ArrowUp' && open && matches.length > 0) {
      e.preventDefault()
      setHlIndex(moveHighlight('up', matches.length, listRef))
    } else if (e.key === 'Enter') {
      if (open && hlIndex >= 0 && hlIndex < matches.length) {
        e.preventDefault()
        addTag(matches[hlIndex][0], pendingNegate)
      } else if (commitText.trim()) {
        e.preventDefault()
        addTag(commitText, pendingNegate)
      }
    } else if (e.key === ',') {
      if (commitText.trim()) {
        e.preventDefault()
        addTag(commitText, pendingNegate)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {items.map((item) => (
            <PolarityTagChip
              key={item.value}
              label={item.value}
              negate={item.negate}
              onToggle={allowNegate ? () => toggleTag(item.value) : undefined}
              onRemove={() => removeTag(item.value)}
            />
          ))}
          <button
            type="button"
            onClick={() => {
              onChange([])
              setQuery('')
            }}
            className="text-[10px] text-text-tertiary hover:text-text-secondary cursor-pointer px-1"
          >
            Clear
          </button>
        </div>
      )}
      <div className="relative">
        <Hash size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary z-10" />
        <Input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-7 bg-elevated rounded pl-7 pr-7 text-xs"
        />
        {query && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              setQuery('')
              setOpen(false)
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
          >
            <X size={12} />
          </Button>
        )}
      </div>
      {open && matches.length > 0 && (
        <div
          ref={listRef}
          className="absolute z-30 left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-popover border border-border rounded shadow-lg"
        >
          {matches.map(([tag, count], i) => (
            <button
              key={tag}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => addTag(tag, pendingNegate)}
              onMouseEnter={() => setHlIndex(i)}
              className={`w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 cursor-pointer transition-colors ${i === hlIndex ? 'bg-accent-blue/10 text-text-primary' : 'hover:bg-hover'}`}
            >
              <span className="truncate flex-1">{pendingNegate ? `− ${tag}` : tag}</span>
              <span className="text-text-tertiary text-[11px] shrink-0">{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Labels filter widget — like `TagsAutocomplete` but values are label IDs and
 * each chip / row gets a leading colored dot. No "Create" affordance — labels
 * are born only by being applied (see UX plan §12). Right-click on a chip or
 * row opens the management menu (rename / recolor / delete + enable/disable
 * all packages).
 */
function LabelsAutocomplete({
  value = [],
  onChange,
  labels = [],
  placeholder = 'Filter by label…',
  allowNegate = false,
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [hlIndex, setHlIndex] = useState(-1)
  const { renamingId, renameDraft, setRenameDraft, startRename, commitRename, cancelRename } = useLabelRename()
  const containerRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const items = useMemo(() => toPolarityItems(value), [value])
  const selectedSet = useMemo(() => new Set(items.map((i) => i.value)), [items])
  const negateById = useMemo(() => new Map(items.map((i) => [i.value, i.negate])), [items])

  useDismissOnOutside(containerRef, setOpen)

  const labelMap = useMemo(() => {
    const m = new Map()
    for (const l of labels) m.set(l.id, l)
    return m
  }, [labels])

  const selected = useMemo(() => items.map((item) => labelMap.get(item.value)).filter(Boolean), [items, labelMap])

  const { negate: rawPendingNegate, query: matchQuery } = stripNegationPrefix(query)
  const pendingNegate = allowNegate && rawPendingNegate
  const q = (allowNegate ? matchQuery : query).trim().toLowerCase()

  const matches = useMemo(() => {
    const all = labels.filter((l) => !selectedSet.has(l.id))
    if (!q) return all.slice(0, 30)
    const prefix = []
    const rest = []
    for (const l of all) {
      const lower = l.name.toLowerCase()
      if (lower.startsWith(q)) prefix.push(l)
      else if (lower.includes(q)) rest.push(l)
    }
    return [...prefix, ...rest].slice(0, 30)
  }, [labels, selectedSet, q])

  useEffect(() => setHlIndex(-1), [matches])

  const addLabel = (id, negate = false) => {
    if (selectedSet.has(id)) {
      setQuery('')
      inputRef.current?.focus()
      return
    }
    const next = [...items, { value: id, negate: allowNegate && negate }]
    onChange(emitPolarityItems(next, allowNegate))
    setQuery('')
    inputRef.current?.focus()
  }
  const removeLabel = (id) =>
    onChange(
      emitPolarityItems(
        items.filter((x) => x.value !== id),
        allowNegate,
      ),
    )
  const toggleLabel = (id) => {
    if (!allowNegate) return
    onChange(items.map((x) => (x.value === id ? { ...x, negate: !x.negate } : x)))
  }

  const onKeyDown = (e) => {
    if (!open || matches.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHlIndex(moveHighlight('down', matches.length, listRef))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHlIndex(moveHighlight('up', matches.length, listRef))
    } else if (e.key === 'Enter' && hlIndex >= 0 && hlIndex < matches.length) {
      e.preventDefault()
      addLabel(matches[hlIndex].id, pendingNegate)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {selected.map((label) => (
            <LabelManageMenu
              key={label.id}
              label={label}
              applicationCount={(label.packageCount || 0) + (label.contentCount || 0)}
              onStartRename={() => startRename(label)}
              onDeleted={() => removeLabel(label.id)}
            >
              <LabelChip
                label={label}
                size="sm"
                interactive
                filled
                negated={!!negateById.get(label.id)}
                onClick={allowNegate ? () => toggleLabel(label.id) : undefined}
                onNameDoubleClick={() => startRename(label)}
                onRemove={() => removeLabel(label.id)}
                renaming={renamingId === label.id}
                editValue={renameDraft}
                onEditChange={setRenameDraft}
                onCommit={commitRename}
                onCancel={cancelRename}
              />
            </LabelManageMenu>
          ))}
          {selected.length > 1 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-[10px] text-text-tertiary hover:text-text-secondary cursor-pointer px-1"
            >
              Clear
            </button>
          )}
        </div>
      )}
      <div className="relative">
        <Tag size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary z-10" />
        <Input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-7 bg-elevated rounded pl-7 pr-7 text-xs"
        />
        {query && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              setQuery('')
              setOpen(false)
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
          >
            <X size={12} />
          </Button>
        )}
      </div>
      {open && matches.length > 0 && (
        <div
          ref={listRef}
          className="absolute z-30 left-0 right-0 mt-1 max-h-60 overflow-y-auto bg-popover border border-border rounded shadow-lg"
        >
          {matches.map((label, i) => {
            const total = (label.packageCount || 0) + (label.contentCount || 0)
            return (
              <LabelManageMenu
                key={label.id}
                label={label}
                applicationCount={total}
                onStartRename={() => startRename(label)}
              >
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => addLabel(label.id, pendingNegate)}
                  onMouseEnter={() => setHlIndex(i)}
                  className={`w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 cursor-pointer transition-colors ${i === hlIndex ? 'bg-accent-blue/10 text-text-primary' : 'hover:bg-hover'}`}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: labelColor(label) }} />
                  <span className="truncate flex-1">{pendingNegate ? `− ${label.name}` : label.name}</span>
                  {total > 0 && <span className="text-text-tertiary text-[11px] shrink-0">{total}</span>}
                </button>
              </LabelManageMenu>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Author filter: single live positive substring (chip-less) + optional exclude
 * chip blocklist. Prefixed `-`/`!` input commits an exclude and restores the
 * positive value in the box.
 */
function AuthorAutocomplete({
  value = '',
  onChange,
  excluded = [],
  onExcludedChange,
  suggestions = {},
  placeholder = 'Filter by author…',
}) {
  const [draft, setDraft] = useState(null)
  const [open, setOpen] = useState(false)
  const [hlIndex, setHlIndex] = useState(-1)
  const containerRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const excludedList = useMemo(() => (Array.isArray(excluded) ? excluded : []), [excluded])
  const excludedSet = useMemo(() => new Set(excludedList.map((a) => a.toLowerCase())), [excludedList])

  const displayValue = draft !== null ? draft : value
  const { negate: pendingNegate, query: matchQuery } = stripNegationPrefix(displayValue)
  const q = matchQuery.trim().toLowerCase()

  useDismissOnOutside(containerRef, setOpen)

  const matches = useMemo(
    () => rankSuggestions(suggestions, q, (name) => excludedSet.has(name.toLowerCase())),
    [suggestions, excludedSet, q],
  )

  useEffect(() => {
    setHlIndex(-1)
  }, [matches])

  const showList = open && matches.length > 0

  const commitExclude = (name) => {
    const trimmed = name.trim()
    if (!trimmed || excludedSet.has(trimmed.toLowerCase())) {
      setDraft(null)
      return
    }
    onExcludedChange([...excludedList, trimmed])
    setDraft(null)
    inputRef.current?.focus()
  }

  const pickSuggestion = (name) => {
    if (pendingNegate) commitExclude(name)
    else {
      onChange(name)
      setDraft(null)
    }
    setOpen(false)
  }

  const onInputChange = (raw) => {
    const { negate } = stripNegationPrefix(raw)
    if (negate) setDraft(raw)
    else {
      setDraft(null)
      onChange(raw)
    }
    setOpen(true)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' && showList) {
      e.preventDefault()
      setHlIndex(moveHighlight('down', matches.length, listRef))
    } else if (e.key === 'ArrowUp' && showList) {
      e.preventDefault()
      setHlIndex(moveHighlight('up', matches.length, listRef))
    } else if (e.key === 'Enter') {
      if (showList && hlIndex >= 0 && hlIndex < matches.length) {
        e.preventDefault()
        pickSuggestion(matches[hlIndex][0])
      } else if (pendingNegate && matchQuery.trim()) {
        e.preventDefault()
        commitExclude(matchQuery)
        setOpen(false)
      }
    } else if (e.key === ',' && pendingNegate && matchQuery.trim()) {
      e.preventDefault()
      commitExclude(matchQuery)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (draft !== null) setDraft(null)
      else setOpen(false)
    }
  }

  const promoteExclude = (name) => {
    onExcludedChange(excludedList.filter((a) => a !== name))
    onChange(name)
    setDraft(null)
  }

  return (
    <div ref={containerRef} className="relative">
      {excludedList.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {excludedList.map((name) => (
            <PolarityTagChip
              key={name}
              label={name}
              negate
              onToggle={() => promoteExclude(name)}
              onRemove={() => onExcludedChange(excludedList.filter((a) => a !== name))}
            />
          ))}
          {excludedList.length > 1 && (
            <button
              type="button"
              onClick={() => onExcludedChange([])}
              className="text-[10px] text-text-tertiary hover:text-text-secondary cursor-pointer px-1"
            >
              Clear
            </button>
          )}
        </div>
      )}
      <div className="relative">
        <User size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary z-10" />
        <Input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={displayValue}
          onChange={(e) => onInputChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-7 bg-elevated rounded pl-7 pr-7 text-xs"
        />
        {displayValue ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              if (draft !== null) setDraft(null)
              else {
                onChange('')
                setOpen(false)
              }
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
            aria-label="Clear"
          >
            <X size={12} />
          </Button>
        ) : null}
      </div>
      {showList && (
        <div
          ref={listRef}
          className="absolute z-30 left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-popover border border-border rounded shadow-lg"
        >
          {matches.map(([name, count], i) => (
            <button
              key={name}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickSuggestion(name)}
              onMouseEnter={() => setHlIndex(i)}
              className={`w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 cursor-pointer transition-colors ${i === hlIndex ? 'bg-accent-blue/10 text-text-primary' : 'hover:bg-hover'}`}
            >
              <span className="truncate flex-1">{pendingNegate ? `− ${name}` : name}</span>
              <span className="text-text-tertiary text-[11px] shrink-0">{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Single-line filter with Hub `users`-style suggestions: substring match, ordered by occurrence count */
function TextAutocomplete({ value = '', onChange, suggestions = {}, placeholder = 'Search…' }) {
  const [open, setOpen] = useState(false)
  const [hlIndex, setHlIndex] = useState(-1)
  const containerRef = useRef(null)
  const listRef = useRef(null)

  useDismissOnOutside(containerRef, setOpen)

  const q = value.trim().toLowerCase()
  const matches = useMemo(() => rankSuggestions(suggestions, q), [suggestions, q])

  useEffect(() => {
    setHlIndex(-1)
  }, [matches])

  const showList = open && matches.length > 0

  const onKeyDown = (e) => {
    if (!showList) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHlIndex(moveHighlight('down', matches.length, listRef))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHlIndex(moveHighlight('up', matches.length, listRef))
    } else if (e.key === 'Enter' && hlIndex >= 0 && hlIndex < matches.length) {
      e.preventDefault()
      onChange(matches[hlIndex][0])
      setOpen(false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <User size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary z-10" />
        <Input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-7 bg-elevated rounded pl-7 pr-7 text-xs"
        />
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              onChange('')
              setOpen(false)
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
            aria-label="Clear"
          >
            <X size={12} />
          </Button>
        ) : null}
      </div>
      {showList && (
        <div
          ref={listRef}
          className="absolute z-30 left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-popover border border-border rounded shadow-lg"
        >
          {matches.map(([name, count], i) => (
            <button
              key={name}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(name)
                setOpen(false)
              }}
              onMouseEnter={() => setHlIndex(i)}
              className={`w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 cursor-pointer transition-colors ${i === hlIndex ? 'bg-accent-blue/10 text-text-primary' : 'hover:bg-hover'}`}
            >
              <span className="truncate flex-1">{name}</span>
              <span className="text-text-tertiary text-[11px] shrink-0">{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const collapsedListeners = new Set()
function emitCollapsedChange() {
  for (const fn of collapsedListeners) fn()
}
function usePersistedCollapsed(key, defaultValue = false) {
  const lsKey = `filter-collapsed:${key}`
  const value = useSyncExternalStore(
    (cb) => {
      collapsedListeners.add(cb)
      return () => collapsedListeners.delete(cb)
    },
    () => {
      const v = localStorage.getItem(lsKey)
      return v === null ? defaultValue : v === '1'
    },
  )
  const toggle = useCallback(() => {
    localStorage.setItem(lsKey, value ? '0' : '1')
    emitCollapsedChange()
  }, [lsKey, value])
  return [value, toggle]
}

function SectionWrapper({ section, children }) {
  const [collapsed, toggleCollapsed] = usePersistedCollapsed(section.key, section.collapsedByDefault ?? false)
  const isCollapsible = !!section.collapsible

  const onCollapsedChangeRef = useRef(section.onCollapsedChange)
  onCollapsedChangeRef.current = section.onCollapsedChange
  const prevCollapsedRef = useRef(collapsed)
  useEffect(() => {
    const wasCollapsed = prevCollapsedRef.current
    prevCollapsedRef.current = collapsed
    if (!isCollapsible || !collapsed || wasCollapsed) return
    onCollapsedChangeRef.current?.()
  }, [collapsed, isCollapsible])

  return (
    <div className="px-3 pb-3">
      <div className="flex items-center gap-1 mb-1.5">
        {isCollapsible ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            className={`flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-tertiary font-medium cursor-pointer hover:text-text-secondary transition-colors min-w-0 ${section.titleAction ? '' : 'flex-1'}`}
          >
            {collapsed ? (
              <ChevronRight size={11} className="shrink-0" />
            ) : (
              <ChevronDown size={11} className="shrink-0" />
            )}
            <span className="truncate">{section.label}</span>
          </button>
        ) : (
          <div
            className={`min-w-0 text-[10px] uppercase tracking-wider text-text-tertiary font-medium ${section.titleAction ? '' : 'flex-1'}`}
          >
            {section.label}
          </div>
        )}
        {section.titleAction}
      </div>
      {(!isCollapsible || !collapsed) && children}
    </div>
  )
}

const LIST_COLLAPSE_THRESHOLD = 6

function ListSection({ section }) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = section.listCollapsible !== false && section.items.length > LIST_COLLAPSE_THRESHOLD
  const visible = collapsible && !expanded ? section.items.slice(0, LIST_COLLAPSE_THRESHOLD) : section.items
  const hasActiveHidden =
    collapsible && !expanded && section.items.slice(LIST_COLLAPSE_THRESHOLD).some((i) => i.value === section.value)

  return (
    <div className="space-y-px">
      {visible.map((item) => (
        <button
          type="button"
          key={item.value}
          title={item.title}
          onClick={() => section.onChange(item.value)}
          style={item.level ? { paddingLeft: `${8 + item.level * 16}px` } : undefined}
          className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-2 transition-colors cursor-pointer
            ${section.value === item.value ? 'bg-hover text-text-primary' : 'text-text-secondary hover:bg-elevated hover:text-text-primary'}`}
        >
          {item.color && <div className="w-2 h-2 rounded-full shrink-0" style={{ background: item.color }} />}
          {item.icon && <item.icon size={12} className={item.iconClass || ''} />}
          <span className="truncate">{item.label}</span>
          {item.count != null && <span className="text-text-tertiary ml-auto text-[11px] shrink-0">{item.count}</span>}
        </button>
      ))}
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="w-full text-left px-2 py-1 rounded text-[11px] flex items-center gap-1.5 text-text-tertiary hover:text-text-secondary hover:bg-elevated transition-colors cursor-pointer"
        >
          <ChevronDown size={11} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
          {expanded
            ? 'Show less'
            : `${section.items.length - LIST_COLLAPSE_THRESHOLD} more${hasActiveHidden ? ' (active)' : ''}`}
        </button>
      )}
    </div>
  )
}
