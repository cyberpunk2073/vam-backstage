import { getAllPackages, getAllContents, getHubResource, getAllHubResourceJsons } from './db.js'
import { getCachedDetail } from './hub/client.js'
import {
  buildGroupIndex,
  buildForwardDeps,
  buildReverseDeps,
  computeRemovableDeps,
  computeCascadeDisable,
  computeOrphanCascade,
  getTransitiveDeps,
  parseDepRef,
} from './scanner/graph.js'
import {
  canonicalizeLicense,
  COMMERCIAL_USE_ALLOWED_LICENSE_FILTER,
  isCommercialUseAllowed,
} from '../shared/licenses.js'
import {
  categoryOf,
  isCorePackageCategory,
  isGalleryVisible,
  isVisible,
  LOOK_ITEM_EXACT_TYPES,
  tagOf,
} from '../shared/content-types.js'
import { haystacksMatchAllTerms, searchAndTerms } from '../shared/search-text.js'
import { getPackagesIndex, loadPackagesJsonFromCache } from './hub/packages-json.js'
import { isLocalPackage } from '../shared/local-package.js'

/**
 * Iterate packages excluding the synthetic `__local__` sentinel that owns loose
 * Saves/Custom content. Use everywhere we surface package data (Library, facets,
 * stats, counts) so the sentinel never appears as a card or affects totals.
 * Internal graph/content-by-package lookups still see it via `packageIndex` so
 * sentinel-owned content rows can resolve their owner without a special case.
 */
function* userPackageEntries() {
  for (const entry of packageIndex) {
    if (isLocalPackage(entry[0])) continue
    yield entry
  }
}

function userPackageValues() {
  const arr = []
  for (const [, pkg] of userPackageEntries()) arr.push(pkg)
  return arr
}

/** Scanned / Hub `type` column, optionally replaced by user `type_override`. */
export function effectivePackageType(pkg) {
  if (!pkg) return null
  const o = pkg.type_override
  if (o != null && o !== '') return o
  return pkg.type ?? null
}

/** Hub resource `type` string (e.g. Plugins) from DB cache or in-memory Hub detail LRU. */
function hubReportedType(resourceId) {
  if (!resourceId) return null
  const row = getHubResource(String(resourceId))
  if (row?.hub_json) {
    try {
      const j = JSON.parse(row.hub_json)
      const t = typeof j.type === 'string' ? j.type.trim() : ''
      if (t) return t
    } catch {}
  }
  const d = getCachedDetail(resourceId)
  const t = typeof d?.type === 'string' ? d.type.trim() : ''
  return t || null
}

// --- Core indexes (module-level state) ---
let packageIndex = new Map() // filename -> package row
let groupIndex = new Map() // packageName -> [filenames]
let forwardDeps = new Map() // filename -> [{ref, resolved, resolution}]
let reverseDeps = new Map() // filename -> Set<filename>
let contentItems = [] // all content rows with prefs merged
let contentItemsDeduped = [] // contentItems with cross-version duplicates removed (highest version wins)
let contentByPackage = new Map() // filename -> content item[]
let prefsMap = new Map() // "filename/internalPath" -> { hidden, favorite }
let removableSizeMap = new Map() // filename -> removableSize (orphaned dep bytes)
let morphCountByPackage = new Map() // filename -> number of morphBinary items in that package
let lookItemCountByPackage = new Map() // filename -> count of look / legacyLook / skinPreset items
let aggregateMorphCountMap = new Map() // filename -> morph count (own + all resolved deps)
let transitiveDepsCountMap = new Map() // filename -> total unique deps (resolved + missing) in subtree
let transitiveMissingMap = new Map() // filename -> count of unique missing dep refs in subtree
let creatorsNeedingUserId = new Map() // normalized creator → filenames[]
let orphanSet = new Set() // filenames of all orphan deps (direct + cascade)
let directOrphanSet = new Set() // filenames of direct orphans only (zero reverse deps)
let tagCounts = {} // tag (lowercase) → count of packages that have it
let authorCounts = {} // creator string → count of packages with that creator
let nonDownloadableRids = new Set() // resource IDs known to be non-downloadable
let stats = emptyStats()

