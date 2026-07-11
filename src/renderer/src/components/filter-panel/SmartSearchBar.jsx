import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { labelColor } from '@/lib/labels'
import { highlightSegments, parseSmartQuery, spliceToken, tokenAtCaret } from '@/lib/smart-search'
import { rankSuggestions } from './chip-utils'
import { useCombobox } from './useCombobox'
import { ComboboxLabel, ComboboxPopup, ComboboxRow } from './Combobox'

const FIELD_CLASS = {
  author: 'text-accent-blue',
  tag: 'text-accent-purple',
  label: 'text-accent-pink',
}
const NEGATE_CLASS = 'text-error'

// Negation first, then field sigils. `field: null` → negation (red).
// Colors mirror the in-field highlight.
const SYNTAX_LEGEND = [
  { sigil: '−', label: 'exclude', field: null },
  { sigil: '@', label: 'author', field: 'author' },
  { sigil: '#', label: 'tag', field: 'tag' },
  { sigil: '%', label: 'label', field: 'label' },
]

function segmentClass(seg) {
  if (seg.kind === 'space') return ''
  const bold = seg.kind === 'negate' || seg.kind === 'sigil'
  const color = seg.negate || seg.kind === 'negate' ? NEGATE_CLASS : FIELD_CLASS[seg.field] || ''
  return bold ? `${color} font-medium` : color
}

// One realistic query that shows a positive sigil, free text, and a negated
// sigil combined — the tip renders it highlighted instead of listing every rule.
const EXAMPLE_SEGMENTS = highlightSegments('@MacGruber hair -#nude')

/**
 * Bar tokens are whitespace-delimited with no quotes, so multi-word values
 * aren't reachable. We still show them (dimmed + unselectable) rather than
 * hiding them, so the user isn't confused about missing suggestions.
 */
function isSingleToken(name) {
  return !!name && !/\s/.test(name)
}
const MULTIWORD_HINT = 'Multi-word values can’t be used in the search bar'

function rankLabelSuggestions(labels, q, limit = 20) {
  const all = labels || []
  if (!q) return all.slice(0, limit)
  const prefix = []
  const rest = []
  for (const l of all) {
    const lower = (l.name || '').toLowerCase()
    if (lower.startsWith(q)) prefix.push(l)
    else if (lower.includes(q)) rest.push(l)
  }
  return [...prefix, ...rest].slice(0, limit)
}

/**
 * Top-of-panel smart search: plain text + `@`/`#`/`%` field sigils + `-`/`!`
 * negation. Token-under-caret autocomplete and a progressive syntax tip share
 * the full-width slot below the input.
 */
