/**
 * Schema-driven persistence for view-state stores (filters/sort/layout) via
 * zustand persist + localStorage. View state is low-stakes layout — if it
 * resets nothing is lost — so it lives here rather than in SQLite.
 *
 * A schema maps each persisted field to a validator and doubles as the
 * partialize allowlist: only schema keys are written, and on rehydration a
 * validator returning `undefined` drops the stored value so the store default
 * wins. Validators are intentionally lenient — sorts/license pass through as
 * plain strings since the views already fall back safely on an unknown value.
 */

/** Validator: keep the value only when it is one of `allowed`. */
export const oneOf = (allowed) => (v) => (allowed.includes(v) ? v : undefined)

/** Validator: keep arrays, drop anything else. */
export const asArray = (v) => (Array.isArray(v) ? v : undefined)

/**
 * Validator: polarity filter lists (`[{ value, negate }]`). Accepts legacy
 * plain string/id arrays and upgrades each element to `{ value, negate: false }`.
 */
export const asPolarityList = (v) => {
  if (!Array.isArray(v)) return undefined
  const out = []
  for (const el of v) {
    if (el && typeof el === 'object' && 'value' in el) {
      out.push({ value: el.value, negate: !!el.negate })
    } else if (typeof el === 'string' || typeof el === 'number') {
      out.push({ value: el, negate: false })
    }
  }
  return out
}

/** Validator: keep strings, drop anything else. */
export const asString = (v) => (typeof v === 'string' ? v : undefined)

/** Validator: keep booleans, drop anything else. */
export const asBool = (v) => (typeof v === 'boolean' ? v : undefined)

/** Validator: keep plain objects (not arrays/null), drop anything else. */
export const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined)

/** Validator: parse and clamp a card width to 100-500. */
export const asCardWidth = (v) => {
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? undefined : Math.min(500, Math.max(100, n))
}

/**
 * Build the options object for `persist` from a store `name` and a field
 * `schema`. The schema keys are the persisted allowlist; the values validate
 * each field when rehydrating over the store's freshly-created defaults.
 */
export function persistViewState(name, schema) {
  const keys = Object.keys(schema)
  return {
    name,
    partialize: (s) => {
      const out = {}
      for (const k of keys) out[k] = s[k]
      return out
    },
    merge: (persisted, current) => {
      if (!persisted || typeof persisted !== 'object') return current
      const out = { ...current }
      for (const k of keys) {
        const cleaned = schema[k](persisted[k])
        if (cleaned !== undefined) out[k] = cleaned
      }
      return out
    },
  }
}
