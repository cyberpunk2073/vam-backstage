import { readFile, writeFile, readdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { getPackageIndex, getContentByPackage, effectivePackageType } from './store.js'

const BA_REL_PARTS = ['Saves', 'PluginData', 'JayJayWon', 'BrowserAssist', 'VARResourcesUserData']
const MANAGED_SCENE_TAGS = new Set(['scene-real', 'scene-look', 'scene-other'])
const USER_CATEGORY = 'User'

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
 * Map: lower(package_name) + '\0' + lower(internal_path) -> effective package type string
 * @returns {Map<string, string|null>}
 */
function buildSceneContentLookup() {
  const packageIndex = getPackageIndex()
  const contentByPackage = getContentByPackage()
  const lookup = new Map()
  for (const [filename, pkg] of packageIndex) {
    const pkgName = typeof pkg.package_name === 'string' ? pkg.package_name : ''
    if (!pkgName) continue
    const pkgKey = pkgName.toLowerCase()
    const pt = effectivePackageType(pkg)
    const items = contentByPackage.get(filename)
    if (!items) continue
    for (const item of items) {
      if (item.type !== 'scene' && item.type !== 'legacyScene') continue
      const ip = typeof item.internal_path === 'string' ? item.internal_path : ''
      const pathKey = ip.replace(/\\/g, '/').toLowerCase()
      lookup.set(pkgKey + '\0' + pathKey, pt)
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
  const lookup = buildSceneContentLookup()

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
      if (!isSceneContentPath(normPath)) continue

      const cName = typeof res.creatorName === 'string' ? res.creatorName : ''
      const pName = typeof res.packageName === 'string' ? res.packageName : ''
      if (!cName || !pName) continue

      resourcesScanned++
      const dbPackageName = `${cName}.${pName}`.toLowerCase()
      const pathKey = normPath.toLowerCase()
      const key = dbPackageName + '\0' + pathKey
      if (!lookup.has(key)) {
        skippedNoMatch++
        continue
      }

      const pt = lookup.get(key)
      const wantTag = sceneTagForPackageType(pt)
      const nextTags = mergeSceneUserTag(res.Tags, wantTag)
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
