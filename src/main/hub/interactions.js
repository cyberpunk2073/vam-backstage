import { app, net, session } from 'electron'
import { notify } from '../notify.js'

const HUB_ORIGIN = 'https://hub.virtamate.com'

/**
 * Match the User-Agent the persist:hub webview used to authenticate. Cloudflare
 * binds the `cf_clearance` cookie to the exact UA that solved its challenge, so
 * a custom UA on these requests gets blocked/garbled (no _xfToken, no state).
 */
function hubUserAgent() {
  return app.userAgentFallback
}

/** Thrown when a POST reveals the Hub session is no longer authenticated. */
export class HubAuthError extends Error {
  constructor(message) {
    super(message || 'You must be logged-in to do that.')
    this.name = 'HubAuthError'
  }
}

// Held per panel-open, not a persistent cache: overwritten by the next page
// fetch, nulled by the cookie watcher on any xf_user change.
let sessionToken = null
// Per-resource snapshot captured from the last page GET, keyed by stringified
// resource id, so toggles know the canonical path and add-vs-delete.
const resourceState = new Map()

function getSession() {
  return session.fromPartition('persist:hub')
}

/** Neutral per-resource state: no personal flags, unknown counts. */
export function neutralResourceState(extra) {
  return {
    loggedIn: false,
    favorited: false,
    bookmarked: false,
    // `rated`/`ratedDown`: the Hub thumbs up/down *rating* (its `/like/` endpoint).
    rated: false,
    ratedDown: false,
    // `liked`: the visitor's emoji "Like" reaction (reaction id 1).
    liked: false,
    favoriteCount: null,
    ...extra,
  }
}

export function invalidateToken() {
  sessionToken = null
}

export async function isLoggedIn() {
  const ses = getSession()
  const cookies = await ses.cookies.get({ url: HUB_ORIGIN, name: 'xf_user' })
  return cookies.some((c) => c.value && c.value.length > 0)
}

/** GET a Hub page through persist:hub cookies. Resolves { canonicalUrl, html }. */
function hubGet(url, { maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url,
      session: getSession(),
      useSessionCookies: true,
      redirect: 'manual',
    })
    request.setHeader('User-Agent', hubUserAgent())
    request.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
    request.setHeader('Accept-Language', 'en-US,en;q=0.9')

    let canonicalUrl = url
    let redirectCount = 0
    request.on('redirect', (_status, _method, redirectUrl) => {
      if (++redirectCount > maxRedirects) {
        request.abort()
        reject(new Error('Too many redirects'))
        return
      }
      canonicalUrl = redirectUrl
      request.followRedirect()
    })
    request.on('response', (response) => {
      const chunks = []
      response.on('data', (c) => chunks.push(c))
      response.on('end', () => resolve({ canonicalUrl, html: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

/** POST urlencoded body through persist:hub cookies. Resolves parsed JSON. */
function hubPost(url, bodyParams, { referer }) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'POST',
      url,
      session: getSession(),
      useSessionCookies: true,
      redirect: 'follow',
    })
    request.setHeader('User-Agent', hubUserAgent())
    request.setHeader('Accept', 'application/json, text/javascript, */*; q=0.01')
    request.setHeader('X-Requested-With', 'XMLHttpRequest')
    request.setHeader('Origin', HUB_ORIGIN)
    request.setHeader('Referer', referer || HUB_ORIGIN)
    request.setHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8')

    request.on('response', (response) => {
      const chunks = []
      response.on('data', (c) => chunks.push(c))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error('Hub returned a non-JSON response'))
        }
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end(encodeBody(bodyParams))
  })
}

