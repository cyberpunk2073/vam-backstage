/**
 * On-disk encoding of a *disabled* `.var` package in the main library dir.
 *
 * VaM disables a package by keeping the real `X.var` in place and dropping an
 * empty sibling `X.var.disabled` marker; the marker's mere presence signals
 * "disabled". Some external tools (and older versions of this app) instead
 * *renamed* `X.var` → `X.var.disabled`, so the content lives in the suffixed
 * file with no bare sibling. We support both.
 *
 * The single degree of freedom is *where the content bytes live*: in the bare
 * `X.var` (marker layout) or in `X.var.disabled` (suffix layout). We do NOT
 * persist this in the DB. The `packages` row stores only the canonical bare
 * `filename` (never suffixed), the `storage_state`, and the `subpath` directory;
 * the physical byte location is resolved from disk on demand (see
 * `resolveContentPath` in `library-dirs.js`). Reads that need the bytes are rare
 * and already touch the disk, so re-deriving the layout with a couple of `stat`s
 * is free and keeps the disk as the single source of truth — no cached column to
 * go stale, and no migration needed to support a future third scheme (e.g. Qvaro,
 * which renames `X.var` → `X.DISABLED`): the classifier just grows another case.
 *
 * `classifyMainVar` is the pure decision function over the two current siblings;
 * the main process wraps it in `classifyMainVarOnDisk` (see `library-dirs.js`) to
 * stat them and derive `storageState` + `contentPath`. Callers read those
 * directly, so there is no separate layout enum.
 */

/**
 * Classify the on-disk footprint of one canonical `.var` in a MAIN library dir
 * from the sizes of its bare and `.disabled` files (`null` when the file is
 * absent). Aux dirs never carry a disabled encoding — callers handle the
 * offloaded case separately.
 *
 * Detection rule (matches VaM): a canonical is disabled iff a `.var.disabled`
 * file exists. Content is read from the bare `.var` when it holds bytes,
 * otherwise from the `.var.disabled` file (legacy rename).
 *
 * Returns one of:
 *  - `{ present: false }` — no usable content (nothing on disk, or only an
 *    empty marker with no bare content anywhere). An empty bare with no marker
 *    still classifies as enabled — it gets indexed and surfaces as unreadable,
 *    rather than being silently invisible.
 *  - `{ present: true, storageState: 'enabled',  contentInDisabled: false }`
 *  - `{ present: true, storageState: 'disabled', contentInDisabled: false }` (marker)
 *  - `{ present: true, storageState: 'disabled', contentInDisabled: true  }` (suffix)
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