function emptyStats() {
  return {
    directCount: 0,
    depCount: 0,
    totalCount: 0,
    brokenCount: 0,
    totalContent: 0,
    totalSize: 0,
    directSize: 0,
    depSize: 0,
    contentByType: {},
    missingDepCount: 0,
  }
}

// --- Non-downloadable resource tracking ---

function tryParse(json) {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function isRealUrl(v) {
  return v && v !== 'null' && !String(v).endsWith('?file=')
}

function buildNonDownloadableRids() {
  nonDownloadableRids = new Set()
  for (const row of getAllHubResourceJsons()) {
    const detail = tryParse(row.hub_json)
    const search = tryParse(row.search_json)
    const find = tryParse(row.find_json)

    if (detail?._unavailable) {
      nonDownloadableRids.add(row.resource_id)
      continue
    }
    const category = detail?.category || search?.category
    if (category === 'Paid') {
      nonDownloadableRids.add(row.resource_id)
      continue
    }
    const dlFlag = detail?.hubDownloadable
    if (dlFlag === false || dlFlag === 'false') {
      nonDownloadableRids.add(row.resource_id)
      continue
    }
    if (find && !isRealUrl(find.downloadUrl) && !isRealUrl(find.urlHosted)) {
      nonDownloadableRids.add(row.resource_id)
    }
  }
}

export function isNotDownloadable(pkg) {
  let cdnIndex = getPackagesIndex()
  if (!cdnIndex) {
    loadPackagesJsonFromCache()
    cdnIndex = getPackagesIndex()
  }
  if (!cdnIndex) return false
  if (!cdnIndex.has(pkg.package_name)) return true
  if (pkg.hub_resource_id && nonDownloadableRids.has(String(pkg.hub_resource_id))) return true
  return false
}

// --- Build from DB ---

export function buildFromDb({ skipGraph = false } = {}) {
  const pkgRows = getAllPackages()
  const contentRows = getAllContents()

  packageIndex = new Map()
  for (const row of pkgRows) packageIndex.set(row.filename, row)

  if (!skipGraph) {
    groupIndex = buildGroupIndex(packageIndex)
    forwardDeps = buildForwardDeps(packageIndex, groupIndex)
    reverseDeps = buildReverseDeps(forwardDeps)
  }

  const allContentItems = contentRows.map((row) => {
    const pkg = packageIndex.get(row.package_filename)
    const prefsKey = row.package_filename + '/' + row.internal_path
    const prefs = prefsMap.get(prefsKey) || { hidden: false, favorite: false }
    return {
      ...row,
      hidden: prefs.hidden,
      favorite: prefs.favorite,
      category: categoryOf(row.type),
      tag: tagOf(row.type),
      creator: pkg?.creator ?? '',
      packageName: pkg?.package_name ?? '',
      packageTitle: pkg?.title ?? '',
      packageHubDisplayName: pkg?.hub_display_name ?? null,
      hubTags: pkg?.hub_tags ?? null,
      isDirect: !!pkg?.is_direct,
      isEnabled: !!pkg?.is_enabled,
      first_seen_at: pkg?.first_seen_at ?? 0,
    }
  })
  const managedItems = allContentItems.filter((c) => c.category !== null)
  contentItems = managedItems.filter((c) => isGalleryVisible(c.type))

  morphCountByPackage = new Map()
  lookItemCountByPackage = new Map()
  for (const item of allContentItems) {
    if (item.type === 'morphBinary') {
      morphCountByPackage.set(item.package_filename, (morphCountByPackage.get(item.package_filename) || 0) + 1)
    }
    if (LOOK_ITEM_EXACT_TYPES.has(item.type)) {
      lookItemCountByPackage.set(item.package_filename, (lookItemCountByPackage.get(item.package_filename) || 0) + 1)
    }
  }

  contentByPackage = new Map()
  for (const item of managedItems) {
    let arr = contentByPackage.get(item.package_filename)
    if (!arr) {
      arr = []
      contentByPackage.set(item.package_filename, arr)
    }
    arr.push(item)
  }

  // Deduplicate content across package versions: for each (packageName, category, display_name)
  // that appears in multiple versions, keep only the item from the highest version.
  const multiVersionNames = new Set()
  for (const [name, filenames] of groupIndex) {
    if (filenames.length > 1) multiVersionNames.add(name)
  }
  if (multiVersionNames.size > 0) {
    const bestByKey = new Map()
    const excludeIds = new Set()
    for (const item of contentItems) {
      if (!multiVersionNames.has(item.packageName)) continue
      const key = item.packageName + '\0' + item.category + '\0' + item.display_name
      const existing = bestByKey.get(key)
      if (!existing) {
        bestByKey.set(key, item)
        continue
      }
      const existingVer = parseInt(packageIndex.get(existing.package_filename)?.version, 10) || 0
      const itemVer = parseInt(packageIndex.get(item.package_filename)?.version, 10) || 0
      if (itemVer > existingVer) {
        excludeIds.add(existing.id)
        bestByKey.set(key, item)
      } else {
        excludeIds.add(item.id)
      }
    }
    contentItemsDeduped = excludeIds.size > 0 ? contentItems.filter((c) => !excludeIds.has(c.id)) : contentItems
  } else {
    contentItemsDeduped = contentItems
  }

  computeTransitiveMissing()
  computeStats()
  computeAllRemovableSizes()
  computeAllMorphCounts()
  computeOrphanSets()
  buildNonDownloadableRids()

  creatorsNeedingUserId = new Map()
  for (const [filename, pkg] of userPackageEntries()) {
    if (pkg.hub_user_id) continue
    const key = pkg.creator.toLowerCase()
    let arr = creatorsNeedingUserId.get(key)
    if (!arr) {
      arr = []
      creatorsNeedingUserId.set(key, arr)
    }
    arr.push(filename)
  }

  tagCounts = {}
  for (const pkg of userPackageValues()) {
    if (!pkg.hub_tags) continue
    for (const raw of pkg.hub_tags.split(',')) {
      const t = raw.trim().toLowerCase()
      if (t) tagCounts[t] = (tagCounts[t] || 0) + 1
    }
  }

  authorCounts = {}
  for (const pkg of userPackageValues()) {
    const a = typeof pkg.creator === 'string' ? pkg.creator.trim() : ''
    if (a) authorCounts[a] = (authorCounts[a] || 0) + 1
  }
}

function computeAllRemovableSizes() {
  removableSizeMap = new Map()
  for (const filename of packageIndex.keys()) {
    const { removableSize } = computeRemovableDeps(filename, packageIndex, forwardDeps, reverseDeps)
    if (removableSize > 0) removableSizeMap.set(filename, removableSize)
  }
}

function computeAllMorphCounts() {
  aggregateMorphCountMap = new Map()
  transitiveDepsCountMap = new Map()
  for (const filename of packageIndex.keys()) {
    const transitiveDeps = getTransitiveDeps(filename, forwardDeps)
    let morphs = morphCountByPackage.get(filename) || 0
    for (const dep of transitiveDeps) {
      morphs += morphCountByPackage.get(dep) || 0
    }
    if (morphs > 0) aggregateMorphCountMap.set(filename, morphs)
    const depTotal = transitiveDeps.size + (transitiveMissingMap.get(filename) || 0)
    if (depTotal > 0) transitiveDepsCountMap.set(filename, depTotal)
  }
}

function computeOrphanSets() {
  const result = computeOrphanCascade(packageIndex, forwardDeps, reverseDeps)
  orphanSet = result.orphans
  directOrphanSet = result.directOrphans
}

function computeTransitiveMissing() {
  transitiveMissingMap = new Map()
  const memo = new Map()
  function collect(filename) {
    if (memo.has(filename)) return memo.get(filename)
    const refs = new Set()
    memo.set(filename, refs)
    for (const dep of forwardDeps.get(filename) || []) {
      if (!dep.resolved) {
        refs.add(dep.ref)
      } else {
        for (const r of collect(dep.resolved)) refs.add(r)
      }
    }
    return refs
  }
  for (const filename of packageIndex.keys()) {
    const refs = collect(filename)
    if (refs.size > 0) transitiveMissingMap.set(filename, refs.size)
  }
}

function computeStats() {
  let directCount = 0,
    depCount = 0,
    totalCount = 0,
    totalSize = 0,
    directSize = 0,
    depSize = 0,
    brokenCount = 0
  const contentByType = {}

  for (const [filename, pkg] of userPackageEntries()) {
    totalCount++
    if (pkg.is_direct) {
      directCount++
      directSize += pkg.size_bytes
    } else {
      depCount++
      depSize += pkg.size_bytes
    }
    totalSize += pkg.size_bytes
    if ((transitiveMissingMap.get(filename) || 0) > 0 || pkg.is_corrupted) brokenCount++
  }

  let depContentCount = 0
  for (const item of contentItems) {
    contentByType[item.category] = (contentByType[item.category] || 0) + 1
    if (!item.isDirect) depContentCount++
  }

  let missingDepCount = 0
  for (const deps of forwardDeps.values()) {
    for (const d of deps) {
      if (!d.resolved || d.resolution === 'fallback') missingDepCount++
    }
  }

  stats = {
    directCount,
    depCount,
    totalCount,
    brokenCount,
    totalContent: contentItems.length,
    totalSize,
    directSize,
    depSize,
    contentByType,
    missingDepCount,
    depContentCount,
  }
}

// --- Accessors ---

export function getPackageIndex() {
  return packageIndex
}
export function getGroupIndex() {
  return groupIndex
}
export function getForwardDeps() {
  return forwardDeps
}
export function getTransitiveMissingRefs(filename, { includeFallbacks = false } = {}) {
  const visited = new Set()
  const refs = new Set()
  const queue = [filename]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const dep of forwardDeps.get(current) || []) {
      if (!dep.resolved) {
        refs.add(dep.ref)
      } else {
        if (includeFallbacks && dep.resolution === 'fallback') refs.add(dep.ref)
        if (!visited.has(dep.resolved)) {
          visited.add(dep.resolved)
          queue.push(dep.resolved)
        }
      }
    }
  }
  return refs
}
export function getReverseDeps() {
  return reverseDeps
}
export function getStats() {
  return stats
}
export function getCreatorsNeedingUserId() {
  return creatorsNeedingUserId
}
export function getTagCounts() {
  return tagCounts
}