function encodeBody(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

/** Scoped regex parse of a resource page — no DOM parser. */
function parseResourcePage(html, finalUrl) {
  let canonicalPath = null
  try {
    const u = new URL(finalUrl)
    if (/\/resources\//.test(u.pathname)) canonicalPath = u.pathname
  } catch {}
  if (!canonicalPath) {
    const m = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)
    if (m) {
      try {
        canonicalPath = new URL(m[1]).pathname
      } catch {}
    }
  }

  let token = null
  const csrf = html.match(/data-csrf=(["'])(.*?)\1/)
  if (csrf) token = csrf[2]
  if (!token) {
    const tok = html.match(/name="_xfToken"\s+value="([^"]+)"/)
    if (tok) token = tok[1]
  }
  if (!token) {
    const cfg = html.match(/["']csrf["']\s*:\s*["']([^"']+)["']/)
    if (cfg) token = cfg[1]
  }

  // User's own favorite/bookmark state comes from the action buttons. Test the
  // state class only inside the element's `class` attribute — the toggle markup
  // also carries the class name in a data-attribute (e.g. ddClass:is-bookmarked),
  // which is present regardless of state and would otherwise always match.
  const favorited = elementClassHas(html, 'button--favorite', 'is-favorited')
  const bookmarked = elementClassHas(html, 'button--icon--bookmark', 'is-bookmarked')

  // The resource thumbs up/down *rating*: the two buttons gain `is-active-like` on
  // the side the visitor picked (and lose the `add-like` affordance class). The
  // Hub calls this endpoint "like", but it is a positive/negative rating distinct
  // from the emoji reaction below — surfaced here as `rated` / `ratedDown`.
  const rated = elementClassHas(html, 'button--like', 'is-active-like')
  const ratedDown = elementClassHas(html, 'button--unlike', 'is-active-like')

  // The emoji reaction bar (SV ContentRatings). The visitor "liked" it if they
  // left ANY reaction — not just the default thumbs-up (id 1) — so we keep the
  // actual id: un-liking must re-post that same id (XenForo only toggles a
  // reaction off when re-posted). Reactions are scoped to a resource *update*, so
  // capture the update id the bar targets — the emoji-like toggle POSTs against it.
  const reactionUpdateId = parseReactionUpdateId(html)
  const visitorReactionId = parseVisitorReactionId(html)
  const liked = visitorReactionId != null

  // The sidebar stats block carries fresh, reliably-placed counts (none are in
  // api.php): `favorites` and `reactions` (the emoji total, == the API's
  // `reaction_score`). We prefer the page's `reactions` over the API's cached
  // `reaction_score` so the like button's base number can't lag the visitor's own
  // just-made reaction. Each is null when its row is absent.
  const favoriteCount = parseSidebarStat(html, 'favorites')
  const reactionScore = parseSidebarStat(html, 'reactions')

  return {
    canonicalPath,
    token,
    favorited,
    favoriteCount,
    bookmarked,
    rated,
    ratedDown,
    liked,
    visitorReactionId,
    reactionUpdateId,
    reactionScore,
  }
}

/** Update id the emoji reaction bar targets, from `js-ratingBar-resource_update{id}`. */
function parseReactionUpdateId(html) {
  const m = html.match(/js-ratingBar-resource_update(\d+)/) || html.match(/\/update\/(\d+)\/react/)
  return m ? m[1] : null
}

/**
 * The visitor's own emoji reaction id, or null. Once reacted, the rate trigger's
 * text becomes "Remove" and its href carries the chosen reaction id.
 */
function parseVisitorReactionId(html) {
  const m = html.match(/react\?reaction_id=(\d+)"[^>]*\bbutton--sv-rate\b[^>]*>\s*<span[^>]*>\s*Remove/i)
  return m ? parseInt(m[1], 10) : null
}

/** True if the element whose class list contains `marker` also contains `stateClass`. */
function elementClassHas(html, marker, stateClass) {
  const tag = html.match(new RegExp(`<[^>]*\\sclass="[^"]*\\b${marker}\\b[^"]*"[^>]*>`))
  if (!tag) return false
  const cls = tag[0].match(/\sclass="([^"]*)"/)
  return cls ? new RegExp(`\\b${stateClass}\\b`).test(cls[1]) : false
}

/** Pull a numeric value from a resource sidebar stat row, e.g. `pairs--favorites` -> 35. */
function parseSidebarStat(html, kind) {
  const m = html.match(new RegExp(`pairs--${kind}\\b[\\s\\S]*?<dd>\\s*([\\d,]+)`, 'i'))
  if (!m) return null
  const n = parseInt(m[1].replace(/,/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Read the user's favorite/bookmark state plus the public favourite count for a
 * resource. Logged-out short-circuits with no network (state and the favourite
 * count are only surfaced to signed-in users); `loggedIn` is read from the
 * cookie jar. Signed in, it fetches the resource page once and parses both.
 */
export async function getResourceUserState(id) {
  let loggedIn = false
  try {
    loggedIn = await isLoggedIn()
    if (!loggedIn) return neutralResourceState()
    const { canonicalUrl, html } = await hubGet(`${HUB_ORIGIN}/resources/${id}/`)
    const parsed = parseResourcePage(html, canonicalUrl)
    if (parsed.token) sessionToken = parsed.token
    resourceState.set(String(id), {
      canonicalPath: parsed.canonicalPath || `/resources/${id}/`,
      favorited: parsed.favorited,
      bookmarked: parsed.bookmarked,
      rated: parsed.rated,
      ratedDown: parsed.ratedDown,
      liked: parsed.liked,
      reactionId: parsed.visitorReactionId,
      reactionUpdateId: parsed.reactionUpdateId,
    })
    return {
      loggedIn,
      favorited: parsed.favorited,
      favoriteCount: parsed.favoriteCount,
      bookmarked: parsed.bookmarked,
      rated: parsed.rated,
      ratedDown: parsed.ratedDown,
      liked: parsed.liked,
      reactionScore: parsed.reactionScore,
    }
  } catch {
    // Page fetch failed: keep the cookie-derived login state with neutral
    // (unknown) favorite/bookmark status rather than flapping the UI.
    return neutralResourceState({ loggedIn, statusUnknown: true })
  }
}

/** @returns {'auth'|'security'|'generic'|null} */
function classifyError(json) {
  if (!json || json.status !== 'error') return null
  const first = (json.errors && json.errors[0]) || ''
  const title = json.errorHtml?.title || ''
  if (title === 'Log in' || /logged-in/i.test(first)) return 'auth'
  if (/security error/i.test(first)) return 'security'
  return 'generic'
}

async function ensureToken(id) {
  if (sessionToken) return
  // No cached token (first action after a state fetch failure, or invalidated):
  // refetch the page so we have a fresh one plus the canonical path.
  await getResourceUserState(id)
  if (!sessionToken) throw new Error('Could not obtain a Hub security token')
}

/**
 * Shared POST helper applying classifyError: auth → throw HubAuthError;
 * security → refetch token + retry once; generic → throw with errors[0].
 */
async function postWithRecovery(id, buildRequest, { allowRetry = true } = {}) {
  await ensureToken(id)
  const { url, body } = buildRequest()
  const json = await hubPost(url, body, { referer: `${HUB_ORIGIN}${canonicalPathFor(id)}` })
  const kind = classifyError(json)
  if (!kind) return json

  if (kind === 'auth') {
    invalidateToken()
    throw new HubAuthError((json.errors && json.errors[0]) || undefined)
  }
  if (kind === 'security' && allowRetry) {
    invalidateToken()
    await getResourceUserState(id)
    return postWithRecovery(id, buildRequest, { allowRetry: false })
  }
  throw new Error((json.errors && json.errors[0]) || 'Action failed')
}

export async function toggleFavorite(id) {
  if (!(await isLoggedIn())) throw new HubAuthError()
  const json = await postWithRecovery(id, () => ({
    url: `${HUB_ORIGIN}/resources/${id}/favorite/`,
    body: {
      resource_id: id,
      _xfRequestUri: canonicalPathFor(id),
      _xfWithData: 1,
      _xfToken: sessionToken,
      _xfResponseType: 'json',
    },
  }))
  const favorited = !!json.favorited
  updateSnapshot(id, { favorited })
  return { favorited }
}

export async function toggleBookmark(id, currentlyBookmarked) {
  if (!(await isLoggedIn())) throw new HubAuthError()
  const json = await postWithRecovery(id, () => {
    const body = {
      message: '',
      labels: '',
      _xfRequestUri: canonicalPathFor(id),
      _xfWithData: 1,
      _xfToken: sessionToken,
      _xfResponseType: 'json',
    }
    if (currentlyBookmarked) body.delete = 1
    return { url: `${HUB_ORIGIN}${canonicalPathFor(id)}bookmark`, body }
  })
  const bookmarked = json.switchKey === 'bookmarked'
  updateSnapshot(id, { bookmarked })
  return { bookmarked }
}

/**
 * Toggle the visitor's resource *rating* (the Hub thumbs up/down, served by the
 * `/like/` endpoint). The endpoint never echoes the new state — so we derive it:
 * rating up sends `liked=1` (which also clears any prior down-rating), un-rating
 * sends both flags 0. We never set a down-rating here; the UI only offers the
 * positive rating and merely surfaces an existing down-rating made on the Hub.
 *
 * Un-rating a rating that still has a review returns `{ success: true,
 * needsConfirmation: true }` without clearing it. The Hub would accept a force
 * via `proceed=1` in the body; we don't send that — surface the failure so the
 * user can remove the review on the Hub first.
 */
export async function toggleRate(id, currentlyRated) {
  if (!(await isLoggedIn())) throw new HubAuthError()
  const rate = currentlyRated ? 0 : 1
  const json = await postWithRecovery(id, () => ({
    url: `${HUB_ORIGIN}/resources/${id}/like/`,
    body: {
      liked: rate,
      unliked: 0,
      resource_id: id,
      _xfRequestUri: canonicalPathFor(id),
      _xfWithData: 1,
      _xfToken: sessionToken,
      _xfResponseType: 'json',
    },
  }))
  // Unrate refused: rating has a review. Do not update snapshot / pretend success.
  if (!rate && json?.needsConfirmation) {
    throw new Error('This rating has a review. Remove the review on the Hub before unrating.')
  }
  const rated = !!rate
  updateSnapshot(id, { rated, ratedDown: false })
  return { rated, ratedDown: false }
}

/**
 * Toggle the visitor's reaction on the resource's update. Any existing reaction
 * counts as "liked", not just the default thumbs-up (id 1). Un-liking re-posts the
 * visitor's *current* id, since XenForo only toggles a reaction off when re-posted;
 * liking from scratch posts the default Like (id 1). The response echoes the new
 * reaction id (null once cleared) which we cache — so, e.g., un-liking a Starstruck
 * (8), re-liking (now 1), then un-liking again correctly posts 1 the second time.
 * Reactions are scoped to a resource *update*, so we need the update id from the page.
 */
export async function toggleLike(id) {
  if (!(await isLoggedIn())) throw new HubAuthError()
  if (!reactionUpdateIdFor(id)) await getResourceUserState(id)
  const updateId = reactionUpdateIdFor(id)
  if (!updateId) throw new Error('Could not find this resource’s reaction target')
  const currentReactionId = reactionIdFor(id)
  const targetReactionId = currentReactionId ?? 1
  const json = await postWithRecovery(id, () => ({
    url: `${HUB_ORIGIN}/resources/${id}/update/${updateId}/react?reaction_id=${targetReactionId}`,
    body: {
      _xfRequestUri: canonicalPathFor(id),
      _xfWithData: 1,
      _xfToken: sessionToken,
      _xfResponseType: 'json',
    },
  }))
  const reactionId = json.reactionId ?? null
  const liked = reactionId != null
  updateSnapshot(id, { liked, reactionId })
  return { liked }
}

function canonicalPathFor(id) {
  const snap = resourceState.get(String(id))
  return snap?.canonicalPath || `/resources/${id}/`
}

function reactionUpdateIdFor(id) {
  return resourceState.get(String(id))?.reactionUpdateId || null
}

/** The visitor's current reaction id (null if none) — drives which id an un-like posts. */
function reactionIdFor(id) {
  return resourceState.get(String(id))?.reactionId ?? null
}

function updateSnapshot(id, patch) {
  const key = String(id)
  const snap = resourceState.get(key) || { canonicalPath: `/resources/${id}/` }
  resourceState.set(key, { ...snap, ...patch })
}

let watchInitialized = false
/** Watch the persist:hub cookie jar for login/logout (keyed on xf_user). */
export function initHubAuthWatch() {
  if (watchInitialized) return
  watchInitialized = true
  const ses = getSession()
  ses.cookies.on('changed', (_e, cookie, cause, removed) => {
    if (cookie.name !== 'xf_user') return
    // A session refresh overwrites xf_user, firing a transient removed=true
    // (cause 'overwrite') immediately followed by the new value. Ignore that
    // half so we don't flap loggedIn:false → true on every refresh.
    if (removed && cause === 'overwrite') return
    invalidateToken()
    notify('hub:auth-changed', { loggedIn: !removed })
  })
}
