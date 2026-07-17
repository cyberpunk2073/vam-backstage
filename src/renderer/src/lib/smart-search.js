/**
 * Field registry: each entry is a `key:` long form; optional `sigil` is a
 * single-char shortcut. Plain tokens (no sigil / unknown key) are free-text.
 */
export const FIELDS = [
  { key: 'author', sigil: '@', match: 'substring' },
  { key: 'tag', sigil: '#', match: 'exact' },
  { key: 'label', sigil: '%', match: 'exact' },
  { key: 'type', sigil: '^', match: 'exact' },
  { key: 'pkg', match: 'exact' },
  { key: 'is', match: 'flag' },
]

/** Sigil → field key (derived). */
export const SMART_SIGILS = Object.fromEntries(FIELDS.filter((f) => f.sigil).map((f) => [f.sigil, f.key]))

const KEYS = new Set(FIELDS.map((f) => f.key))

/**
 * Parse a smart-search query into AND-ed tokens.
 * `-`/`!` negate; `@`/`#`/`%`/`^` or `key:` scope a field; plain = free text.
 * Incomplete tokens (bare `-`, bare `#`, `is:`, …) are skipped from `tokens`
 * but still flip `hasSyntax` so the UI tip can appear while typing a prefix.
 */
export function parseSmartQuery(search) {
  const tokens = []
  let hasSyntax = false
  for (const raw of String(search || '')
    .trim()
    .split(/\s+/)) {
    if (!raw) continue
    const parsed = parseToken(raw)
    if (parsed.negate || parsed.field !== 'text') hasSyntax = true
    if (!parsed.value) continue
    tokens.push({ field: parsed.field, value: parsed.value, negate: parsed.negate })
  }
  return { tokens, hasSyntax }
}

function parseToken(raw) {
  let i = 0
  let negate = false
  if (raw[0] === '-' || raw[0] === '!') {
    negate = true
    i = 1
  }
  let field = 'text'
  let prefixLen = negate ? 1 : 0

  const ch = raw[i]
  if (ch && ch in SMART_SIGILS) {
    field = SMART_SIGILS[ch]
    i += 1
    prefixLen += 1
  } else {
    const rest = raw.slice(i)
    const colon = rest.indexOf(':')
    if (colon > 0) {
      const key = rest.slice(0, colon).toLowerCase()
      if (KEYS.has(key)) {
        field = key
        i += colon + 1
        prefixLen += colon + 1
      }
    }
  }
  return { negate, field, value: raw.slice(i).toLowerCase(), raw, prefixLen }
}

/**
 * Whitespace-delimited token under `caret` (selectionStart). Works for mid-token
 * edits: scan left/right to spaces. Returns null when the caret sits between
 * tokens (on/after whitespace with no token to the left).
 */
export function tokenAtCaret(text, caret) {
  const s = String(text ?? '')
  const pos = Math.max(0, Math.min(caret ?? s.length, s.length))

  let start
  let end
  if (pos < s.length && s[pos] !== ' ') {
    start = pos
    while (start > 0 && s[start - 1] !== ' ') start -= 1
    end = pos
    while (end < s.length && s[end] !== ' ') end += 1
  } else if (pos > 0 && s[pos - 1] !== ' ') {
    // Caret on a trailing space / EOS — active token is the one just finished.
    end = pos
    start = pos - 1
    while (start > 0 && s[start - 1] !== ' ') start -= 1
  } else {
    return null
  }

  const raw = s.slice(start, end)
  if (!raw) return null
  const { negate, field, value, prefixLen } = parseToken(raw)
  return {
    start,
    end,
    raw,
    negate,
    field,
    /** Value after stripping -/! and sigil/key: (may be empty while typing). */
    query: value,
    /** Leading `-`/`!` + sigil or `key:` preserved when splicing a suggestion. */
    prefix: raw.slice(0, prefixLen),
    completable: field !== 'text',
  }
}

/** Replace the token span with `prefix + value`, adding a trailing space at EOS. */
export function spliceToken(text, token, value) {
  const s = String(text ?? '')
  const insert = `${token.prefix}${value}`
  const after = s.slice(token.end)
  const needsSpace = after.length === 0 || after[0] !== ' '
  return s.slice(0, token.start) + insert + (needsSpace ? ' ' : '') + after
}

/**
 * Break the raw query into styleable segments covering every character
 * (including whitespace and incomplete tokens) for an in-field highlight layer.
 * Unlike `parseSmartQuery`, nothing is dropped so the output can be rendered
 * 1:1 over the input text. Segment `kind`:
 *   'space'  → run of whitespace
 *   'negate' → a leading `-` / `!`
 *   'sigil'  → a field sigil (`@`/`#`/`%`/`^`), with `field`
 *   'key'    → a `key:` run, with `field`
 *   'value'  → the value after a sigil/key, with `field`
 *   'text'   → plain free-text
 */
export function highlightSegments(text) {
  const out = []
  for (const part of String(text ?? '').split(/(\s+)/)) {
    if (!part) continue
    if (/^\s+$/.test(part)) {
      out.push({ text: part, kind: 'space' })
      continue
    }
    let i = 0
    const negate = part[0] === '-' || part[0] === '!'
    if (negate) {
      out.push({ text: part[0], kind: 'negate' })
      i = 1
    }
    const ch = part[i]
    if (ch && ch in SMART_SIGILS) {
      const field = SMART_SIGILS[ch]
      out.push({ text: ch, kind: 'sigil', field, negate })
      const value = part.slice(i + 1)
      if (value) out.push({ text: value, kind: 'value', field, negate })
    } else {
      const rest = part.slice(i)
      const colon = rest.indexOf(':')
      if (colon > 0) {
        const key = rest.slice(0, colon).toLowerCase()
        if (KEYS.has(key)) {
          out.push({ text: rest.slice(0, colon + 1), kind: 'key', field: key, negate })
          const value = rest.slice(colon + 1)
          if (value) out.push({ text: value, kind: 'value', field: key, negate })
          continue
        }
      }
      if (rest) out.push({ text: rest, kind: 'text', negate })
    }
  }
  return out
}

/**
 * Match an item against parsed smart-search tokens (implicit AND).
 * `get` supplies field accessors (called lazily per token):
 *   text()     → string[] haystacks
 *   author()   → string
 *   tags()     → string[] already-lowercased tag names
 *   labels()   → string[] label names (any case)
 *   types()    → string[] type labels (any case)
 *   pkgTypes() → string[] package-type labels (any case)
 *   flags()    → string[] already-lowercased flag names
 */
export function matchesSmartQuery(tokens, get) {
  if (!tokens?.length) return true
  for (const { field, value, negate } of tokens) {
    let hit = false
    if (field === 'text') {
      const hay = (get.text?.() || []).map((s) => (s || '').toLowerCase())
      hit = hay.some((h) => h.includes(value))
    } else if (field === 'author') {
      hit = (get.author?.() || '').toLowerCase().includes(value)
    } else if (field === 'tag') {
      hit = (get.tags?.() || []).includes(value)
    } else if (field === 'label') {
      hit = (get.labels?.() || []).some((n) => (n || '').toLowerCase() === value)
    } else if (field === 'type') {
      hit = (get.types?.() || []).some((t) => (t || '').toLowerCase() === value)
    } else if (field === 'pkg') {
      hit = (get.pkgTypes?.() || []).some((t) => (t || '').toLowerCase() === value)
    } else if (field === 'is') {
      hit = (get.flags?.() || []).includes(value)
    }
    if (negate ? hit : !hit) return false
  }
  return true
}