export function getAuthorCounts() {
  return authorCounts
}

export function getContentByPackage() {
  return contentByPackage
}
export function getPrefsMap() {
  return prefsMap
}
export function setPrefsMap(map) {
  prefsMap = map
  for (const items of contentByPackage.values()) {
    for (const item of items) {
      const key = item.package_filename + '/' + item.internal_path
      const prefs = prefsMap.get(key) || { hidden: false, favorite: false }
      item.hidden = prefs.hidden
      item.favorite = prefs.favorite
    }
  }
}

export function updatePref(packageFilename, internalPath, field, value) {
  const key = packageFilename + '/' + internalPath
  let entry = prefsMap.get(key)
  if (!entry) {
    entry = { hidden: false, favorite: false }
    prefsMap.set(key, entry)
  }
  entry[field] = value
  const items = contentByPackage.get(packageFilename)
  if (!items) return
  for (const item of items) {
    if (item.internal_path === internalPath) {
      item[field] = value
      break
    }
  }
}

// --- Filtered queries ---

export function getFilteredPackages(filters = {}) {
  let results = userPackageValues()

  if (filters.search?.trim()) {
    const terms = searchAndTerms(filters.search)
    results = results.filter((p) => haystacksMatchAllTerms([p.filename, p.creator, p.title, p.hub_display_name], terms))
  }
  if (filters.status === 'direct') results = results.filter((p) => p.is_direct)
  else if (filters.status === 'dependency') results = results.filter((p) => !p.is_direct)
  else if (filters.status === 'broken') {
    results = results.filter((p) => (transitiveMissingMap.get(p.filename) || 0) > 0 || p.is_corrupted)
  } else if (filters.status === 'orphan') {
    results = results.filter((p) => orphanSet.has(p.filename))
  } else if (filters.status === 'local') {
    results = results.filter((p) => isNotDownloadable(p))
  }
  if (filters.types?.length) {
    const typeSet = new Set(filters.types)
    results = results.filter((p) => {
      const t = effectivePackageType(p)
      const isOther = !isCorePackageCategory(t)
      if (typeSet.has('Other') && isOther) return true
      return t && typeSet.has(t)
    })
  }
  if (filters.license) {
    if (filters.license === COMMERCIAL_USE_ALLOWED_LICENSE_FILTER) {
      results = results.filter((p) => isCommercialUseAllowed(p.license) === true)
    } else {
      const want = canonicalizeLicense(filters.license)
      results = results.filter((p) => canonicalizeLicense(p.license) === want)
    }
  }

  const sort = filters.sort || 'name'
  results.sort((a, b) => {
    if (sort === 'name') return a.filename.localeCompare(b.filename)
    if (sort === 'size') return b.size_bytes - a.size_bytes
    if (sort === 'date') return (b.first_seen_at || 0) - (a.first_seen_at || 0)
    return 0
  })

  return results.map((p) => enrichPackageSummary(p))
}

