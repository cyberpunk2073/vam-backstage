import { extname, basename } from 'path'
import { VISIBLE_CATEGORIES, categoryOf } from '../../shared/content-types.js'

/**
 * Classification rules ordered by specificity.
 * Each rule maps a path pattern + extension set to an exact internal type.
 * `prefer` defines extension priority for same-type same-stem dedup.
 */
const RULES = [
  // --- Scenes ---
  { type: 'scene', match: (p) => /^Saves\/scene\//i.test(p), extensions: new Set(['.json']) },
  { type: 'legacyScene', match: (p) => /^Saves\/scene\//i.test(p), extensions: new Set(['.vac']) },
  { type: 'subscene', match: (p) => /^Custom\/SubScenes?\//i.test(p), extensions: new Set(['.json']) },

  // --- Looks ---
  { type: 'look', match: (p) => /^Custom\/Atom\/Person\/Appearance\//i.test(p), extensions: new Set(['.vap']) },
  { type: 'legacyLook', match: (p) => /^Saves\/Person\/Appearance\//i.test(p), extensions: new Set(['.json']) },
  { type: 'skinPreset', match: (p) => /^Custom\/Atom\/Person\/Skin\//i.test(p), extensions: new Set(['.vap']) },

  // --- Poses ---
  { type: 'pose', match: (p) => /^Custom\/Atom\/Person\/Pose\//i.test(p), extensions: new Set(['.vap']) },
  { type: 'legacyPose', match: (p) => /^Saves\/Person\/Pose\//i.test(p), extensions: new Set(['.json']) },

  // --- Clothing ---
  {
    type: 'clothingItem',
    match: (p) => /^Custom\/Clothing\//i.test(p),
    extensions: new Set(['.vab', '.vaj', '.vam']),
    prefer: ['.vam', '.vab', '.vaj'],
  },
  { type: 'clothingPreset', match: (p) => /^Custom\/Atom\/Person\/Clothing\//i.test(p), extensions: new Set(['.vap']) },

  // --- Hairstyles ---
  {
    type: 'hairItem',
    match: (p) => /^Custom\/Hair\//i.test(p),
    extensions: new Set(['.vab', '.vaj', '.vam']),
    prefer: ['.vam', '.vab', '.vaj'],
  },
  { type: 'hairPreset', match: (p) => /^Custom\/Atom\/Person\/Hair\//i.test(p), extensions: new Set(['.vap']) },

  // --- Hidden types (detected + stored, not shown in UI) ---
  { type: 'pluginPreset', match: (p) => /^Custom\/Atom\/Person\/Plugins?\//i.test(p), extensions: new Set(['.vap']) },
  {
    type: 'morphBinary',
    match: (p) => /^Custom\/Atom\/Person\/Morphs?\//i.test(p),
    extensions: new Set(['.vmi', '.vmb', '.dsf']),
    prefer: ['.vmi', '.dsf', '.vmb'],
  },
  {
    type: 'pluginScript',
    match: (p) => /^Custom\/Scripts\//i.test(p),
    extensions: new Set(['.cs']),
  },
  {
    type: 'scriptList',
    match: (p) => /^Custom\/Scripts\//i.test(p),
    extensions: new Set(['.cslist']),
  },
  {
    type: 'assetbundle',
    match: (p) => /^Custom\/(Assets?|Sounds?|Audio)\//i.test(p),
    extensions: new Set(['.assetbundle']),
  },
  {
    type: 'audio',
    match: (p) => /^Custom\/(Sounds?|Audio)\//i.test(p),
    extensions: new Set(['.wav', '.mp3', '.ogg', '.aif', '.aiff']),
  },
  {
    type: 'texture',
    match: (p) => /^Custom\/Atom\/Person\/Textures?\//i.test(p),
    extensions: new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']),
  },
  // atomPreset: catch-all for Custom/<Something>/*.vap not matched above
  {
    type: 'atomPreset',
    match: (p) => {
      if (!/^Custom\/[^/]+\/[^/]+\.vap$/i.test(p)) return false
      const seg = p.split('/')[1].toLowerCase()
      const excluded = new Set([
        'atom',
        'clothing',
        'hair',
        'assets',
        'asset',
        'scripts',
        'plugindata',
        'sounds',
        'sound',
        'audio',
        'subscene',
        'subscenes',
      ])
      return !excluded.has(seg)
    },
    extensions: new Set(['.vap']),
  },
]

/** Priority order for deriving a single package-level type from its content. */
const CATEGORY_PRIORITY = VISIBLE_CATEGORIES

// Build per-type extension→priority lookup from the `prefer` arrays
const EXT_PRIORITY = new Map()
for (const rule of RULES) {
  if (!rule.prefer) continue
  for (let i = 0; i < rule.prefer.length; i++) {
    EXT_PRIORITY.set(rule.type + '\0' + rule.prefer[i], i)
  }
}

/** Cross-type dedup pairs: item ↔ preset for the same domain. */
const CROSS_TYPE_PAIRS = {
  clothingItem: 'clothingPreset',
  clothingPreset: 'clothingItem',
  hairItem: 'hairPreset',
  hairPreset: 'hairItem',
}

/**
 * Classify files from a .var's file list into content items.
 * Same-stem siblings within a type are collapsed; item/preset pairs are merged.
 * @param {Array<{path: string, size: number}>} fileList
 * @returns {Array<{internalPath, displayName, type, thumbnailPath}>}
 */
export function classifyContents(fileList) {
  const pathSet = new Set(fileList.map((f) => f.path))
  const raw = []

  for (const file of fileList) {
    const ext = extname(file.path).toLowerCase()
    for (const rule of RULES) {
      if (rule.match(file.path) && rule.extensions.has(ext)) {
        const name = basename(file.path, extname(file.path))
        const displayName = name.replace(/_/g, ' ').replace(/^Preset /i, '')
        const thumbnailPath = findThumbnail(file.path, pathSet)
        raw.push({ internalPath: file.path, displayName, type: rule.type, thumbnailPath, _ext: ext })
        break
      }
    }
  }

  return deduplicateItems(raw)
}

/**
 * Two-pass dedup:
 * 1. Same-type same-stem siblings (e.g. .vab/.vaj/.vam) — highest-priority extension wins.
 * 2. Cross-type same-stem pairs (clothingItem ↔ clothingPreset, hairItem ↔ hairPreset) —
 *    the one with a thumbnail wins; if tied, preset wins.
 */
function deduplicateItems(items) {
  // Pass 1: same-type same-stem dedup
  const sameTypeGroups = new Map()
  const pass1 = []
  for (const item of items) {
    const pri = EXT_PRIORITY.get(item.type + '\0' + item._ext)
    if (pri === undefined) {
      pass1.push(item)
      continue
    }
    const stem = item.internalPath.replace(/\.[^.]+$/, '')
    const key = item.type + '\0' + stem
    const existing = sameTypeGroups.get(key)
    if (!existing || pri < existing.pri) {
      sameTypeGroups.set(key, { item, pri })
    }
  }
  for (const { item } of sameTypeGroups.values()) pass1.push(item)

  // Pass 2: cross-type item↔preset dedup
  const byDisplayStem = new Map()
  for (const item of pass1) {
    if (!(item.type in CROSS_TYPE_PAIRS)) continue
    const key = item.displayName.toLowerCase()
    let group = byDisplayStem.get(key)
    if (!group) {
      group = {}
      byDisplayStem.set(key, group)
    }
    group[item.type] = item
  }

  const suppressedPaths = new Set()
  for (const group of byDisplayStem.values()) {
    for (const type of Object.keys(group)) {
      const partner = CROSS_TYPE_PAIRS[type]
      if (!partner || !group[partner]) continue
      const a = group[type]
      const b = group[partner]
      // Already processed this pair from the other side
      if (suppressedPaths.has(a.internalPath) || suppressedPaths.has(b.internalPath)) continue

      let winner, loser
      const aHasThumb = !!a.thumbnailPath
      const bHasThumb = !!b.thumbnailPath
      if (aHasThumb && !bHasThumb) {
        winner = a
        loser = b
      } else if (bHasThumb && !aHasThumb) {
        winner = b
        loser = a
      } else {
        // Both have thumbs or neither does — preset wins
        const aIsPreset = a.type.endsWith('Preset')
        winner = aIsPreset ? a : b
        loser = aIsPreset ? b : a
      }
      // Inherit thumbnail from loser if winner has none
      if (!winner.thumbnailPath && loser.thumbnailPath) {
        winner.thumbnailPath = loser.thumbnailPath
      }
      suppressedPaths.add(loser.internalPath)
    }
  }

  const result = pass1.filter((item) => !suppressedPaths.has(item.internalPath))
  for (const item of result) delete item._ext
  return result
}

/**
 * Find a sibling .jpg/.png thumbnail for a content file.
 * VaM convention: same path stem with image extension.
 */
function findThumbnail(contentPath, allPaths) {
  const base = contentPath.replace(/\.[^.]+$/, '')
  for (const ext of ['.jpg', '.jpeg', '.png']) {
    const candidate = base + ext
    if (allPaths.has(candidate)) return candidate
  }
  return null
}

/**
 * Determine the primary UI category for a package from its content items.
 * Returns the first visible category in priority order, or null.
 */
export function derivePackageType(contentItems) {
  if (!contentItems.length) return null
  const presentCategories = new Set()
  for (const item of contentItems) {
    const cat = categoryOf(item.type)
    if (cat) presentCategories.add(cat)
  }
  for (const cat of CATEGORY_PRIORITY) {
    if (presentCategories.has(cat)) return cat
  }
  return null
}
