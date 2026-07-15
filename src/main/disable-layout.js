/**
 * On-disk encoding of a *disabled* `.var` package in the main library dir.
 *
 * Three layouts express "disabled", differing only in *where the content bytes
 * live* relative to the canonical `X.var`:
 *  - **marker** (VaM-native): the real `X.var` stays in place beside an empty
 *    `X.var.disabled` marker; the marker's mere presence signals "disabled".
 *  - **legacy suffix**: older versions of this app (and some external tools)
 *    *renamed* `X.var` → `X.var.disabled`, so the content lives in the suffixed
 *    file with no bare sibling.
 *  - **Qvaro**: the Qvaro tool renames `X.var` → `X.DISABLED` (uppercase, matched
 *    case-insensitively — the whole `.var` extension is replaced), so the content
 *    lives in the `.DISABLED` file with no bare sibling and no `.var.disabled`.
 *
 * We support *reading* all three; app-initiated disables always write the
 * marker layout (see `storage-state.js`). We do NOT persist which layout a row
 * uses. The `packages` row stores only the canonical bare `filename` (never
 * suffixed/renamed), the `storage_state`, and the `subpath` directory; the
 * physical byte location is resolved from disk on demand (see `resolveContentPath`
 * in `library-dirs.js`). Reads that need the bytes are rare and already touch the
 * disk, so re-deriving the layout with a couple of `stat`s is free and keeps the
 * disk as the single source of truth — no cached column to go stale.
 *
 * The legacy-suffix and Qvaro layouts are the *same case* to this classifier:
 * "content lives in the disabled sibling, no bare `.var`". Only the sibling's
 * on-disk spelling differs (`X.var.disabled` vs `X.DISABLED`), which is resolved
 * in `classifyMainVarOnDisk` (see `library-dirs.js`) — so `classifyMainVar`
 * itself is name-agnostic and works purely on the bare + disabled-sibling sizes.
 * The main process wraps it in `classifyMainVarOnDisk` to stat the siblings and
 * derive `storageState` + `contentPath`; callers read those directly.
 */

/**
 * Classify the on-disk footprint of one canonical `.var` in a MAIN library dir
 * from the sizes of its bare and disabled-sibling files (`null` when the file is
 * absent). Aux dirs never carry a disabled encoding — callers handle the
 * offloaded case separately.
 *
 * Detection rule (matches VaM): a canonical is disabled iff a disabled sibling
 * file exists. Content is read from the bare `.var` when it holds bytes,
 * otherwise from the disabled sibling (legacy suffix or Qvaro rename).
 *
 * Returns one of:
 *  - `{ present: false }` — no usable content (nothing on disk, or only an
 *    empty marker with no bare content anywhere). An empty bare with no marker
 *    still classifies as enabled — it gets indexed and surfaces as unreadable,
 *    rather than being silently invisible.
 *  - `{ present: true, storageState: 'enabled',  contentInDisabled: false }`
 *  - `{ present: true, storageState: 'disabled', contentInDisabled: false }` (marker)
 *  - `{ present: true, storageState: 'disabled', contentInDisabled: true  }` (suffix/Qvaro)
 *
 * @param {{ bareSize: number|null, disabledSize: number|null }} sizes
 */
export function classifyMainVar({ bareSize, disabledSize }) {
  const hasBare = bareSize != null
  const bareHasContent = hasBare && bareSize > 0
  const hasDisabled = disabledSize != null

  if (hasDisabled) {
    if (bareHasContent) return { present: true, storageState: 'disabled', contentInDisabled: false }
    if (disabledSize > 0) return { present: true, storageState: 'disabled', contentInDisabled: true }
    return { present: false } // only an empty marker (and no bare content) — no package here
  }
  if (hasBare) return { present: true, storageState: 'enabled', contentInDisabled: false }
  return { present: false }
}