function enrichPackageSummary(pkg) {
  const depCount = transitiveDepsCountMap.get(pkg.filename) || 0
  const missingDeps = transitiveMissingMap.get(pkg.filename) || 0
  const pkgContents = contentByPackage.get(pkg.filename)
  const contentCount = pkgContents?.length ?? 0
  let favoriteContentCount = 0
  if (pkgContents) {
    for (const c of pkgContents) {
      if (c.favorite) favoriteContentCount++
    }
  }
  const removableSize = removableSizeMap.get(pkg.filename) || 0
  const derivedType = pkg.type ?? null
  const effectiveType = effectivePackageType(pkg)
  const lookItemCount = lookItemCountByPackage.get(pkg.filename) || 0
  const noLookPresetTag = effectiveType === 'Looks' && lookItemCount === 0
  return {
    filename: pkg.filename,
    creator: pkg.creator,
    packageName: pkg.package_name,
    version: pkg.version,
    type: effectiveType,
    derivedType,
    typeOverride: pkg.type_override ?? null,
    title: pkg.title,
    hubDisplayName: pkg.hub_display_name || null,
    description: pkg.description,
    license: pkg.license,
    sizeBytes: pkg.size_bytes,
    removableSize,
    isDirect: !!pkg.is_direct,
    isEnabled: !!pkg.is_enabled,
    hubResourceId: pkg.hub_resource_id,
    hubUserId: pkg.hub_user_id,
    hubTags: pkg.hub_tags || null,
    promotionalLink: pkg.promotional_link || null,
    contentCount,
    favoriteContentCount,
    depCount,
    missingDeps,
    morphCount: aggregateMorphCountMap.get(pkg.filename) || 0,
    firstSeenAt: pkg.first_seen_at,
    isCorrupted: !!pkg.is_corrupted,
    isOrphan: orphanSet.has(pkg.filename),
    isCascadeOrphan: orphanSet.has(pkg.filename) && !directOrphanSet.has(pkg.filename),
    isLocalOnly: isNotDownloadable(pkg),
    noLookPresetTag,
  }
}

