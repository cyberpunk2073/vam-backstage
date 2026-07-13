import { addWishlistItem, getWishlistIds } from '../db.js'
import { pLimit } from '../p-limit.js'
import { getResourceDetail } from './client.js'
import { notify } from '../notify.js'
import { prefetchHubResThumbnail } from '../thumbnails.js'
import {
  HUB_ORIGIN,
  HubAuthError,
  assertXfOk,
  hubGet,
  hubXfGet,
  isLoggedIn,
  parseCsrfToken,
  parseLoggedInUserId,
  parseMemberSlug,
} from './interactions.js'

const PAGE_DELAY_MS = 250
const DETAIL_CONCURRENCY = 10
/** Process-local cursor so back-to-back imports get non-overlapping created_at ranges. */
let nextImportCreatedAt = 0

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function appendUniqueIds(target, seen, ids) {
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    target.push(id)
  }
}

/** Resource ids from bookmark copy-link rows, in Hub list order (deduped by the caller). */
function parseBookmarkResourceIds(html) {
  const ids = []
  const re = /data-copy-text="https:\/\/hub\.virtamate\.com\/resources\/[^"]+\.(\d+)\/?"/g
  let m
  while ((m = re.exec(html))) ids.push(m[1])
  return ids
}

function parseBookmarkPageCount(html) {
  const m = html.match(/pageNavSimple-el pageNavSimple-el--current"[\s\S]*?\s(\d+)\s+of\s+(\d+)/)
  return m ? Math.max(1, parseInt(m[2], 10)) : 1
}

/** Favorite resource ids in grid/list order. */
function parseFavoriteResourceIds(html) {
  const ids = []
  const re = /<li class="favorite-item[\s\S]*?data-resource-id="(\d+)"/g
  let m
  while ((m = re.exec(html))) ids.push(m[1])
  return ids
}

/** Page count from a favorites-grid fragment (`data-total` / `data-perpage`). */
function parseFavoritesPageCount(html) {
  const tag = html.match(/<ul class="favorites-list[^"]*"[^>]*>/)
  if (!tag) return 1
  const perPage = parseInt(tag[0].match(/data-perpage="(\d+)"/)?.[1] || '42', 10)
  const total = parseInt(tag[0].match(/data-total="(\d+)"/)?.[1] || '0', 10)
  if (!total) return 1
  return Math.max(1, Math.ceil(total / perPage))
}

/** Collections from `/members/{slug}/favorites/` XF ajax. */
function parseFavoriteCollections(html) {
  const collections = []
  for (const block of html.match(/<li class="collection-container[\s\S]*?<\/li>/g) || []) {
    const id = block.match(/data-collection-id="(\d+)"/)?.[1]
    if (!id) continue
    collections.push({
      id,
      isAll: /\bcollection-all\b/.test(block),
    })
  }
  return collections
}

/** Prefer the aggregated "All Favorites" collection; avoids duplicate items across collections. */
function pickFavoriteCollectionsForImport(collections) {
  const all = collections.filter((c) => c.isAll)
  return all.length ? all : collections
}

async function bootstrapSession() {
  if (!(await isLoggedIn())) throw new HubAuthError()
  const { html } = await hubGet(`${HUB_ORIGIN}/account/bookmarks?difference=0`)
  const xfToken = parseCsrfToken(html)
  const userId = parseLoggedInUserId(html)
  const memberSlug = parseMemberSlug(html)
  if (!xfToken || !userId) throw new HubAuthError('Could not read Hub session from bookmarks page')
  return {
    xfToken,
    userId,
    xfRequestUri: memberSlug ? `/members/${memberSlug}/` : `/members/${userId}/`,
    bookmarksHtml: html,
  }
}

async function collectBookmarkResourceIds(onProgress) {
  const { bookmarksHtml: firstHtml } = await bootstrapSession()
  const pageCount = parseBookmarkPageCount(firstHtml)
  const ids = []
  const seen = new Set()
  appendUniqueIds(ids, seen, parseBookmarkResourceIds(firstHtml))
  onProgress?.({ phase: 'collect', source: 'bookmarks', page: 1, pageCount, found: ids.length })

  for (let page = 2; page <= pageCount; page++) {
    await sleep(PAGE_DELAY_MS)
    const { html } = await hubGet(`${HUB_ORIGIN}/account/bookmarks?difference=0&page=${page}`)
    appendUniqueIds(ids, seen, parseBookmarkResourceIds(html))
    onProgress?.({ phase: 'collect', source: 'bookmarks', page, pageCount, found: ids.length })
  }
  return ids
}

async function fetchFavoritesPageHtml({ userId, collectionId, xfToken, xfRequestUri, page = 1 }) {
  const json = await hubXfGet(`/members/${userId}/favorites-grid/${collectionId}/`, {
    xfToken,
    xfRequestUri,
    params: { page, view: 'gridview' },
  })
  assertXfOk(json)
  return json.html?.content || ''
}

async function collectFavoriteResourceIds(onProgress) {
  const ctx = await bootstrapSession()
  const listJson = await hubXfGet(`${ctx.xfRequestUri}favorites/`, {
    xfToken: ctx.xfToken,
    xfRequestUri: ctx.xfRequestUri,
  })
  assertXfOk(listJson)
  const collections = pickFavoriteCollectionsForImport(parseFavoriteCollections(listJson.html?.content || ''))

  if (!collections.length) {
    throw new Error(
      'Could not load your Hub favorites list. Log in via the Hub tab in Backstage and make sure your profile has at least one favorite.',
    )
  }

  const ids = []
  const seen = new Set()

  for (const { id: collectionId } of collections) {
    let page = 1
    let pageCount = 1
    while (page <= pageCount) {
      const html = await fetchFavoritesPageHtml({ ...ctx, collectionId, page })
      appendUniqueIds(ids, seen, parseFavoriteResourceIds(html))
      pageCount = parseFavoritesPageCount(html)
      onProgress?.({
        phase: 'collect',
        source: 'favorites',
        collectionId,
        page,
        pageCount,
        found: ids.length,
      })
      page++
      if (page <= pageCount) await sleep(PAGE_DELAY_MS)
    }
  }

  // Hub favorites grid is oldest-first; reverse so import stamps match bookmarks (newest-first).
  ids.reverse()
  return ids
}

async function importResourceIds(resourceIds, { source, onProgress }) {
  const existing = new Set(getWishlistIds().map(String))
  const toImport = resourceIds.filter((id) => !existing.has(String(id)))

  let added = 0
  const skipped = resourceIds.length - toImport.length
  let failed = 0
  let completed = 0
  const total = toImport.length
  const baseCreatedAt = Math.max(Math.floor(Date.now() / 1000), nextImportCreatedAt)
  nextImportCreatedAt = baseCreatedAt + total
  // Lists are newest-first; stamp monotonic times so wishlist `created_at DESC` matches.
  const createdAtByRid = new Map(toImport.map((rid, i) => [String(rid), baseCreatedAt + (total - 1 - i)]))

  onProgress?.({ phase: 'import', source, current: 0, total, added, skipped, failed })

  if (total === 0) return { source, found: resourceIds.length, added, skipped, failed }

  const limit = pLimit(DETAIL_CONCURRENCY)
  await Promise.all(
    toImport.map((rid) =>
      limit(async () => {
        try {
          const detail = await getResourceDetail(rid)
          addWishlistItem(rid, detail, { createdAt: createdAtByRid.get(String(rid)) })
          void prefetchHubResThumbnail(rid, detail?.image_url)
          added++
        } catch (err) {
          console.warn(`[wishlist-import] detail failed for ${rid}:`, err.message)
          failed++
        } finally {
          completed++
          onProgress?.({ phase: 'import', source, current: completed, total, added, skipped, failed })
        }
      }),
    ),
  )

  if (added > 0) notify('wishlist:updated', { membership: true })
  return { source, found: resourceIds.length, added, skipped, failed }
}

/** Broadcast import progress to renderers/peers. */
function reportProgress(data) {
  notify('wishlist:import-progress', data)
}

/**
 * Scrape Hub bookmarks/favorites for resource ids using the local persist:hub
 * session (must run on the machine with the Hub webview cookies).
 * @param {'bookmarks'|'favorites'} source
 */
export async function collectHubListResourceIds(source) {
  const resourceIds =
    source === 'bookmarks'
      ? await collectBookmarkResourceIds(reportProgress)
      : await collectFavoriteResourceIds(reportProgress)
  return { source, resourceIds }
}

/**
 * Hydrate Hub resource details (public API) and write wishlist rows.
 * Safe to run on the host that owns the DB — no Hub cookies required.
 * @param {'bookmarks'|'favorites'} source
 */
export async function persistHubListToWishlist(source, resourceIds) {
  if (!resourceIds?.length) return { source, found: 0, added: 0, skipped: 0, failed: 0 }
  return importResourceIds(resourceIds, { source, onProgress: reportProgress })
}
