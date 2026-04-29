import { readFile, writeFile, readdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import {
  getPackageIndex,
  getContentByPackage,
  effectivePackageType,
  getLabelsByPackageMap,
  getLabelsByContentMap,
  getLabelNameById,
} from './store.js'

const BA_REL_PARTS = ['Saves', 'PluginData', 'JayJayWon', 'BrowserAssist', 'VARResourcesUserData']
const MANAGED_SCENE_TAGS = new Set(['scene-real', 'scene-look', 'scene-other'])
const USER_CATEGORY = 'User'
// Separate category for our user-defined labels so we can clean-and-rewrite
// just our entries without touching unrelated User-category tags. BrowserAssist
// happily round-trips arbitrary string categories.
const LABEL_CATEGORY = 'Label'

export function browserAssistSettingsDir(vamDir) {
  return join(vamDir, ...BA_REL_PARTS)
}

/**
 * @param {string|null|undefined} vamDir
 * @returns {boolean}
 */
export function browserAssistSettingsDirExists(vamDir) {
  if (!vamDir || typeof vamDir !== 'string') return false
  return existsSync(browserAssistSettingsDir(vamDir))
}

/**
 * @returns {boolean}
 */
function isSceneContentPath(normPath) {
  return /^Saves\/scene\//i.test(normPath) && /\.(json|vac)$/i.test(normPath)
}

/**
 * @param {string|null|undefined} pt
 * @returns {string}
 */
function sceneTagForPackageType(pt) {
  if (pt === 'Scenes') return 'scene-real'
  if (pt === 'Looks') return 'scene-look'
  return 'scene-other'
}

/**
 * Build a content lookup keyed by `lower(package_name) + '\0' + lower(internal_path)`.
 *
 * Each entry carries:
 *   - `sceneType`: effective package type for scene/legacyScene rows (used to derive
 *     scene-real/scene-look/scene-other), or null for non-scene content.
 *   - `labelNames`: union of user-defined label names — own labels on the content row
 *     plus labels inherited from the package the content lives in.
 *
 * Multiple installed package versions share the same `(packageKey, pathKey)` (BA has
 * no version axis). We merge across versions: any version's scene type sticks; label
 * names are unioned so a label set on either v1 or v2 still appears on the BA tag.
 *
 * @returns {Map<string, { sceneType: string|null, labelNames: Set<string> }>}
 */
function buildContentLookup() {
  const packageIndex = getPackageIndex()
  const contentByPackage = getContentByPackage()
  const labelsByPackage = getLabelsByPackageMap()
  const labelsByContent = getLabelsByContentMap()

  const lookup = new Map()
  for (const [filename, pkg] of packageIndex) {
    const pkgName = typeof pkg.package_name === 'string' ? pkg.package_name : ''
    if (!pkgName) continue
    const pkgKey = pkgName.toLowerCase()
    const pt = effectivePackageType(pkg)
    const items = contentByPackage.get(filename)
    if (!items) continue

    const inheritedIds = labelsByPackage.get(filename) || []

    for (const item of items) {
      const ip = typeof item.internal_path === 'string' ? item.internal_path : ''
      if (!ip) continue
      const pathKey = ip.replace(/\\/g, '/').toLowerCase()
      const key = pkgKey + '\0' + pathKey

      const ownIds = labelsByContent.get(filename + '\0' + item.internal_path) || []
      const labelNames = []
      const seenIds = new Set()
      for (const id of inheritedIds) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
        const name = getLabelNameById(id)
        if (name) labelNames.push(name)
      }
      for (const id of ownIds) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
        const name = getLabelNameById(id)
        if (name) labelNames.push(name)
      }

      const isSceneItem = item.type === 'scene' || item.type === 'legacyScene'
      const sceneType = isSceneItem ? pt : null

      let entry = lookup.get(key)
      if (!entry) {
        entry = { sceneType, labelNames: new Set(labelNames) }
        lookup.set(key, entry)
      } else {
        if (sceneType && !entry.sceneType) entry.sceneType = sceneType
        for (const n of labelNames) entry.labelNames.add(n)
      }
    }
  }
  return lookup
}

/**
 * @param {unknown} tags
 * @param {string} newTagName
 * @returns {Array<{ tagName: string, tagCategory: string }>}
 */
function mergeSceneUserTag(tags, newTagName) {
  const arr = Array.isArray(tags) ? tags : []
  const filtered = arr.filter((t) => {
    if (!t || typeof t !== 'object') return true
    if (t.tagCategory !== USER_CATEGORY) return true
    if (!MANAGED_SCENE_TAGS.has(t.tagName)) return true
    return false
  })
  return [...filtered, { tagName: newTagName, tagCategory: USER_CATEGORY }]
}