/** Recursive DFS dep tree matching VarLens's get_dep_tree. */
function buildDepTree(rootFilename, visited = new Set()) {
  if (visited.has(rootFilename)) return []
  visited.add(rootFilename)
  const deps = forwardDeps.get(rootFilename) || []
  return deps.map((d) => {
    const depPkg = d.resolved ? packageIndex.get(d.resolved) : null
    const children = d.resolved ? buildDepTree(d.resolved, visited) : []
    return {
      ref: d.ref,
      resolved: d.resolved,
      resolution: d.resolution,
      filename: d.resolved,
      creator: depPkg?.creator,
      packageName: depPkg?.package_name,
      version: depPkg?.version,
      type: depPkg ? effectivePackageType(depPkg) : undefined,
      sizeBytes: depPkg?.size_bytes,
      isDirect: depPkg ? !!depPkg.is_direct : false,
      isEnabled: depPkg ? !!depPkg.is_enabled : true,
      children,
    }
  })
}

export function getPackageDetail(filename) {
  if (isLocalPackage(filename)) return null
  const pkg = packageIndex.get(filename)
  if (!pkg) return null

  const deps = buildDepTree(filename)

  const dependentFilenames = reverseDeps.get(filename) || new Set()
  const dependents = [...dependentFilenames].map((fn) => {
    const dp = packageIndex.get(fn)
    return dp
      ? { filename: fn, creator: dp.creator, packageName: dp.package_name, version: dp.version }
      : { filename: fn }
  })

  const contents = (contentByPackage.get(filename) || [])
    .filter((c) => isVisible(c.type))
    .map((c) => ({
      id: c.id,
      packageFilename: c.package_filename,
      internalPath: c.internal_path,
      displayName: c.display_name,
      type: c.type,
      category: categoryOf(c.type),
      tag: tagOf(c.type),
      hidden: c.hidden,
      favorite: c.favorite,
      thumbnailPath: c.thumbnail_path,
    }))

  const { removableFilenames, removableSize } = computeRemovableDeps(filename, packageIndex, forwardDeps, reverseDeps)

  const removableDeps = [...removableFilenames]
    .filter((f) => f !== filename)
    .map((f) => {
      const p = packageIndex.get(f)
      return {
        filename: f,
        name: p?.package_name?.split('.').pop() || f,
        sizeBytes: p?.size_bytes || 0,
        isLocalOnly: p ? isNotDownloadable(p) : false,
      }
    })

  const cascadeDisableDeps = pkg.is_enabled
    ? [...computeCascadeDisable(filename, packageIndex, forwardDeps, reverseDeps)].map((f) => {
        const p = packageIndex.get(f)
        return { filename: f, name: p?.package_name?.split('.').pop() || f }
      })
    : []

  const hubType = hubReportedType(pkg.hub_resource_id)

  return {
    ...enrichPackageSummary(pkg),
    hubType,
    description: pkg.description,
    deps,
    depsTotal: transitiveDepsCountMap.get(filename) || 0,
    missingDepsTotal: transitiveMissingMap.get(filename) || 0,
    dependents,
    contents,
    removableSize,
    removableDepsCount: removableFilenames.size,
    removableDeps,
    cascadeDisableDeps,
  }
}