export function SmartSearchBar({
  value = '',
  onChange,
  authors = {},
  tags = {},
  labels = [],
  placeholder = 'Search…',
}) {
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const backdropRef = useRef(null)

  const segments = useMemo(() => highlightSegments(value), [value])
  const active = useMemo(() => tokenAtCaret(value, caret), [value, caret])
  const completing = !!(active?.completable && (active.field !== 'label' || (labels && labels.length > 0)))
  const { hasSyntax } = useMemo(() => parseSmartQuery(value), [value])
  const legend = useMemo(
    () => (labels?.length ? SYNTAX_LEGEND : SYNTAX_LEGEND.filter((x) => x.sigil !== '%')),
    [labels],
  )

  const matches = useMemo(() => {
    if (!completing) return []
    const q = active.query
    if (active.field === 'label') {
      return rankLabelSuggestions(labels, q).map((l) => ({
        key: l.id,
        label: l.name,
        count: (l.packageCount || 0) + (l.contentCount || 0),
        color: labelColor(l),
        disabled: !isSingleToken(l.name),
      }))
    }
    const source = active.field === 'author' ? authors : tags
    return rankSuggestions(source, q).map(([name, count]) => ({
      key: name,
      label: name,
      count,
      disabled: !isSingleToken(name),
    }))
  }, [completing, active, authors, tags, labels])

  const pick = (name) => {
    if (!active) return
    const next = spliceToken(value, active, name)
    onChange(next)
    const newCaret = active.start + active.prefix.length + name.length + 1
    requestAnimationFrame(() => {
      const el = combobox.inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(newCaret, newCaret)
      setCaret(newCaret)
    })
    combobox.setOpen(false)
  }

  const combobox = useCombobox({
    matches,
    onSelect: (m) => {
      if (!m.disabled) pick(m.label)
    },
    isSelectable: (m) => !m.disabled,
  })

  // No dedicated help button. Two tiers while the field is active:
  //  • discovery — a single muted sigil line on an empty box, so casual users
  //    aren't hit with the full syntax block just for clicking Search.
  //  • reference — the dimmed example + legend once the query has syntax, i.e.
  //    the user has opted in and density is welcome.
  const showReference = !completing && combobox.open && hasSyntax
  const showDiscovery = !completing && combobox.open && !value

  const syncCaret = (el) => {
    if (el) setCaret(el.selectionStart ?? 0)
  }

  // Keep the colored backdrop aligned with the editor's horizontal/vertical scroll.
  const syncScroll = () => {
    const el = combobox.inputRef.current
    if (el && backdropRef.current) {
      backdropRef.current.scrollLeft = el.scrollLeft
      backdropRef.current.scrollTop = el.scrollTop
    }
  }
  useEffect(() => {
    const id = requestAnimationFrame(syncScroll)
    return () => cancelAnimationFrame(id)
  })

  return (
    <div ref={combobox.containerRef} className="relative">
      <div className="relative">
        {/* Colored syntax layer behind the transparent-text input. */}
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 overflow-hidden rounded-md border border-transparent bg-elevated py-1.75 pl-2.5 pr-6 text-xs leading-4 text-text-primary ${
            focused ? 'whitespace-pre-wrap wrap-break-word' : 'whitespace-pre'
          }`}
        >
          <span className={focused ? '' : 'block overflow-hidden text-ellipsis whitespace-pre'}>
            {segments.map((seg, i) => (
              <span key={i} className={segmentClass(seg)}>
                {seg.text}
              </span>
            ))}
          </span>
        </div>
        <textarea
          ref={combobox.inputRef}
          rows={1}
          wrap={focused ? 'soft' : 'off'}
          placeholder={placeholder}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
          value={value}
          style={{ caretColor: 'var(--color-text-primary)' }}
          onChange={(e) => {
            const raw = e.target.value
            const rawCaret = e.target.selectionStart ?? raw.length
            const next = raw.replace(/[\r\n]+/g, ' ')
            const nextCaret = raw.slice(0, rawCaret).replace(/[\r\n]+/g, ' ').length
            onChange(next)
            setCaret(nextCaret)
            if (next !== raw) {
              requestAnimationFrame(() => combobox.inputRef.current?.setSelectionRange(nextCaret, nextCaret))
            }
            combobox.setOpen(true)
          }}
          onFocus={(e) => {
            setFocused(true)
            syncCaret(e.target)
            combobox.setOpen(true)
          }}
          onBlur={() => {
            setFocused(false)
            requestAnimationFrame(() => {
              const el = combobox.inputRef.current
              if (!el) return
              el.scrollLeft = 0
              el.scrollTop = 0
              syncScroll()
            })
          }}
          onClick={(e) => {
            syncCaret(e.target)
            combobox.setOpen(true)
          }}
          onKeyUp={(e) => syncCaret(e.target)}
          onSelect={(e) => syncCaret(e.target)}
          onScroll={syncScroll}
          onKeyDown={(e) => {
            combobox.onKeyDown(e)
            if (e.key === 'Enter' && !e.defaultPrevented) e.preventDefault()
          }}
          className={`relative z-1 block w-full min-w-0 resize-none rounded-md border border-input bg-transparent py-1.75 pl-2.5 pr-6 text-xs leading-4 transition-[height,border-color] duration-100 outline-none placeholder:text-text-tertiary focus-visible:border-ring/50 ${
            focused
              ? 'field-sizing-content h-auto min-h-8 max-h-16 overflow-x-hidden overflow-y-auto whitespace-pre-wrap wrap-break-word'
              : 'h-8 overflow-hidden whitespace-pre'
          } ${value ? 'text-transparent' : ''}`}
        />
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              onChange('')
              combobox.setOpen(false)
            }}
            className="absolute right-1 top-1.5 z-10 size-5 text-text-tertiary hover:text-text-secondary"
            aria-label="Clear search"
          >
            <X size={12} />
          </Button>
        ) : null}
      </div>

      {completing && combobox.showList ? (
        <ComboboxPopup listRef={combobox.listRef}>
          {matches.map((m, i) => (
            <ComboboxRow
              key={m.key}
              active={i === combobox.hlIndex}
              disabled={m.disabled}
              negate={active.negate}
              title={m.disabled ? MULTIWORD_HINT : undefined}
              onSelect={() => pick(m.label)}
              onHover={() => combobox.setHlIndex(i)}
            >
              {m.color ? <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: m.color }} /> : null}
              <ComboboxLabel negate={active.negate}>{m.label}</ComboboxLabel>
              {m.count > 0 && <span className="text-text-tertiary text-[11px] shrink-0">{m.count}</span>}
            </ComboboxRow>
          ))}
        </ComboboxPopup>
      ) : showReference ? (
        <div className="absolute z-30 left-0 right-0 mt-1 px-2.5 py-2 bg-popover border border-border rounded shadow-lg flex flex-col gap-1.5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-text-tertiary shrink-0">e.g.</span>
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre text-xs opacity-65">
              {EXAMPLE_SEGMENTS.map((seg, i) => (
                <span key={i} className={segmentClass(seg)}>
                  {seg.text}
                </span>
              ))}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 text-[11px]">
            {legend.map(({ sigil, label, field }) => (
              <div key={sigil} className="flex items-center gap-1.5">
                <span className={`w-3 text-center font-medium opacity-80 ${field ? FIELD_CLASS[field] : NEGATE_CLASS}`}>
                  {sigil}
                </span>
                <span className="text-text-tertiary">{label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : showDiscovery ? (
        <div className="absolute z-30 left-0 right-0 mt-1 px-2.5 py-1.5 bg-popover border border-border rounded shadow-lg text-[11px] text-text-tertiary flex items-center gap-x-2.5 gap-y-1 flex-wrap">
          {legend.map(({ sigil, label, field }) => (
            <span key={sigil} className="whitespace-nowrap">
              <span className={`font-medium opacity-70 ${field ? FIELD_CLASS[field] : NEGATE_CLASS}`}>{sigil}</span>
              <span className="ml-1">{label}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
