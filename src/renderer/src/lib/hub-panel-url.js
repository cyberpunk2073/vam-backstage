/**
 * Map an embedded Hub `*-panel` URL to the equivalent full-page URL for copy /
 * open-in-browser. Known panel → full mappings:
 *
 *   …/overview-panel  → …/
 *   …/review-panel    → …/reviews
 *   …/history-panel   → …/history
 *   …/updates-panel   → …/updates
 *   …/discussion-panel → …/   (threads)
 *
 * Anything else (non-hub, non-panel, or unknown panel) is returned as-is.
 * Preserves slug form when the Hub has already redirected
 * (e.g. /resources/my-pkg.63748/overview-panel).
 */
export function toFullHubUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString) return urlString
  try {
    const u = new URL(urlString)
    if (u.hostname !== 'hub.virtamate.com') return urlString
    const m = u.pathname.match(
      /^\/(resources|threads)\/([^/]+)\/(overview|review|history|updates|discussion)-panel\/?$/,
    )
    if (!m) return urlString
    const [, kind, id, panel] = m
    const base = `${u.origin}/${kind}/${id}`
    switch (panel) {
      case 'overview':
      case 'discussion':
        return `${base}/`
      case 'review':
        return `${base}/reviews`
      case 'history':
        return `${base}/history`
      case 'updates':
        return `${base}/updates`
      default:
        return urlString
    }
  } catch {
    return urlString
  }
}