export function getFilteredContents(filters = {}) {
  let results = [...(filters.packageFilename ? contentItems : contentItemsDeduped)]

  if (filters.search?.trim()) {
    const terms = searchAndTerms(filters.search)
    results = results.filter((c) => haystacksMatchAllTerms([c.display_name, c.package_filename, c.creator], terms))
  }
  if (filters.types?.length) {
    const typeSet = new Set(filters.types)
    results = results.filter((c) => typeSet.has(c.category))
  }
  if (filters.visibility === 'visible') results = results.filter((c) => !c.hidden)
  else if (filters.visibility === 'hidden') results = results.filter((c) => c.hidden)
  else if (filters.visibility === 'favorites') results = results.filter((c) => c.favorite)

  if (filters.packageFilename) results = results.filter((c) => c.package_filename === filters.packageFilename)

  const sort = filters.sort || 'name'
  results.sort((a, b) => {
    if (sort === 'name') return a.display_name.localeCompare(b.display_name)
    if (sort === 'type') return a.category.localeCompare(b.category)
    if (sort === 'package') return a.package_filename.localeCompare(b.package_filename)
    if (sort === 'date') return (b.first_seen_at || 0) - (a.first_seen_at || 0)
    return 0
  })

  return results.map((c) => ({
    id: c.id,
    packageFilename: c.package_filename,
    internalPath: c.internal_path,
    displayName: c.display_name,
    type: c.type,
    category: c.category,
    tag: c.tag,
    hidden: c.hidden,
    favorite: c.favorite,
    thumbnailPath: c.thumbnail_path,
    creator: c.creator,
    packageName: c.packageName,
    packageTitle: c.packageTitle,
    packageHubDisplayName: c.packageHubDisplayName || null,
    hubTags: c.hubTags ?? null,
    isDirect: c.isDirect,
    isEnabled: c.isEnabled,
    firstSeenAt: c.first_seen_at,
    parentPackageType: effectivePackageType(packageIndex.get(c.package_filename)),
  }))
}

