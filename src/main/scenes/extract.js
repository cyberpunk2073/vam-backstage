/**
 * Orchestration layer: given a scene (in a .var or on disk), probe which
 * appearance/outfit presets are missing on disk and, when asked, write them.
 */

import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { basename, extname, dirname, join } from 'path'
import { getSetting } from '../db.js'
import { getContentByPackage, getPackageIndex } from '../store.js'
import { pLimit } from '../p-limit.js'
import { readScene } from './scene-source.js'
import { getPersonAtoms, filterAppearanceStorables, filterOutfitStorables, buildPreset } from './extractor.js'

const PROBE_CONCURRENCY = 4

const KIND_DIRS = {
  appearance: 'Appearance',
  outfit: 'Clothing',
}

/** Replace filesystem-invalid characters in a segment: `/`→`-`, strip `\:*?"<>|#`. */
function sanitizeFsSegment(s) {
  return String(s ?? '')
    .replace(/\//g, '-')
    .replace(/[\\:*?"<>|#]/g, '')
    .trim()
}

/** Scene stem: filename without extension, with / → - and invalid chars stripped. */
function sceneStem(internalPath) {
  const stem = basename(internalPath, extname(internalPath))
  return sanitizeFsSegment(stem)
}

/**
 * Compute the output paths for a single scene + atom.
 *
 *   <vamDir>/Custom/Atom/Person/<kindDir>/extracted/<creator>/Preset_<name>.vap (+ .jpg)
 *   <name>       = <sceneStem><atomSuffix>
 *   <atomSuffix> = "" when singleAtom, else "_<sanitize(atomId)>"
 */
export function computeTargets({ vamDir, creator, internalPath, atomId, singleAtom }) {
  const stem = sceneStem(internalPath)
  const atomSuffix = singleAtom ? '' : '_' + sanitizeFsSegment(atomId)
  const name = stem + atomSuffix
  const creatorSeg = sanitizeFsSegment(creator || '!local') || '!local'
  const baseDir = (kind) => join(vamDir, 'Custom', 'Atom', 'Person', KIND_DIRS[kind], 'extracted', creatorSeg)
  return {
    name,
    appearance: { absPath: join(baseDir('appearance'), `Preset_${name}.vap`) },
    clothing: { absPath: join(baseDir('outfit'), `Preset_${name}.vap`) },
  }
}

function creatorFor(packageFilename) {
  if (!packageFilename) return '!local'
  const pkg = getPackageIndex().get(packageFilename)
  return pkg?.creator || '!local'
}

/**
 * Probe a single scene: list its Person atoms and, for each kind, whether the
 * output preset already exists on disk.
 */
export async function probeScene({ packageFilename, internalPath }) {
  const vamDir = getSetting('vam_dir')
  if (!vamDir) throw new Error('VaM directory not configured')
  const { sceneJson } = await readScene({ vamDir, packageFilename, internalPath })
  const atoms = getPersonAtoms(sceneJson)
  const singleAtom = atoms.length === 1
  const creator = creatorFor(packageFilename)

  const atomResults = atoms.map((atom) => {
    const targets = computeTargets({ vamDir, creator, internalPath, atomId: atom.id, singleAtom })
    return {
      atomId: atom.id,
      outputs: {
        appearance: { path: targets.appearance.absPath, exists: existsSync(targets.appearance.absPath) },
        clothing: { path: targets.clothing.absPath, exists: existsSync(targets.clothing.absPath) },
      },
    }
  })

  const label = basename(internalPath, extname(internalPath))
  return { label, atoms: atomResults }
}

/**
 * Probe every scene / legacyScene content item inside a package, skipping
 * scenes whose every output already exists.
 */
export async function probePackage(filename) {
  const items = (getContentByPackage().get(filename) || []).filter(
    (c) => c.type === 'scene' || c.type === 'legacyScene',
  )
  const limit = pLimit(PROBE_CONCURRENCY)
  const results = await Promise.all(
    items.map((c) =>
      limit(async () => {
        try {
          const probe = await probeScene({ packageFilename: filename, internalPath: c.internal_path })
          const anyMissing = probe.atoms.some((a) => !a.outputs.appearance.exists || !a.outputs.clothing.exists)
          if (!anyMissing) return null
          return {
            packageFilename: filename,
            internalPath: c.internal_path,
            label: probe.label,
            atoms: probe.atoms,
          }
        } catch (err) {
          return {
            packageFilename: filename,
            internalPath: c.internal_path,
            label: basename(c.internal_path, extname(c.internal_path)),
            error: err.message,
            atoms: [],
          }
        }
      }),
    ),
  )
  return { scenes: results.filter(Boolean) }
}

function filterFor(kind, atom) {
  if (kind === 'appearance') return filterAppearanceStorables(atom)
  if (kind === 'outfit') return filterOutfitStorables(atom)
  throw new Error(`Unknown kind: ${kind}`)
}

function targetKey(kind) {
  return kind === 'appearance' ? 'appearance' : 'clothing'
}

/**
 * Extract presets for one scene.
 *
 * Reads scene + thumb once, applies SELF replacement if .var-sourced, then
 * for each requested atom: skips if the target for `kind` already exists,
 * otherwise mkdir -p + writes .vap (+ sibling .jpg if thumb available).
 *
 * @param {object} params
 * @param {string} params.packageFilename
 * @param {string} params.internalPath
 * @param {string[]} [params.atomIds] — when omitted, all Person atoms are processed.
 * @param {'appearance'|'outfit'} params.kind
 * @returns {Promise<{written: string[], skipped: string[], errors: {scene: string, reason: string}[]}>}
 */
export async function runExtract({ packageFilename, internalPath, atomIds, kind }) {
  if (kind !== 'appearance' && kind !== 'outfit') throw new Error(`Unknown kind: ${kind}`)
  const vamDir = getSetting('vam_dir')
  if (!vamDir) throw new Error('VaM directory not configured')

  const written = []
  const skipped = []
  const errors = []

  let sceneJson, thumbBuffer
  try {
    ;({ sceneJson, thumbBuffer } = await readScene({ vamDir, packageFilename, internalPath }))
  } catch (err) {
    errors.push({ scene: internalPath, reason: err.message })
    return { written, skipped, errors }
  }

  const atoms = getPersonAtoms(sceneJson)
  const singleAtom = atoms.length === 1
  const creator = creatorFor(packageFilename)
  const wantAtoms = atomIds && atomIds.length ? new Set(atomIds) : null

  for (const atom of atoms) {
    if (wantAtoms && !wantAtoms.has(atom.id)) continue
    const targets = computeTargets({ vamDir, creator, internalPath, atomId: atom.id, singleAtom })
    const target = targets[targetKey(kind)].absPath
    if (existsSync(target)) {
      skipped.push(target)
      continue
    }

    try {
      const filtered = filterFor(kind, atom)
      const preset = buildPreset(filtered)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, JSON.stringify(preset, null, 3), 'utf-8')
      if (thumbBuffer) {
        const imgPath = target.replace(/\.vap$/i, '.jpg')
        try {
          await writeFile(imgPath, thumbBuffer)
        } catch {
          // Thumb write is best-effort.
        }
      }
      written.push(target)
    } catch (err) {
      errors.push({ scene: internalPath, reason: err.message })
    }
  }

  return { written, skipped, errors }
}

/**
 * Batch runner. Sequentially extracts across multiple scenes using runExtract.
 * Existing outputs are skipped; errors per scene don't abort the batch.
 */
export async function runExtractBatch({ items, kind }) {
  const written = []
  const skipped = []
  const errors = []
  for (const it of items) {
    try {
      const r = await runExtract({
        packageFilename: it.packageFilename,
        internalPath: it.internalPath,
        atomIds: it.atomIds,
        kind,
      })
      written.push(...r.written)
      skipped.push(...r.skipped)
      errors.push(...r.errors)
    } catch (err) {
      errors.push({ scene: it.internalPath, reason: err.message })
    }
  }
  return { written, skipped, errors }
}