/**
 * Reconcile our managed `Label`-category tags with the supplied label names: drop any
 * existing Label-category entries (so removed/renamed labels disappear from BA) and
 * append one entry per current name, sorted for stable serialization.
 *
 * Returns `tags` unchanged when there's nothing to do (no current labels and no stale
 * Label-category entries to remove) so the shallow-equal short-circuit avoids a write.
 *
 * @param {unknown} tags
 * @param {string[]} labelNames
 * @returns {unknown}
 */
function mergeLabelTags(tags, labelNames) {
  const arr = Array.isArray(tags) ? tags : []
  const hasStaleLabels = arr.some((t) => t && typeof t === 'object' && t.tagCategory === LABEL_CATEGORY)
  if (labelNames.length === 0 && !hasStaleLabels) return tags

  const filtered = arr.filter((t) => {
    if (!t || typeof t !== 'object') return true
    return t.tagCategory !== LABEL_CATEGORY
  })
  if (labelNames.length === 0) return filtered

  const sorted = [...labelNames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return [...filtered, ...sorted.map((n) => ({ tagName: n, tagCategory: LABEL_CATEGORY }))]
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function shallowTagsEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * @param {string} vamDir
 * @returns {Promise<{
 *   shardsRead: number,
 *   shardsWritten: number,
 *   resourcesScanned: number,
 *   tagsUpdated: number,
 *   skippedNoMatch: number,
 *   errors: string[],
 * }>}
 */
export async function syncBrowserAssistTags(vamDir) {
  const dir = browserAssistSettingsDir(vamDir)
  const errors = []
  let shardsRead = 0
  let shardsWritten = 0
  let resourcesScanned = 0
  let tagsUpdated = 0
  let skippedNoMatch = 0

  if (!existsSync(dir)) {
    return {
      shardsRead: 0,
      shardsWritten: 0,
      resourcesScanned: 0,
      tagsUpdated: 0,
      skippedNoMatch: 0,
      errors: [`BrowserAssist directory not found: ${dir}`],
    }
  }

  let names
  try {
    names = await readdir(dir)
  } catch (err) {
    return {
      shardsRead: 0,
      shardsWritten: 0,
      resourcesScanned: 0,
      tagsUpdated: 0,
      skippedNoMatch: 0,
      errors: [`Failed to read BrowserAssist directory: ${err.message}`],
    }
  }

  const shardFiles = names.filter((n) => /^VARResourcesData.*\.userData$/i.test(n)).sort()
  const lookup = buildContentLookup()

  for (const name of shardFiles) {
    const filePath = join(dir, name)
    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch (err) {
      errors.push(`${name}: read failed — ${err.message}`)
      continue
    }
    shardsRead++

    let data
    try {
      data = JSON.parse(text)
    } catch (err) {
      errors.push(`${name}: invalid JSON — ${err.message}`)
      continue
    }

    const resources = data?.resources
    if (!Array.isArray(resources)) {
      errors.push(`${name}: missing or invalid "resources" array`)
      continue
    }

    let modified = false
    for (const res of resources) {
      if (!res || typeof res !== 'object') continue
      const rawPath = res.resourceFullFileName
      if (typeof rawPath !== 'string' || !rawPath) continue
      const normPath = rawPath.replace(/\\/g, '/')

      const cName = typeof res.creatorName === 'string' ? res.creatorName : ''
      const pName = typeof res.packageName === 'string' ? res.packageName : ''
      if (!cName || !pName) continue

      resourcesScanned++
      const dbPackageName = `${cName}.${pName}`.toLowerCase()
      const pathKey = normPath.toLowerCase()
      const key = dbPackageName + '\0' + pathKey
      const entry = lookup.get(key)
      if (!entry) {
        skippedNoMatch++
        continue
      }

      let nextTags = res.Tags
      if (entry.sceneType && isSceneContentPath(normPath)) {
        nextTags = mergeSceneUserTag(nextTags, sceneTagForPackageType(entry.sceneType))
      }
      nextTags = mergeLabelTags(nextTags, [...entry.labelNames])

      if (shallowTagsEqual(res.Tags, nextTags)) continue
      res.Tags = nextTags
      modified = true
      tagsUpdated++
    }

    if (modified) {
      try {
        await writeFile(filePath, JSON.stringify(data, null, 3) + '\n', 'utf8')
        shardsWritten++
      } catch (err) {
        errors.push(`${name}: write failed — ${err.message}`)
      }
    }
  }

  return {
    shardsRead,
    shardsWritten,
    resourcesScanned,
    tagsUpdated,
    skippedNoMatch,
    errors,
  }
}
