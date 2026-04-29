/**
 * Single source of truth for the `disable_behavior` setting wire format.
 *
 * Stored as a string so existing settings:get/set IPC plumbing carries it
 * unchanged. The two valid forms are:
 *  - `'suffix'` — VaM-native disable (rename to `.var.disabled` in main).
 *  - `'move-to:<auxDirId>'` — move to a registered aux library directory.
 *
 * Lives in `src/shared/` so both the main process (storage-state, IPC) and the
 * renderer (SettingsView) parse it the same way without duplicating the prefix
 * literal across files.
 */

export const DISABLE_BEHAVIOR_SUFFIX = 'suffix'
const MOVE_TO_PREFIX = 'move-to:'

/** Build the wire string for a "move to aux dir" disable behavior. */
export function disableBehaviorMoveTo(auxDirId) {
  return `${MOVE_TO_PREFIX}${auxDirId}`
}

/**
 * Parse the wire value. Returns either `{ kind: 'suffix' }` or
 * `{ kind: 'move-to', auxDirId: number }`. Falls back to suffix for any
 * malformed input so callers can treat the result as exhaustive.
 */
export function parseDisableBehavior(value) {
  if (!value || value === DISABLE_BEHAVIOR_SUFFIX) return { kind: 'suffix' }
  if (typeof value !== 'string' || !value.startsWith(MOVE_TO_PREFIX)) return { kind: 'suffix' }
  const idStr = value.slice(MOVE_TO_PREFIX.length)
  if (!/^\d+$/.test(idStr)) return { kind: 'suffix' }
  return { kind: 'move-to', auxDirId: parseInt(idStr, 10) }
}
