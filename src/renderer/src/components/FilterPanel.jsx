import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Search, X, ChevronDown, ChevronRight, Check } from 'lucide-react'
import { usePersistedPanelWidth } from '@/hooks/usePersistedPanelWidth'
import ResizeHandle from './ResizeHandle'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { TextAutocomplete } from './filter-panel/TextAutocomplete'
import { TagsAutocomplete } from './filter-panel/TagsAutocomplete'
import { LabelsAutocomplete } from './filter-panel/LabelsAutocomplete'
import { AuthorAutocomplete } from './filter-panel/AuthorAutocomplete'
import { SmartSearchBar } from './filter-panel/SmartSearchBar'

/** Structural equality for the value shapes a section can hold — primitives, a `Set`
 *  (type multi-select), or a polarity/id array. Only used to decide whether a section
 *  deviates from its declared default, so it stays intentionally shallow. */
function sameFilterValue(a, b) {
  if (a === b) return true
  if (a instanceof Set) {
    const other = b instanceof Set ? b : new Set(b)
    if (a.size !== other.size) return false
    for (const v of a) if (!other.has(v)) return false
    return true
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      const x = a[i]
      const y = b[i]
      if (x === y) continue
      // Polarity list entries: { value, negate }
      if (x && y && typeof x === 'object' && typeof y === 'object' && x.value === y.value && !!x.negate === !!y.negate)
        continue
      return false
    }
    return true
  }
  return false
}

/**
 * Whether a section deviates from the default the app ships with. The indicator is
 * deliberately mechanical ("differs from default"), never a judgement of how
 * "destructive" a value is — that keeps it consistent across every control.
 *
 * Opt-in by config: a section participates only if it declares a `default` (or an
 * explicit `active` boolean). Sort sections omit both, so they never light up and
 * never count toward the "N filters" tally — they reorder, they don't hide content.
 * Returns `null` for non-participating sections.
 */
export function sectionActive(section) {
  if (typeof section.active === 'boolean') return section.active
  if (!('default' in section)) return null
  if (!sameFilterValue(section.value, section.default)) return true
  // Author folds its exclude chips into the same section as the include value.
  if (Array.isArray(section.excluded) && section.excluded.length > 0) return true
  return false
}

export default function FilterPanel({
  search,
  onSearchChange,
  /** When set, the top search box becomes a sigil-aware smart bar (`@`/`#`/`%` + `-`/`!`). */
  smartSearch = null,
  sections = [],
  defaultWidth = 220,
  minWidth = 160,
  maxWidth = 340,
  /** Render the panel in place but inert (e.g. hub wishlist mode has no filters yet). */
  disabled = false,
}) {
  const activeFlags = sections.map(sectionActive)
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
        className={`flex-1 min-w-0 min-h-0 bg-surface border-r border-border flex flex-col ${disabled ? 'opacity-40 pointer-events-none select-none' : ''}`}
      >
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Search — no section title; bar hugs the edit box only (inset by padding). */}
          <div className="relative px-3 pt-3 pb-2">
            {!!search && (
              <span
                className="absolute left-0 top-3 bottom-2 w-[3px] rounded-r-full bg-accent-blue"
                title="This filter is set to a non-default value"
                aria-hidden="true"
              />
            )}
            {smartSearch ? (
              <SmartSearchBar
                value={search}
                onChange={onSearchChange}
                authors={smartSearch.authors}
                tags={smartSearch.tags}
                labels={smartSearch.labels}
                placeholder={smartSearch.placeholder}
              />
            ) : (
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
                    className="absolute right-1 top-1 text-text-tertiary hover:text-text-secondary"
                  >
                    <X size={12} />
                  </Button>
                )}
              </div>
            )}
          </div>

          {sections.map((section, i) => (
            <SectionWrapper key={section.key} section={section} active={activeFlags[i] === true}>
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
                      className="absolute right-1 top-0.5 text-text-tertiary hover:text-text-secondary"
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
      </div>
      <ResizeHandle side="right" onResizeStart={onResizeStart} onResize={onResize} />
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

function SectionWrapper({ section, active, children }) {
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
    <div className="relative px-3 pb-3">
      {active && (
        <span
          className="absolute left-0 top-0 bottom-3 w-[3px] rounded-r-full bg-accent-blue"
          title="This filter is set to a non-default value"
          aria-hidden="true"
        />
      )}
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
            className={`flex items-center gap-1 min-w-0 text-[10px] uppercase tracking-wider text-text-tertiary font-medium ${section.titleAction ? '' : 'flex-1'}`}
          >
            <span className="truncate">{section.label}</span>
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
