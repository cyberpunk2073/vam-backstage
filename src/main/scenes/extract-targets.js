/**
 * Pure, dependency-free helpers for the extracted-preset filename convention.
 *
 * The writer (`computeTargets` in extract.js) and the ownership derivation in
 * `store.buildFromDb` both need the exact `Preset_<creator> - <name>.vap`
 * formula. Keeping it here — with no `vamDir`/settings/store imports — lets the
 * store invert the formula (basename -> owning package) without pulling in the
 * heavier extract module's transitive deps or a settings lookup.
 */

import { basename, extname } from 'path'

/** Output subdirectory under `Custom/Atom/Person/` per extraction kind. */
export const KIND_DIRS = {
  appearance: 'Appearance',
  outfit: 'Clothing',
}

/** Replace filesystem-invalid characters in a segment: `/`→`-`, strip `\:*?"<>|#`. */
export function sanitizeFsSegment(s) {
  return String(s ?? '')
    .replace(/\//g, '-')
    .replace(/[\\:*?"<>|#]/g, '')
    .trim()
}

/** Scene stem: filename without extension, with / → - and invalid chars stripped. */
export function sceneStem(internalPath) {
  const stem = basename(internalPath, extname(internalPath))
  return sanitizeFsSegment(stem)
}

/**
 * The `<name>` and `Preset_<creator> - <name>` stem for a single scene + atom.
 *   <name>       = <sceneStem><atomSuffix>
 *   <atomSuffix> = "" when singleAtom, else "_<sanitize(atomId)>"
 */
export function extractedPresetFileBase({ creator, internalPath, atomId, singleAtom }) {
  const stem = sceneStem(internalPath)
  const atomSuffix = singleAtom ? '' : '_' + sanitizeFsSegment(atomId)
  const name = stem + atomSuffix
  const creatorSeg = sanitizeFsSegment(creator || '!local') || '!local'
  return { name, fileBase: `Preset_${creatorSeg} - ${name}` }
}

/** Basename (no directory) of the extracted `.vap` file. Same for both kinds. */
export function extractedPresetBasename(args) {
  return extractedPresetFileBase(args).fileBase + '.vap'
}
