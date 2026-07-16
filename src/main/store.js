import {
  getAllPackages,
  getAllContents,
  getHubResource,
  getAllHubResourceJsons,
  getAllLabels,
  getAllLabelPackages,
  getAllLabelContents,
} from './db.js'
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
import { categoryOf, isGalleryVisible, isVisible, LOOK_ITEM_EXACT_TYPES, tagOf } from '@shared/content-types.js'
import { getPackagesIndex, loadPackagesJsonFromCache } from './hub/packages-json.js'
import { isLocalPackage } from '@shared/local-package.js'
import { isPackageActive } from '@shared/storage-state-predicates.js'
import {
  packageHasExtractedAppearance,
  contentHasExtractedAppearance,
  APPEARANCE_SOURCE_TYPES,
} from './scenes/extract.js'
import { extractedPresetBasename } from './scenes/extract-targets.js'

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
let extractedAppearanceBasenames = new Set() // basenames of local 'look' rows under Custom/Atom/Person/Appearance/extracted/
let extractedOwnership = new Map() // extracted-preset basename -> Set<packageFilename> (every installed version that could own it)
let extractedByPackage = new Map() // packageFilename -> local extracted content item[] (indexed under every candidate version)
let allExtractedLocalItems = [] // every local extracted preset row, including orphaned ones (empty extractedCandidates)
let aggregateMorphCountMap = new Map() // filename -> morph count (own + all resolved deps)
let transitiveDepsCountMap = new Map() // filename -> total unique deps (resolved + missing) in subtree
let transitiveMissingMap = new Map() // filename -> count of unique missing dep refs in subtree
let transitiveInactiveMap = new Map() // filename -> count of resolved-but-inactive (disabled/offloaded) deps in subtree
let creatorsNeedingUserId = new Map() // normalized creator → filenames[]
let orphanSet = new Set() // filenames of all orphan deps (direct + cascade)
let directOrphanSet = new Set() // filenames of direct orphans only (zero reverse deps)
let tagCounts = {} // tag (lowercase) → count of packages that have it
let authorCounts = {} // creator string → count of packages with that creator
let labelIndex = new Map() // label_id → { id, name, color, packageCount, contentCount }
let labelsByPackage = new Map() // package_filename → number[] of label ids
let labelsByContent = new Map() // `${package_filename}\0${internal_path}` → number[] of label ids
let nonDownloadableRids = new Set() // resource IDs known to be non-downloadable
let stats = emptyStats()