// --- Stats for Library filter counts ---

export function getStatusCounts() {
  let direct = 0,
    dependency = 0,
    broken = 0,
    orphan = orphanSet.size,
    local = 0
  for (const [filename, pkg] of userPackageEntries()) {
    if (pkg.is_direct) direct++
    else dependency++
    if ((transitiveMissingMap.get(filename) || 0) > 0 || pkg.is_corrupted) broken++
    if (isNotDownloadable(pkg)) local++
  }

  const missingGroups = new Set()
  for (const [filename] of userPackageEntries()) {
    for (const d of forwardDeps.get(filename) || []) {
      if (d.resolved && d.resolution !== 'fallback') continue
      const parsed = parseDepRef(d.ref)
      missingGroups.add(parsed ? parsed.packageName : d.ref)
    }
  }

  return { direct, dependency, broken, orphan, local, missingUnique: missingGroups.size }
}

export function getOrphanSet() {
  return orphanSet
}

export function getOrphanTotalSize() {
  let total = 0
  for (const fn of orphanSet) {
    const pkg = packageIndex.get(fn)
    if (pkg) total += pkg.size_bytes
  }
  return total
}

/**
 * Aggregate missing and fallback dep refs across all packages, one row per ref.
 * When `hubPackagesIndex` / `hubFilenameIndex` (from packages.json) are provided,
 * each row is enriched with hub availability so the renderer doesn't need a separate API call.
 */
