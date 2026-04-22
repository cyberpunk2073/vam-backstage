/**
 * Pure logic for extracting appearance/outfit presets from a VaM scene JSON.
 * No I/O: the caller is responsible for reading the scene JSON / thumbnail
 * and writing the resulting preset to disk.
 */

/** All atoms with type === "Person" in a parsed scene JSON. */
export function getPersonAtoms(sceneJson) {
  const atoms = sceneJson?.atoms
  if (!Array.isArray(atoms)) return []
  return atoms.filter((a) => a && a.type === 'Person')
}

const APPEARANCE_SKIP_ID_SUBSTRINGS = ['control', 'trigger', 'plugin', 'preset', 'animation']

const APPEARANCE_TRANSIENT_MORPH_PATTERNS = [
  /Breast Impact/,
  /^OpenXXL$/,
  /^Eyelids (Top|Bottom) (Down|Up) (Left|Right)$/,
  /Brow .*(Up|Down)/,
  /^(Left|Right) Fingers/,
  /^Mouth Open/,
  /Tongue In-Out/,
  /^Smile/,
  /Shock/,
  /Surprise/,
  /Fear/,
  /Pain/,
  /Concentrate/,
  /Eyes Closed/,
  /^Flirting/,
]

function isTransientMorph(uid) {
  if (typeof uid !== 'string') return false
  return APPEARANCE_TRANSIENT_MORPH_PATTERNS.some((re) => re.test(uid))
}

/**
 * Filter storables for an appearance preset. Returns a new array; does not
 * mutate the input atom. Drops position/rotation, control/trigger/plugin/
 * preset/animation storables, transient morphs, and empty id-only storables.
 */
export function filterAppearanceStorables(atom) {
  const storables = Array.isArray(atom?.storables) ? atom.storables : []
  const out = []
  for (const src of storables) {
    if (!src || typeof src !== 'object') continue
    const id = src.id
    if (typeof id !== 'string') continue
    const lower = id.toLowerCase()
    if (APPEARANCE_SKIP_ID_SUBSTRINGS.some((ss) => lower.includes(ss))) continue

    const storable = { ...src }
    delete storable.position
    delete storable.rotation
    for (const key of Object.keys(storable)) {
      const k = key.toLowerCase()
      if (k.includes('position') || k.includes('rotation')) delete storable[key]
    }

    if (storable.id === 'geometry' && Array.isArray(storable.morphs)) {
      storable.morphs = storable.morphs.filter((m) => !isTransientMorph(m?.uid))
    }

    if (Object.keys(storable).length > 1) out.push(storable)
  }
  return out
}

/**
 * Filter storables for an outfit (clothing) preset. Keeps the
 * `geometry.clothing` master plus any storable whose id starts with one of
 * the clothing ids. Returns a new array.
 */
export function filterOutfitStorables(atom) {
  const storables = Array.isArray(atom?.storables) ? atom.storables : []
  const clothingMaster = storables.find(
    (s) => s && s.id === 'geometry' && Object.prototype.hasOwnProperty.call(s, 'clothing'),
  )
  if (!clothingMaster) return []
  const clothing = Array.isArray(clothingMaster.clothing) ? clothingMaster.clothing : []
  const clothingIds = clothing.map((c) => c?.internalId ?? c?.id).filter((v) => typeof v === 'string')

  const out = [{ id: 'geometry', clothing }]
  for (const s of storables) {
    if (!s || typeof s.id !== 'string') continue
    if (s === clothingMaster) continue
    if (clothingIds.some((cid) => s.id.startsWith(cid))) out.push(s)
  }
  return out
}

/** Build a preset object { setUnlistedParamsToDefault, storables } ready to serialize. */
export function buildPreset(filteredStorables) {
  return {
    setUnlistedParamsToDefault: 'true',
    storables: filteredStorables,
  }
}
