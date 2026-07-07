/**
 * Pure helpers for the loose extracted-preset lifecycle (disable/enable/delete).
 *
 * These compute the file operations and state decisions without touching the
 * filesystem, store, or DB, so `ipc/packages.js` stays a thin applier and the
 * fiddly path/sidecar logic is unit-testable in isolation. `.disabled` is the
 * `.var`-style disable marker applied to a loose `.vap`.
 */

/** Live (enabled) path of a loose preset, dropping a trailing `.disabled`. */
export function liveExtractedPath(internalPath) {
  return internalPath.endsWith('.disabled') ? internalPath.slice(0, -'.disabled'.length) : internalPath
}

/** Sidecars renamed alongside the `.vap` so favorites/hidden survive a toggle. */
const PRESET_SIDECARS = ['.hide', '.fav']

/**
 * Rename plan (`{ from, to, optional }`, paths relative to the VaM dir) to move
 * a loose preset to the disabled (`disable=true`) or enabled state, carrying its
 * `.hide`/`.fav` sidecars. The first entry is the `.vap` itself (required); the
 * rest are optional sidecars. The `.jpg` thumbnail is intentionally left in
 * place — the classifier pairs it with the live stem either way.
 */
export function extractedRenamePlan(internalPath, disable) {
  const live = liveExtractedPath(internalPath)
  const from = disable ? live : live + '.disabled'
  const to = disable ? live + '.disabled' : live
  const plan = [{ from, to, optional: false }]
  for (const s of PRESET_SIDECARS) plan.push({ from: from + s, to: to + s, optional: true })
  return plan
}

/**
 * Every sibling path (relative to the VaM dir) to unlink when deleting a preset:
 * both enabled/disabled `.vap` forms, the `.jpg` thumbnail (both forms), and the
 * `.hide`/`.fav` sidecars (both forms). Best-effort — most won't exist.
 */
export function extractedDeletePaths(internalPath) {
  const live = liveExtractedPath(internalPath)
  const jpg = live.replace(/\.vap$/i, '.jpg')
  return [
    live,
    live + '.disabled',
    jpg,
    jpg + '.disabled',
    live + '.hide',
    live + '.fav',
    live + '.disabled.hide',
    live + '.disabled.fav',
  ]
}

/** True when no candidate version is active → the preset should be disabled. */
export function extractedShouldDisable(candidates, isActive) {
  return !(candidates || []).some(isActive)
}

/** True when some candidate survives removal (still installed, not removed). */
export function extractedHasSurvivor(candidates, survives) {
  return (candidates || []).some(survives)
}
