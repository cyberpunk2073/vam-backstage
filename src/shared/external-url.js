const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Resolve a user/hub-supplied link into a safe http(s) URL string, or null if
 * it can't be. Hub `promotional_link` values are entered by creators and often
 * omit the scheme (e.g. "www.patreon.com/foo" or "Patreon.com/foo"); those fail
 * to parse as URLs, so we retry with an assumed https:// prefix. A scheme-less
 * candidate must resolve to a dotted host so we never launch garbage input.
 *
 * Shared between the main process (shell:openExternal handler) and the renderer
 * (link gating / labels) so both agree on what counts as an openable link.
 */
export function normalizeExternalUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null
  const raw = input.trim()
  try {
    const u = new URL(raw)
    return ALLOWED_PROTOCOLS.has(u.protocol) ? u.href : null
  } catch {
    try {
      const u = new URL('https://' + raw.replace(/^\/+/, ''))
      if (ALLOWED_PROTOCOLS.has(u.protocol) && u.hostname.includes('.')) return u.href
    } catch {}
    return null
  }
}
