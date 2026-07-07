/** User-Agent for Hub and related HTTP requests from VaM Backstage. */
export const HUB_HTTP_USER_AGENT = 'VaMBackstage/1.0'

/** Hub resource-icon CDN base. Icons are sharded into folders by floor(id/1000). */
const HUB_RESOURCE_ICON_CDN = 'https://1424104733.rsc.cdn77.org/data/resource_icons'

/** CDN URL for a Hub resource's icon, or null for an invalid resource id. */
export function hubResourceIconUrl(resourceId) {
  const n = Number(resourceId)
  if (!Number.isFinite(n) || n <= 0) return null
  return `${HUB_RESOURCE_ICON_CDN}/${Math.floor(n / 1000)}/${n}.jpg`
}
