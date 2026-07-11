/** Sigil → field. Plain tokens (no sigil) are free-text. */
export const SMART_SIGILS = {
  '@': 'author',
  '#': 'tag',
  '%': 'label',
}

/**
 * Parse a smart-search query into AND-ed tokens.
 * `-`/`!` negate; `@`/`#`/`%` scope to author/tag/label; plain = free text.
 * Incomplete tokens (bare `-`, bare `#`, …) are skipped from `tokens` but still
 * flip `hasSyntax` so the UI tip can appear while typing a prefix.
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
  const sigil = raw[i]
  if (sigil && sigil in SMART_SIGILS) {
    field = SMART_SIGILS[sigil]
    i += 1
  }
  return { negate, field, value: raw.slice(i).toLowerCase(), raw }
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
  const { negate, field, value } = parseToken(raw)
  const prefixLen = (negate ? 1 : 0) + (field !== 'text' ? 1 : 0)
  return {
    start,
    end,
    raw,
    negate,
    field,
    /** Value after stripping -/! and sigil (may be empty while typing). */
    query: value,
    /** Leading `-`/`!` + sigil preserved when splicing a suggestion. */
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
 *   'sigil'  → a field sigil (`@`/`#`/`%`), with `field`
 *   'value'  → the value after a sigil, with `field`
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
    const field = SMART_SIGILS[part[i]]
    if (field) {
      out.push({ text: part[i], kind: 'sigil', field, negate })
      const value = part.slice(i + 1)
      if (value) out.push({ text: value, kind: 'value', field, negate })
    } else {
      const rest = part.slice(i)
      if (rest) out.push({ text: rest, kind: 'text', negate })
    }
  }
  return out
}

/**
 * Match an item against parsed smart-search tokens (implicit AND).
 * `get` supplies field accessors (called lazily per token):
 *   text()   → string[] haystacks
 *   author() → string
 *   tags()   → string[] already-lowercased tag names
 *   labels() → string[] label names (any case)
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
    }
    if (negate ? hit : !hit) return false
  }
  return true
}