export function getMissingDeps(hubPackagesIndex, hubFilenameIndex) {
  const groups = new Map() // ref -> { neededBy: Set, parsed, fallbackVersion }
  for (const [filename] of userPackageEntries()) {
    for (const d of forwardDeps.get(filename) || []) {
      if (d.resolved && d.resolution !== 'fallback') continue
      const parsed = parseDepRef(d.ref)
      const key = d.ref
      let group = groups.get(key)
      if (!group) {
        group = { neededBy: new Set(), parsed, fallbackVersion: null }
        groups.set(key, group)
      }
      group.neededBy.add(filename)
      if (d.resolution === 'fallback' && d.resolved && !group.fallbackVersion) {
        const fb = packageIndex.get(d.resolved)
        if (fb) group.fallbackVersion = fb.version
      }
    }
  }

  return [...groups.entries()].map(([ref, g]) => {
    const row = {
      ref,
      packageName: g.parsed?.packageName ?? ref,
      creator: g.parsed?.creator ?? ref.split('.')[0] ?? '',
      version: g.parsed?.version ?? null,
      minVersion: g.parsed?.minVersion ?? null,
      displayName: g.parsed ? g.parsed.packageName.split('.').pop() : ref,
      neededBy: [...g.neededBy].map((fn) => {
        const p = packageIndex.get(fn)
        return { filename: fn, name: p?.package_name?.split('.').pop() || fn }
      }),
      isFallback: !!g.fallbackVersion,
      fallbackVersion: g.fallbackVersion,
      // Hub availability (populated below when indexes are available)
      hub: null,
    }

    if (!hubPackagesIndex || !hubFilenameIndex) return row

    // Try exact filename first (ref + ".var")
    const exactFilename = ref + '.var'
    const exactResId = hubFilenameIndex.get(exactFilename)
    if (exactResId != null) {
      row.hub = { filename: exactFilename, resourceId: String(exactResId), isExact: true }
      return row
    }

    // Exact version not on Hub — check if the group has any version
    const pName = g.parsed?.packageName
    if (!pName) return row
    const hubEntry = hubPackagesIndex.get(pName)
    if (!hubEntry) return row

    // Hub has a (likely newer) version for this group
    const localMatch = packageIndex.get(hubEntry.filename)
    if (localMatch) {
      // Already installed locally — this dep is effectively resolved via fallback.
      // Mark it so the UI can show "fallback" status rather than "Install".
      row.hub = {
        filename: hubEntry.filename,
        resourceId: String(hubEntry.resourceId),
        isExact: false,
        installedLocally: true,
        hubVersion: hubEntry.version,
      }
    } else {
      // Hub has a version we don't have — offer it as a fallback install
      row.hub = {
        filename: hubEntry.filename,
        resourceId: String(hubEntry.resourceId),
        isExact: false,
        installedLocally: false,
        hubVersion: hubEntry.version,
      }
    }

    return row
  })
}

export function getTypeCounts() {
  const counts = {}
  for (const pkg of userPackageValues()) {
    const t = effectivePackageType(pkg)
    if (t) counts[t] = (counts[t] || 0) + 1
  }
  return counts
}

export function getContentTypeCounts() {
  const counts = {}
  for (const c of contentItems) counts[c.category] = (counts[c.category] || 0) + 1
  return counts
}

export function getContentVisibilityCounts() {
  let all = 0,
    visible = 0,
    hidden = 0,
    favorites = 0
  for (const c of contentItems) {
    all++
    if (c.hidden) hidden++
    else visible++
    if (c.favorite) favorites++
  }
  return { all, visible, hidden, favorites }
}

// --- Hub cross-referencing ---

export function findLocalByHubResourceId(resourceId) {
  const rid = String(resourceId)
  for (const pkg of userPackageValues()) {
    if (pkg.hub_resource_id === rid) return pkg
  }
  return null
}

export function findLocalByFilename(filename) {
  if (isLocalPackage(filename)) return null
  return packageIndex.get(filename) || null
}

// --- Mutation helpers (called by IPC handlers after DB writes) ---

export function patchTypeOverride(filename, typeOverride) {
  const pkg = packageIndex.get(filename)
  if (pkg) pkg.type_override = typeOverride ?? null
}

export function patchEnabled(filenames, newEnabled) {
  const val = newEnabled ? 1 : 0
  for (const fn of filenames) {
    const pkg = packageIndex.get(fn)
    if (pkg) pkg.is_enabled = val
    const items = contentByPackage.get(fn)
    if (items) for (const item of items) item.isEnabled = newEnabled
  }
}

/** Reload packageIndex from DB and rebuild the dependency graph only.
 *  Skips content arrays, dedup, stats, and all expensive aggregates.
 *  Use when you need an up-to-date graph for intermediate computation
 *  and a full buildFromDb() will follow later. */
export function buildGraphOnly() {
  const pkgRows = getAllPackages()
  packageIndex = new Map()
  for (const row of pkgRows) packageIndex.set(row.filename, row)
  groupIndex = buildGroupIndex(packageIndex)
  forwardDeps = buildForwardDeps(packageIndex, groupIndex)
  reverseDeps = buildReverseDeps(forwardDeps)
}

export function refreshPackage() {
  // Refetch single package's data and recompute graphs
  // For simplicity, just rebuild everything — fine for single mutations
  buildFromDb()
}

export function refreshAll() {
  buildFromDb()
}
