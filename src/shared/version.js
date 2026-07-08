/** Shared helpers for reasoning about app version strings. */

/**
 * A dev build carries a `-dev.<n>` semver prerelease tag (see the dev-release
 * workflow, which rewrites `package.json` to `X.Y.(Z+1)-dev.<run_number>`).
 * Its version churns on every CI run, so an exact-match gate against a peer is
 * pointless — treat any `-dev` build as relaxed.
 */
export function isDevVersion(v) {
  return typeof v === 'string' && v.includes('-dev')
}
