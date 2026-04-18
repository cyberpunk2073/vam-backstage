/**
 * Content type system — shared between main (classifier, store) and renderer (UI).
 *
 * Internal "exact types" are fine-grained (e.g. legacyScene, clothingPreset).
 * UI categories collapse them into the five user-facing groups.
 */

export const VISIBLE_CATEGORIES = ['Scenes', 'Looks', 'Poses', 'Clothing', 'Hairstyles']
export const DETAIL_ONLY_CATEGORIES = ['SubScenes']

/** Content rows of these types are "look" items (modern appearance, legacy appearance, skin preset). */
export const LOOK_ITEM_EXACT_TYPES = new Set(['look', 'legacyLook', 'skinPreset'])

export const EXACT_TYPE_TO_CATEGORY = {
  scene: 'Scenes',
  legacyScene: 'Scenes',
  subscene: 'SubScenes',
  look: 'Looks',
  legacyLook: 'Looks',
  skinPreset: 'Looks',
  pose: 'Poses',
  legacyPose: 'Poses',
  clothingItem: 'Clothing',
  clothingPreset: 'Clothing',
  hairItem: 'Hairstyles',
  hairPreset: 'Hairstyles',
  // Everything below is hidden — detected and stored, but invisible to the user
  atomPreset: null,
  pluginScript: null,
  scriptList: null,
  pluginPreset: null,
  morphBinary: null,
  assetbundle: null,
  audio: null,
  texture: null,
}

/** Per-exact-type UI tag. `color` is a hex base; UI sites derive opacity. */
const TAG_PRESET = { label: 'Preset', color: '#7dd3fc' }
const TAG_LEGACY = { label: 'Legacy', color: '#fbbf24' }

const EXACT_TYPE_TAG = {
  legacyScene: TAG_LEGACY,
  legacyLook: TAG_LEGACY,
  legacyPose: TAG_LEGACY,
  skinPreset: { ...TAG_PRESET, label: 'Skin Preset' },
  clothingPreset: TAG_PRESET,
  hairPreset: TAG_PRESET,
}

export function categoryOf(exactType) {
  return EXACT_TYPE_TO_CATEGORY[exactType] ?? null
}

export function tagOf(exactType) {
  return EXACT_TYPE_TAG[exactType] ?? null
}

export function isVisible(exactType) {
  return categoryOf(exactType) !== null
}

export function isGalleryVisible(exactType) {
  const cat = categoryOf(exactType)
  return cat !== null && VISIBLE_CATEGORIES.includes(cat)
}

/** Package-level `type` string (Hub or derived UI category) — one of `VISIBLE_CATEGORIES`, or other. */
export function isCorePackageCategory(type) {
  return type != null && type !== '' && VISIBLE_CATEGORIES.includes(type)
}
