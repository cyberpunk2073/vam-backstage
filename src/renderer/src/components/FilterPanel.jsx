import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Search, X, ChevronDown, ChevronRight, Check, Tag } from 'lucide-react'
import { usePersistedPanelWidth } from '../hooks/usePersistedPanelWidth'
import ResizeHandle from './ResizeHandle'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Button } from './ui/button'

export default function FilterPanel({
  search,
  onSearchChange,
  sections = [],
  defaultWidth = 220,
  minWidth = 160,
  maxWidth = 340,
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
    <div className="flex shrink-0" style={{ width }}>
      <div className="flex-1 min-w-0 bg-surface border-r border-border flex flex-col overflow-y-auto">
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

            {section.type === 'text-autocomplete' && (
              <TextAutocomplete
                value={section.value}
                onChange={section.onChange}
                suggestions={section.suggestions}
                placeholder={section.placeholder}
              />
            )}

            {section.type === 'tags-autocomplete' && (
              <TagsAutocomplete
                value={section.value}
                onChange={section.onChange}
                suggestions={section.suggestions}
                placeholder={section.placeholder}
              />
            )}

            {section.type === 'select' && (
              <Select value={section.value} onValueChange={section.onChange}>
                <SelectTrigger className="w-full h-8 bg-elevated text-xs text-text-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {section.options.map((opt) => {
                    const val = typeof opt === 'string' ? opt : opt.value
                    const label = typeof opt === 'string' ? opt : opt.label
                    return (
                      <SelectItem key={val} value={val}>
                        {label}
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

function TagsAutocomplete({ value = [], onChange, suggestions = {}, placeholder = 'Filter by tags…' }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [hlIndex, setHlIndex] = useState(-1)
  const containerRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const matches = useMemo(() => {
    const selectedSet = new Set(value)
    const q = query.trim().toLowerCase()
    if (!q) {
      return Object.entries(suggestions)
        .filter(([tag]) => !selectedSet.has(tag))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 20)
    }
    const prefix = [],
      rest = []
    for (const entry of Object.entries(suggestions)) {
      if (selectedSet.has(entry[0])) continue
      const lower = entry[0].toLowerCase()
      if (lower.startsWith(q)) prefix.push(entry)
      else if (lower.includes(q)) rest.push(entry)
    }
    const byCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    return [...prefix.sort(byCount), ...rest.sort(byCount)].slice(0, 20)
  }, [suggestions, value, query])

  useEffect(() => {
    setHlIndex(-1)
  }, [matches])

  const addTag = (tag) => {
    onChange([...value, tag])
    setQuery('')
    inputRef.current?.focus()
  }
  const removeTag = (tag) => {
    onChange(value.filter((t) => t !== tag))
  }

  const onKeyDown = (e) => {
    if (!open || matches.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHlIndex((i) => {
        const next = i < matches.length - 1 ? i + 1 : 0
        listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' })
        return next
      })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHlIndex((i) => {
        const next = i > 0 ? i - 1 : matches.length - 1
        listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' })
        return next
      })
    } else if (e.key === 'Enter' && hlIndex >= 0 && hlIndex < matches.length) {
      e.preventDefault()
      addTag(matches[hlIndex][0])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-accent-blue/15 text-accent-blue text-[10px] leading-tight"
            >
              {tag}
              <button type="button" onClick={() => removeTag(tag)} className="hover:text-text-primary cursor-pointer">
                <X size={10} />
              </button>
            </span>
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
          className="absolute z-30 left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-popover border border-border rounded shadow-lg"
        >
          {matches.map(([tag, count], i) => (
            <button
              key={tag}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => addTag(tag)}
              onMouseEnter={() => setHlIndex(i)}
              className={`w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 cursor-pointer transition-colors ${i === hlIndex ? 'bg-accent-blue/10 text-text-primary' : 'hover:bg-hover'}`}
            >
              <span className="truncate flex-1">{tag}</span>
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

  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q) {
      return Object.entries(suggestions)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 20)
    }
    const prefix = [],
      rest = []
    for (const entry of Object.entries(suggestions)) {
      const lower = entry[0].toLowerCase()
      if (lower.startsWith(q)) prefix.push(entry)
      else if (lower.includes(q)) rest.push(entry)
    }
    const byCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    return [...prefix.sort(byCount), ...rest.sort(byCount)].slice(0, 20)
  }, [suggestions, value])

  useEffect(() => {
    setHlIndex(-1)
  }, [matches])

  const showList = open && matches.length > 0

  const onKeyDown = (e) => {
    if (!showList) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHlIndex((i) => {
        const next = i < matches.length - 1 ? i + 1 : 0
        listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' })
        return next
      })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHlIndex((i) => {
        const next = i > 0 ? i - 1 : matches.length - 1
        listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' })
        return next
      })
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
        className="h-7 bg-elevated rounded pl-2.5 pr-7 text-xs"
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
      {isCollapsible ? (
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-tertiary font-medium mb-1.5 cursor-pointer hover:text-text-secondary transition-colors w-full"
        >
          {collapsed ? <ChevronRight size={11} className="shrink-0" /> : <ChevronDown size={11} className="shrink-0" />}
          {section.label}
        </button>
      ) : (
        <div className="text-[10px] uppercase tracking-wider text-text-tertiary font-medium mb-1.5">
          {section.label}
        </div>
      )}
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