function emptyStats() {
  return {
    directCount: 0,
    depCount: 0,
    totalCount: 0,
    enabledCount: 0,
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

export function isRealUrl(v) {
  return v && v !== 'null' && !String(v).endsWith('?file=')
}

/** Resolve a fetchable download URL from a Hub findPackages / hubFiles entry. */
export function resolveHubDownloadUrl(hubFile) {
  if (isRealUrl(hubFile?.downloadUrl)) return hubFile.downloadUrl
  if (isRealUrl(hubFile?.urlHosted)) return hubFile.urlHosted
  return null
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

// --- Extracted-preset ownership (derived, no persisted state) ---

/** Drop a trailing `.disabled` marker so a disabled loose file matches its live name. */
function stripDisabledSuffix(p) {
  return p.endsWith('.disabled') ? p.slice(0, -'.disabled'.length) : p
}

/** Basename (last path segment) with any `.disabled` marker stripped. */
function extractedBasenameOf(internalPath) {
  const live = stripDisabledSuffix(internalPath)
  return live.slice(live.lastIndexOf('/') + 1)
}

/**
 * Is this local row an extracted preset? Appearance presets live as `look` rows
 * under `Appearance/extracted/`, outfits as `clothingPreset` under
 * `Clothing/extracted/`. The `.disabled` marker (if any) is stripped first.
 */
function isExtractedLocalRow(type, internalPath) {
  const p = stripDisabledSuffix(internalPath)
  if (type === 'look') return p.startsWith('Custom/Atom/Person/Appearance/extracted/')
  if (type === 'clothingPreset') return p.startsWith('Custom/Atom/Person/Clothing/extracted/')
  return false
}

/**
 * Invert the `computeTargets` naming for one scene-source row and register its
 * expected preset basename(s) against the owning package. Every atom of every
 * scene contributes a basename; a basename can be claimed by several installed
 * versions (they all produce the same unversioned filename).
 */
function addExtractedOwnership(map, { creator, internalPath, personAtomIdsJson, packageFilename }) {
  if (!personAtomIdsJson) return
  let atomIds
  try {
    atomIds = JSON.parse(personAtomIdsJson)
  } catch {
    return
  }
  if (!Array.isArray(atomIds) || atomIds.length === 0) return
  const singleAtom = atomIds.length === 1
  for (const atomId of atomIds) {
    const base = extractedPresetBasename({ creator: creator || '!local', internalPath, atomId, singleAtom })
    let set = map.get(base)
    if (!set) {
      set = new Set()
      map.set(base, set)
    }
    set.add(packageFilename)
  }
}

/** Highest installed version among candidate filenames (matches cross-version dedup). */
function highestVersionCandidate(filenames) {
  let best = null
  let bestVer = -1
  for (const fn of filenames) {
    const pkg = packageIndex.get(fn)
    if (!pkg) continue
    const v = parseInt(pkg.version, 10) || 0
    if (best === null || v > bestVer) {
      best = fn
      bestVer = v
    }
  }
  return best
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
    // Prefs bind to the canonical (live) path, so a preset keeps its favorite/
    // hidden state across the `.disabled` marker flipping on/off.
    const prefsKey = row.package_filename + '/' + stripDisabledSuffix(row.internal_path)
    const prefs = prefsMap.get(prefsKey) || { hidden: false, favorite: false }
    return {
      ...row,
      hidden: prefs.hidden,
      favorite: prefs.favorite,
      // A loose file on disk named `X.vap.disabled` (the `.var`-style disable
      // convention applied to extracted presets) carries its state in the name.
      localDisabled: isLocalPackage(row.package_filename) && row.internal_path.endsWith('.disabled'),
      extractedFrom: null,
      category: categoryOf(row.type),
      tag: tagOf(row.type),
      creator: pkg?.creator ?? '',
      packageName: pkg?.package_name ?? '',
      packageTitle: pkg?.title ?? '',
      packageHubDisplayName: pkg?.hub_display_name ?? null,
      hubTags: pkg?.hub_tags ?? null,
      isDirect: !!pkg?.is_direct,
      storageState: pkg?.storage_state ?? 'enabled',
      libraryDirId: pkg?.library_dir_id ?? null,
      first_seen_at: pkg?.first_seen_at ?? 0,
    }
  })
  const managedItems = allContentItems.filter((c) => c.category !== null)
  contentItems = managedItems.filter((c) => isGalleryVisible(c.type))

  morphCountByPackage = new Map()
  lookItemCountByPackage = new Map()
  extractedAppearanceBasenames = new Set()
  extractedOwnership = new Map()
  extractedByPackage = new Map()
  const localExtractedRows = []
  for (const item of allContentItems) {
    if (item.type === 'morphBinary') {
      morphCountByPackage.set(item.package_filename, (morphCountByPackage.get(item.package_filename) || 0) + 1)
    }
    if (LOOK_ITEM_EXACT_TYPES.has(item.type)) {
      lookItemCountByPackage.set(item.package_filename, (lookItemCountByPackage.get(item.package_filename) || 0) + 1)
    }
    // Register the expected preset basename(s) of every packaged scene-source
    // row against its package (any installed version claims the same names).
    if (!isLocalPackage(item.package_filename) && APPEARANCE_SOURCE_TYPES.has(item.type)) {
      addExtractedOwnership(extractedOwnership, {
        creator: item.creator,
        internalPath: item.internal_path,
        personAtomIdsJson: item.person_atom_ids,
        packageFilename: item.package_filename,
      })
    }
    // Local extracted presets: collect now, resolve ownership after the map is
    // fully built. Track appearance basenames for the "no preset" checkmark.
    if (isLocalPackage(item.package_filename) && isExtractedLocalRow(item.type, item.internal_path)) {
      localExtractedRows.push(item)
      if (item.type === 'look') extractedAppearanceBasenames.add(extractedBasenameOf(item.internal_path))
    }
  }

  // Attribute each local extracted preset to the highest installed candidate
  // version, and index it under every candidate so any version's detail panel
  // can list it. Kept separate from `contentByPackage` so it never perturbs
  // package content counts or cross-version dedup.
  for (const item of localExtractedRows) {
    const candidates = extractedOwnership.get(extractedBasenameOf(item.internal_path))
    // Every candidate in `extractedOwnership` is a present package (built from
    // `getAllContents`, which filters tombstones), so a preset whose owning
    // versions were all removed lands here with an empty set — the reconcile
    // reads that as "no active candidate" and disables it.
    item.extractedCandidates = candidates ? [...candidates] : []
    if (!candidates || candidates.size === 0) continue
    const owner = highestVersionCandidate(candidates)
    if (!owner) continue
    item.extractedFrom = owner
    for (const fn of candidates) {
      let arr = extractedByPackage.get(fn)
      if (!arr) {
        arr = []
        extractedByPackage.set(fn, arr)
      }
      arr.push(item)
    }
  }
  allExtractedLocalItems = localExtractedRows

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
  computeTransitiveInactive()
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

  buildLabels()
}

function buildLabels() {
  const labels = getAllLabels()
  labelIndex = new Map()
  for (const l of labels)
    labelIndex.set(l.id, { id: l.id, name: l.name, color: l.color, packageCount: 0, contentCount: 0 })

  labelsByPackage = new Map()
  for (const row of getAllLabelPackages()) {
    if (!labelIndex.has(row.label_id)) continue
    let arr = labelsByPackage.get(row.package_filename)
    if (!arr) {
      arr = []
      labelsByPackage.set(row.package_filename, arr)
    }
    arr.push(row.label_id)
    const entry = labelIndex.get(row.label_id)
    if (entry) entry.packageCount++
  }

  labelsByContent = new Map()
  for (const row of getAllLabelContents()) {
    if (!labelIndex.has(row.label_id)) continue
    // Canonical key: content labels bind to the live path, so a preset's labels
    // survive the `.disabled` marker toggling (and legacy `.disabled` rows fold
    // onto the same key as their live counterpart).
    const key = row.package_filename + '\0' + stripDisabledSuffix(row.internal_path)
    let arr = labelsByContent.get(key)
    if (!arr) {
      arr = []
      labelsByContent.set(key, arr)
    }
    arr.push(row.label_id)
    const entry = labelIndex.get(row.label_id)
    if (entry) entry.contentCount++
  }
}

function packageLabelIds(filename) {
  return labelsByPackage.get(filename) || []
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

/**
 * For every package, count the resolved dependencies in its subtree whose file
 * is present but *inactive* (disabled or offloaded) — i.e. installed yet not
 * loadable by VaM. Independent of the owning package's own storage state (the
 * UI only surfaces the count for active packages), so the memo is reusable.
 */
function computeTransitiveInactive() {
  transitiveInactiveMap = new Map()
  const memo = new Map()
  function collect(filename) {
    if (memo.has(filename)) return memo.get(filename)
    const inactive = new Set()
    memo.set(filename, inactive)
    for (const dep of forwardDeps.get(filename) || []) {
      if (!dep.resolved) continue
      const depPkg = packageIndex.get(dep.resolved)
      if (depPkg && !isPackageActive(depPkg.storage_state)) inactive.add(dep.resolved)
      for (const r of collect(dep.resolved)) inactive.add(r)
    }
    return inactive
  }
  for (const filename of packageIndex.keys()) {
    const inactive = collect(filename)
    if (inactive.size > 0) transitiveInactiveMap.set(filename, inactive.size)
  }
}

/**
 * A package is "broken" when it's corrupted, has missing deps, or — while active —
 * has installed-but-inactive (disabled/offloaded) deps that VaM won't load.
 * Inactive packages aren't flagged for their inactive deps (that's expected).
 * Shared by `computeStats` and the live `getStatusCounts`.
 */
function isBrokenPkg(filename, pkg) {
  if (pkg.is_corrupted) return true
  if ((transitiveMissingMap.get(filename) || 0) > 0) return true
  return isPackageActive(pkg.storage_state) && (transitiveInactiveMap.get(filename) || 0) > 0
}

/**
 * Refresh the aggregates that depend on storage state after a bulk
 * enable/disable/offload. Toggles patch `packageIndex` rows in place (no full
 * `buildFromDb`), so both the inactive-deps map and `stats` (whose `brokenCount`
 * now counts active packages with inactive deps) must be recomputed here.
 */
export function recomputeInactiveDeps() {
  computeTransitiveInactive()
  computeStats()
}

function computeStats() {
  let directCount = 0,
    depCount = 0,
    totalCount = 0,
    enabledCount = 0,
    totalSize = 0,
    directSize = 0,
    depSize = 0,
    brokenCount = 0
  const contentByType = {}

  for (const [filename, pkg] of userPackageEntries()) {
    totalCount++
    if (isPackageActive(pkg.storage_state)) enabledCount++
    if (pkg.is_direct) {
      directCount++
      directSize += pkg.size_bytes
    } else {
      depCount++
      depSize += pkg.size_bytes
    }
    totalSize += pkg.size_bytes
    if (isBrokenPkg(filename, pkg)) brokenCount++
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
    enabledCount,
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
/** `includeFallbacks` adds refs satisfied by a different version of the same group (resolution === 'fallback'). */
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

export function getLabelList() {
  return [...labelIndex.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** Live map: package_filename → number[] of label ids. Mutated on label CRUD. */
export function getLabelsByPackageMap() {
  return labelsByPackage
}

/** Live map: `${package_filename}\0${internal_path}` → number[] of label ids. */
export function getLabelsByContentMap() {
  return labelsByContent
}

/** Resolve a label id to its display name; returns null if the id is unknown. */
export function getLabelNameById(id) {
  return labelIndex.get(id)?.name ?? null
}

export function getContentByPackage() {
  return contentByPackage
}
export function getExtractedAppearanceBasenames() {
  return extractedAppearanceBasenames
}
/** packageFilename -> local extracted content item[] claimed by (any version of) that package. */
export function getExtractedByPackage() {
  return extractedByPackage
}
/** Every local extracted preset row (appearance/outfit), including orphaned rows
 *  whose owning package versions are all gone (empty `extractedCandidates`). Used
 *  by the extracted-preset lifecycle reconcile full sweep. */
export function getAllExtractedLocalItems() {
  return allExtractedLocalItems
}
export function getPrefsMap() {
  return prefsMap
}
export function setPrefsMap(map) {
  prefsMap = map
  for (const items of contentByPackage.values()) {
    for (const item of items) {
      const key = item.package_filename + '/' + stripDisabledSuffix(item.internal_path)
      const prefs = prefsMap.get(key) || { hidden: false, favorite: false }
      item.hidden = prefs.hidden
      item.favorite = prefs.favorite
    }
  }
}

export function updatePref(packageFilename, internalPath, field, value) {
  // Prefs bind to the canonical (live) path — a disabled preset (`X.vap.disabled`)
  // and its enabled form share one entry.
  const canonicalPath = stripDisabledSuffix(internalPath)
  const key = packageFilename + '/' + canonicalPath
  let entry = prefsMap.get(key)
  if (!entry) {
    entry = { hidden: false, favorite: false }
    prefsMap.set(key, entry)
  }
  entry[field] = value
  const items = contentByPackage.get(packageFilename)
  if (!items) return
  for (const item of items) {
    if (stripDisabledSuffix(item.internal_path) === canonicalPath) {
      item[field] = value
      break
    }
  }
}

// --- Filtered queries ---

/**
 * Returns every user-visible package, enriched. The renderer does all
 * filtering / sorting client-side off `useLibraryStore.packages`, so the
 * `packages:list` IPC still forwards filters from the preload bridge; they are
 * ignored here because the renderer filters client-side.
 *
 * Each enriched row includes `storageState` and `libraryDirId`. The Library
 * "enabled filter" axis (Enabled / Disabled / Offloaded) is implemented in the
 * renderer against `pkg.storageState`.
 */
export function getFilteredPackages() {
  return userPackageValues().map((p) => enrichPackageSummary(p))
}

/** True when a Looks package would show the "no preset" card badge (no look/legacyLook/skinPreset items). */
export function packageHasNoLookPresetTag(filename) {
  const pkg = packageIndex.get(filename)
  if (!pkg) return false
  return effectivePackageType(pkg) === 'Looks' && (lookItemCountByPackage.get(filename) || 0) === 0
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
  // Presets extracted from this package's scenes are loose (`__local__`) files, so
  // they're kept out of `contentByPackage`/`contentCount` to avoid cross-version
  // double counting. Their favorite state is still this package's content, though,
  // so roll it into the owner's card aggregate.
  for (const c of extractedByPackage.get(pkg.filename) || []) {
    if (c.favorite) favoriteContentCount++
  }
  const removableSize = removableSizeMap.get(pkg.filename) || 0
  const derivedType = pkg.type ?? null
  const effectiveType = effectivePackageType(pkg)
  const lookItemCount = lookItemCountByPackage.get(pkg.filename) || 0
  const noLookPresetTag = effectiveType === 'Looks' && lookItemCount === 0
  const hasExtractedAppearancePreset = noLookPresetTag && packageHasExtractedAppearance(pkg.filename)
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
    storageState: pkg.storage_state,
    libraryDirId: pkg.library_dir_id ?? null,
    hubResourceId: pkg.hub_resource_id,
    hubUserId: pkg.hub_user_id,
    hubTags: pkg.hub_tags || null,
    promotionalLink: pkg.promotional_link || null,
    contentCount,
    favoriteContentCount,
    depCount,
    missingDeps,
    inactiveDeps: transitiveInactiveMap.get(pkg.filename) || 0,
    morphCount: aggregateMorphCountMap.get(pkg.filename) || 0,
    firstSeenAt: pkg.first_seen_at,
    fileMtime: pkg.file_mtime,
    isCorrupted: !!pkg.is_corrupted,
    isOrphan: orphanSet.has(pkg.filename),
    isCascadeOrphan: orphanSet.has(pkg.filename) && !directOrphanSet.has(pkg.filename),
    isLocalOnly: isNotDownloadable(pkg),
    noLookPresetTag,
    hasExtractedAppearancePreset,
    labelIds: packageLabelIds(pkg.filename),
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
      storageState: depPkg?.storage_state ?? 'enabled',
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
      ? {
          filename: fn,
          creator: dp.creator,
          packageName: dp.package_name,
          version: dp.version,
          storageState: dp.storage_state ?? 'enabled',
        }
      : { filename: fn, storageState: 'enabled' }
  })

  const mapContentRow = (c, extra = {}) => ({
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
    ownLabelIds: labelsByContent.get(c.package_filename + '\0' + stripDisabledSuffix(c.internal_path)) || [],
    ...extra,
  })

  const contents = (contentByPackage.get(filename) || []).filter((c) => isVisible(c.type)).map((c) => mapContentRow(c))

  // Append presets extracted from this package's scenes. They're loose
  // (`__local__`) files, so they never live in `contentByPackage`; surfacing
  // them here gives the detail panel + "More from this package" the linkage.
  // Their real store-row `id`s make ContentView's related-item lookup work.
  for (const c of extractedByPackage.get(filename) || []) {
    contents.push(
      mapContentRow(c, { extracted: true, extractedFrom: c.extractedFrom ?? null, localDisabled: !!c.localDisabled }),
    )
  }

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

  const cascadeDisableDeps =
    pkg.storage_state === 'enabled'
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

/**
 * Returns lean content rows. The renderer keeps a `packageByFilename` map in
 * `useLibraryStore` and links each row's owning package on receive
 * (`useContentStore.relink`); package fields are read off `c.package` at the
 * call site, never copied here. `packageFilename` filter is honoured because
 * `useContentStore.refreshSelection` uses it to refresh a single package's
 * rows (and that path also wants the un-deduplicated list, since cross-version
 * dedup hides items the caller is asking for by filename).
 */
export function getFilteredContents(filters = {}) {
  const source = filters.packageFilename ? contentItems : contentItemsDeduped
  const results = filters.packageFilename
    ? source.filter((c) => c.package_filename === filters.packageFilename)
    : source

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
    extractedFrom: c.extractedFrom ?? null,
    localDisabled: !!c.localDisabled,
    fileMtime: isLocalPackage(c.package_filename) ? c.file_mtime || 0 : 0,
    hasExtractedAppearancePreset:
      c.type === 'legacyLook' &&
      contentHasExtractedAppearance({
        creator: c.creator,
        internalPath: c.internal_path,
        personAtomIdsJson: c.person_atom_ids,
      }),
    ownLabelIds: labelsByContent.get(c.package_filename + '\0' + stripDisabledSuffix(c.internal_path)) || [],
  }))
}

// --- Stats for Library filter counts ---

export function getStatusCounts() {
  let direct = 0,
    dependency = 0,
    broken = 0,
    orphan = orphanSet.size,
    local = 0,
    offloaded = 0
  for (const [filename, pkg] of userPackageEntries()) {
    if (pkg.is_direct) direct++
    else dependency++
    if (isBrokenPkg(filename, pkg)) broken++
    if (isNotDownloadable(pkg)) local++
    if (pkg.storage_state === 'offloaded') offloaded++
  }

  const missingGroups = new Set()
  for (const [filename] of userPackageEntries()) {
    for (const d of forwardDeps.get(filename) || []) {
      if (d.resolved && d.resolution !== 'fallback') continue
      const parsed = parseDepRef(d.ref)
      missingGroups.add(parsed ? parsed.packageName : d.ref)
    }
  }

  return { direct, dependency, broken, orphan, local, offloaded, missingUnique: missingGroups.size }
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
      // downloadUrl starts null; client fills it in via packages:enrich-from-hub.
      // Leaving it undefined would cause the UI to treat unresolved entries as
      // "Install" and subsequently fail with "No download URL available".
      row.hub = { filename: exactFilename, resourceId: String(exactResId), isExact: true, downloadUrl: null }
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
        downloadUrl: null,
      }
    } else {
      // Hub has a version we don't have — offer it as a fallback install
      row.hub = {
        filename: hubEntry.filename,
        resourceId: String(hubEntry.resourceId),
        isExact: false,
        installedLocally: false,
        hubVersion: hubEntry.version,
        downloadUrl: null,
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

/**
 * Tag a hub resource / wishlist snapshot with local install state
 * (`_installed` / `_isDirect` / `_localFilename`). Matched by resource id, so it's
 * version-agnostic. Returns the matched local package row (or null) for callers
 * that need it. NOTE: the `hub:detail` handler does its own richer resolution
 * (hubFiles-first, then id fallback) and deliberately doesn't use this.
 */
export function annotateInstallState(target, resourceId = target?.resource_id) {
  const local = findLocalByHubResourceId(resourceId)
  if (local) {
    target._installed = true
    target._isDirect = !!local.is_direct
    target._localFilename = local.filename
  } else {
    target._installed = false
    target._isDirect = false
  }
  return local
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

/**
 * Fast-path patch of `storage_state` (+ optionally `library_dir_id` / `subpath`) on
 * `packageIndex` rows so a toggle/move doesn't pay for a full `buildFromDb()`
 * rebuild. Used by `applyStorageState`.
 *
 * `subpath` must be patched whenever the file's folder within its library dir
 * changed — e.g. restoring a BrowserAssist-flattened package into the nested
 * folder recorded in its sidecar. Omitting it leaves the in-memory subpath
 * stale while the DB is already correct, and the next relocate then looks for
 * the bytes under the AddonPackages root.
 *
 * Content rows on the renderer no longer carry `storageState` — they read it
 * via `c.package.storageState` after relink — so there is nothing to patch on
 * the content side here.
 *
 * NOT refreshed by this function:
 *  - `forwardDeps` / `reverseDeps` / `groupIndex` — graph topology, keyed on filename + package_name.
 *  - `removableSizeMap`, `aggregateMorphCountMap`, `transitiveDepsCountMap`,
 *    `transitiveMissingMap` — derived from `is_direct` and the dep graph.
 *  - `orphanSet` / `directOrphanSet` — derived from `is_direct` + reverse deps.
 *  - `tagCounts`, `authorCounts`, `nonDownloadableRids` — Hub/metadata, state-independent.
 *
 * State-dependent aggregates ARE storage-state sensitive and must NOT be read stale:
 *  - `transitiveInactiveMap` and `stats.brokenCount` (which now counts active
 *    packages with inactive deps) are refreshed by `recomputeInactiveDeps()`,
 *    which the toggle chokepoint (`applyStorageStateChange`) calls after the bulk.
 *  - Live count `getStatusCounts()` re-iterates `packageIndex` on every call, so it
 *    sees `storage_state` patches (offloaded count, broken) immediately.
 *
 * If you add another derived map that branches on `storage_state`, either refresh
 * it in `recomputeInactiveDeps()` / at the toggle chokepoint, compute it live, or
 * fall back to `buildFromDb()` — otherwise a toggle will leave it stale until the
 * next rescan.
 */
export function patchStorageState(filenames, storageState, libraryDirId, subpath) {
  for (const fn of filenames) {
    const pkg = packageIndex.get(fn)
    if (pkg) {
      pkg.storage_state = storageState
      if (libraryDirId !== undefined) pkg.library_dir_id = libraryDirId == null ? null : libraryDirId
      if (subpath !== undefined) pkg.subpath = subpath || ''
    }
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

/**
 * Rebuild only the label maps. Cheap (no graph / dedup / stats / orphan recompute).
 * Use after label CRUD where package and content tables haven't changed.
 */
export function refreshLabels() {
  buildLabels()
}

/**
 * Refresh only label name/color and the label set (insert created ids, drop
 * deleted ones). Leaves `labelsByPackage` / `labelsByContent` and the cached
 * counts on existing entries untouched. Use after rename / recolor / create
 * where neither junction table changed; for delete and apply-* keep using
 * `refreshLabels()` since junctions actually move.
 */
export function refreshLabelMeta() {
  const labels = getAllLabels()
  const seen = new Set()
  for (const l of labels) {
    seen.add(l.id)
    const existing = labelIndex.get(l.id)
    if (existing) {
      existing.name = l.name
      existing.color = l.color
    } else {
      labelIndex.set(l.id, { id: l.id, name: l.name, color: l.color, packageCount: 0, contentCount: 0 })
    }
  }
  for (const id of [...labelIndex.keys()]) if (!seen.has(id)) labelIndex.delete(id)
}
