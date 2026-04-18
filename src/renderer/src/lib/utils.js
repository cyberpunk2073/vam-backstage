import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { VISIBLE_CATEGORIES, isCorePackageCategory } from '../../../shared/content-types.js'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

// --- Procedural gradients ---

function hashStr(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
  return hash
}

export function getGradient(id) {
  const h = hashStr(id)
  const h1 = Math.abs(h % 360)
  const h2 = Math.abs((h * 7) % 360)
  const h3 = Math.abs((h * 13) % 360)
  return `radial-gradient(ellipse at 25% 75%, hsl(${h1} 45% 22%), transparent 55%), radial-gradient(ellipse at 75% 25%, hsl(${h2} 50% 18%), transparent 50%), linear-gradient(135deg, hsl(${h3} 25% 10%), hsl(${(h3 + 60) % 360} 20% 7%))`
}

export function getContentGradient(name, type) {
  const h = hashStr(name + type)
  const base = TYPE_HUE[type] ?? Math.abs(h % 360)
  return `radial-gradient(ellipse at 30% 70%, hsl(${base} 40% 24%), transparent 60%), radial-gradient(ellipse at 70% 30%, hsl(${(base + 40) % 360} 35% 16%), transparent 50%), linear-gradient(160deg, hsl(${base} 20% 10%), hsl(${(base + 30) % 360} 15% 6%))`
}

export function getAuthorColor(author) {
  return `hsl(${Math.abs(hashStr(author) % 360)} 45% 35%)`
}

export function getAuthorInitials(author) {
  const parts = author.split(/[-_\s]/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return author.slice(0, 2).toUpperCase()
}

// --- Content type system ---

const TYPE_HUE = {
  Scenes: 220,
  SubScenes: 210,
  Looks: 330,
  Poses: 25,
  Clothing: 270,
  Hairstyles: 40,
}

export const TYPE_COLORS = {
  Scenes: '#3b82f6',
  SubScenes: '#64839e',
  Looks: '#ec4899',
  Poses: '#f97316',
  Clothing: '#8b5cf6',
  Hairstyles: '#f59e0b',
  /** Aggregated: Hub-only / hidden-only / unknown package types */
  Other: '#64748b',
}

/** Hub Free / Paid chips — hex bases; append `'cc'` for the same ~80% alpha as content-type badges. */
export const HUB_CATEGORY_COLORS = {
  Free: '#34d399',
  /** Warm gold (money / premium); saturated yellow-gold, not brown amber */
  Paid: '#fbbf24',
}

/**
 * Shared footprint for thumbnail overlays and detail-panel chip rows (library type, DEP, content
 * category, legacy/additional tags). Keeps height/padding/text size aligned; use `border-0` on
 * overlays so borders elsewhere don’t change the box.
 */
export const THUMB_CHIP_BOX =
  'inline-flex shrink-0 items-center justify-center h-[18px] min-h-[18px] px-1.5 rounded box-border text-[9px] font-semibold leading-none whitespace-nowrap'

/** Uppercase pills (type, DEP, status, Hub Paid, table type column). */
export const THUMB_OVERLAY_CHIP = `${THUMB_CHIP_BOX} uppercase tracking-wider border-0`

/** Preferred order for lib/content type filters (and Hub type list). */
export const CONTENT_TYPES = VISIBLE_CATEGORIES

/** Library sidebar: core categories plus aggregated Other. */
export const LIBRARY_FILTER_TYPES = [...CONTENT_TYPES, 'Other']

export const isCoreLibraryCategory = isCorePackageCategory

/** Card / table badge: core category name or Other. */
export function libraryTypeBadgeLabel(type) {
  return isCoreLibraryCategory(type) ? type : 'Other'
}

export function libraryTypeBadgeColor(type) {
  return TYPE_COLORS[libraryTypeBadgeLabel(type)]
}

/** Sort by library badge (core order, then Other bucket by raw type string). */
export function compareLibraryPackageTypes(a, b) {
  const la = libraryTypeBadgeLabel(a)
  const lb = libraryTypeBadgeLabel(b)
  if (la !== lb) {
    if (la === 'Other') return 1
    if (lb === 'Other') return -1
    return compareContentTypes(la, lb)
  }
  if (la === 'Other') return String(a || '').localeCompare(String(b || ''))
  return 0
}

const CONTENT_SORT_ORDER = [...CONTENT_TYPES.flatMap((t) => (t === 'Scenes' ? [t, 'SubScenes'] : [t]))]

/** Sort type names for display (filters, grouped lists). Unknown types sort last, then A–Z. */
export function compareContentTypes(a, b) {
  const ia = CONTENT_SORT_ORDER.indexOf(a)
  const ib = CONTENT_SORT_ORDER.indexOf(b)
  const fb = CONTENT_SORT_ORDER.length
  const na = ia >= 0 ? ia : fb
  const nb = ib >= 0 ? ib : fb
  if (na !== nb) return na - nb
  return String(a).localeCompare(String(b))
}

/** Colour for a content type — looks up the curated map, falls back to a stable procedural hue. */
export function getTypeColor(type) {
  return TYPE_COLORS[type] ?? `hsl(${Math.abs(hashStr(type) % 360)} 45% 50%)`
}

// --- External-link helpers ---

const DOMAIN_NAMES = {
  'patreon.com': 'Patreon',
  'gumroad.com': 'Gumroad',
  'booth.pm': 'Booth',
  'ko-fi.com': 'Ko-fi',
  'subscribestar.adult': 'SubscribeStar',
}

export function extractDomainLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    const name = DOMAIN_NAMES[host]
    return name ? `Get on ${name}` : 'Get Package'
  } catch {
    return 'Get Package'
  }
}

// --- Display helpers ---

export function displayName(pkg) {
  if (pkg.hubDisplayName) return pkg.hubDisplayName
  if (pkg.title) return pkg.title
  const name = pkg.packageName || pkg.filename
  const dotIdx = name.indexOf('.')
  return dotIdx > 0 ? name.slice(dotIdx + 1) : name
}

// --- String helpers ---

/** Truncate with ellipsis in the middle, preserving start and end of the string. */
export function middleTruncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str
  const tail = Math.floor((maxLen - 1) / 2)
  const head = maxLen - 1 - tail
  return str.slice(0, head) + '\u2026' + str.slice(str.length - tail)
}

// --- Formatters ---

export function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return n.toString()
}

/** Hub star average: at most one decimal (e.g. 4, 4.9); avoids long floats from the API. */
export function formatStarRating(rating) {
  const n = typeof rating === 'string' ? parseFloat(rating) : Number(rating)
  if (!Number.isFinite(n)) return '0'
  const rounded = Math.round(n * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export function formatDate(timestamp) {
  if (!timestamp) return '—'
  const d = new Date(Number(timestamp) * 1000)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

const NBSP = '\u00A0'

/** Binary (1024) size; picks the largest unit so the value is in [1, 1024). */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return `0${NBSP}B`
  if (n === 0) return `0${NBSP}B`
  const k = 1024
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (i < units.length - 1 && v >= k) {
    v /= k
    i++
  }
  if (i === 0) return `${Math.round(v)}${NBSP}B`
  const s = v >= 100 ? String(Math.round(v)) : String(Number(v.toFixed(1)))
  return `${s}${NBSP}${units[i]}`
}
