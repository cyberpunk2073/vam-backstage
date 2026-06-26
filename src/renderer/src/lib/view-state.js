export const VIEW_STATE_VERSION = 1
export const LAST_VIEW_KEY = 'ui:last_view'
export const HUB_STATE_KEY = 'ui:hub_state'
export const LIBRARY_STATE_KEY = 'ui:library_state'
export const CONTENT_STATE_KEY = 'ui:content_state'

const VALID_VIEWS = new Set(['hub', 'library', 'content', 'settings'])
const VALID_PAID = new Set(['all', 'free', 'paid'])
const VALID_LIBRARY_STATUS = new Set(['direct', 'deps', 'missing', 'orphans', 'disabled', 'all', 'updates'])
const VALID_ENABLED = new Set(['all', 'enabled', 'disabled', 'offloaded'])
const VALID_PACKAGE_FILTER = new Set(['all', 'direct', 'deps', 'local'])
const VALID_PACKAGE_STATUS = new Set(['all', 'enabled', 'disabled', 'offloaded'])
const VALID_VISIBILITY = new Set(['all', 'visible', 'hidden', 'favorites'])

const s = (value, fallback = '') => (typeof value === 'string' ? value : fallback)
const strings = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === 'string') : [])
const ints = (value) => (Array.isArray(value) ? value.filter((x) => Number.isInteger(x)) : [])
const id = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : null)

export function sanitizeLastView(value) {
  return VALID_VIEWS.has(value) ? value : 'library'
}

export function sanitizeHubState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    search: s(r.search),
    selectedType: s(r.selectedType, 'All') || 'All',
    paidFilter: VALID_PAID.has(r.paidFilter) ? r.paidFilter : 'all',
    authorSearch: s(r.authorSearch),
    selectedHubTags: strings(r.selectedHubTags),
    sort: s(r.sort),
    license: s(r.license, 'Any') || 'Any',
    detailResourceId: id(r.detailResourceId),
  }
}

export function sanitizeLibraryState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    search: s(r.search),
    authorSearch: s(r.authorSearch),
    statusFilter: VALID_LIBRARY_STATUS.has(r.statusFilter) ? r.statusFilter : 'direct',
    enabledFilter: VALID_ENABLED.has(r.enabledFilter) ? r.enabledFilter : 'all',
    selectedTypes: strings(r.selectedTypes),
    selectedTags: strings(r.selectedTags),
    selectedLabelIds: ints(r.selectedLabelIds),
    primarySort: s(r.primarySort, 'Type') || 'Type',
    secondarySort: s(r.secondarySort, 'Recently installed') || 'Recently installed',
    license: s(r.license, 'Any') || 'Any',
    selectedFilename: s(r.selectedFilename, null),
  }
}

export function sanitizeContentState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    search: s(r.search),
    authorSearch: s(r.authorSearch),
    selectedTypes: strings(r.selectedTypes),
    selectedPackageTypes: strings(r.selectedPackageTypes),
    selectedTags: strings(r.selectedTags),
    selectedLabelIds: ints(r.selectedLabelIds),
    packageFilter: VALID_PACKAGE_FILTER.has(r.packageFilter) ? r.packageFilter : 'all',
    packageStatusFilter: VALID_PACKAGE_STATUS.has(r.packageStatusFilter) ? r.packageStatusFilter : 'enabled',
    visibilityFilter: VALID_VISIBILITY.has(r.visibilityFilter) ? r.visibilityFilter : 'visible',
    primarySort: s(r.primarySort, 'Type') || 'Type',
    secondarySort: s(r.secondarySort, 'Recently installed') || 'Recently installed',
    selectedItemId:
      typeof r.selectedItemId === 'number' || typeof r.selectedItemId === 'string' ? r.selectedItemId : null,
    selectedPackageFilename: s(r.selectedPackageFilename, null),
  }
}

function defaultSettingsApi() {
  return typeof window !== 'undefined' ? window.api?.settings : null
}

export async function readSettingJson(key, fallback, settingsApi = defaultSettingsApi()) {
  try {
    if (!settingsApi?.get) return fallback
    const raw = await settingsApi.get(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export async function writeSettingJson(key, value, settingsApi = defaultSettingsApi()) {
  if (!settingsApi?.set) return
  await settingsApi.set(key, JSON.stringify(value))
}

export function debounce(fn, delayMs = 300) {
  let timer = null
  return (...args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, delayMs)
  }
}
