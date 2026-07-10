/**
 * Orchestration layer: given a scene or legacy appearance JSON (in a .var or on
 * disk), probe which appearance/outfit presets are missing on disk and, when
 * asked, write them. Legacy looks are structurally identical to a scene with a
 * single Person atom, so they share the read/filter/write path; outfit
 * extraction is only surfaced for scenes in the UI layer.
 */

import { existsSync } from 'fs'
import { mkdir, writeFile, utimes, stat } from 'fs/promises'
import { basename, extname, dirname, join } from 'path'
import { isLocalPackage } from '@shared/local-package.js'
import { getSetting, getPersonAtomIds } from '../db.js'
import { getContentByPackage, getPackageIndex, getExtractedAppearanceBasenames } from '../store.js'
import { pLimit } from '../p-limit.js'
import { readScene } from './scene-source.js'
import { getPersonAtoms, filterAppearanceStorables, filterOutfitStorables, buildPreset } from './extractor.js'
import { KIND_DIRS, extractedPresetFileBase, extractedPresetBasename } from './extract-targets.js'

const PROBE_CONCURRENCY = 4

/** Content types we accept as extraction sources. Scenes and legacy looks share
 * the same `{ atoms:[{ type:"Person", storables }] }` shape; outfit extraction
 * works against either, it's just not surfaced for looks in the UI. */
export const APPEARANCE_SOURCE_TYPES = new Set(['scene', 'legacyScene', 'legacyLook'])

/**
 * Compute the output paths for a single scene + atom.
 *
 *   <vamDir>/Custom/Atom/Person/<kindDir>/extracted/Preset_<creator> - <name>.vap (+ .jpg)
 *
 * Naming lives in `extract-targets.js` so the store can invert it without a
 * `vamDir`/settings dependency.
 */
export function computeTargets({ vamDir, creator, internalPath, atomId, singleAtom }) {
  const { name, fileBase } = extractedPresetFileBase({ creator, internalPath, atomId, singleAtom })
  const baseDir = (kind) => join(vamDir, 'Custom', 'Atom', 'Person', KIND_DIRS[kind], 'extracted')
  return {
    name,
    appearance: { absPath: join(baseDir('appearance'), `${fileBase}.vap`) },
    clothing: { absPath: join(baseDir('outfit'), `${fileBase}.vap`) },
  }
}

function creatorFor(packageFilename) {
  if (!packageFilename) return '!local'
  const pkg = getPackageIndex().get(packageFilename)
  return pkg?.creator || '!local'
}

/** Mtime to stamp onto extracted loose presets — package mtime for .var sources,
 *  source file mtime for loose `__local__` content. */
async function sourceMtimeForExtract({ packageFilename, internalPath, vamDir }) {
  if (packageFilename && !isLocalPackage(packageFilename)) {
    const mtime = getPackageIndex().get(packageFilename)?.file_mtime
    return mtime > 0 ? mtime : null
  }
  if (vamDir && internalPath) {
    try {
      return (await stat(join(vamDir, internalPath))).mtimeMs / 1000
    } catch {}
  }
  return null
}

async function applyExtractMtimes(absPaths, mtimeSeconds) {
  if (!mtimeSeconds || !Number.isFinite(mtimeSeconds)) return
  const d = new Date(mtimeSeconds * 1000)
  for (const p of absPaths) {
    try {
      await utimes(p, d, d)
    } catch {
      // Best-effort — preset bytes are already on disk.
    }
  }
}

/**
 * Per-row predicate: does an extracted appearance preset exist for this
 * scene-source row? Runs the same `computeTargets` formula the writer/probe
 * paths use and tests basename membership against the Set populated during
 * `buildFromDb`. Pure CPU — no DB queries, no fs calls.
 *
 * `personAtomIdsJson` is populated by the scanner at scan time for the three
 * scene-source types (see `PERSON_ATOM_ID_CONTENT_TYPES`), so this returns the
 * right answer on the first scan; rows with a missing column (only possible on
 * a pre-v17 row that hasn't been re-scanned) short-circuit to `false`.
 */
function rowHasExtractedAppearance({ vamDir, creator, internalPath, personAtomIdsJson, set }) {
  if (!personAtomIdsJson) return false
  let atomIds = null
  try {
    atomIds = JSON.parse(personAtomIdsJson)
  } catch {
    return false
  }
  if (!Array.isArray(atomIds) || atomIds.length === 0) return false
  const singleAtom = atomIds.length === 1
  for (const atomId of atomIds) {
    const t = computeTargets({ vamDir, creator, internalPath, atomId, singleAtom })
    if (set.has(basename(t.appearance.absPath))) return true
  }
  return false
}

/**
 * Package-level predicate, used to render the checkmark on the library card
 * "no preset" chip. Returns true as soon as any scene-source row inside the
 * package has its expected appearance preset on disk.
 */
export function packageHasExtractedAppearance(filename) {
  const set = getExtractedAppearanceBasenames()
  if (set.size === 0) return false
  const vamDir = getSetting('vam_dir')
  if (!vamDir) return false
  const pkg = getPackageIndex().get(filename)
  if (!pkg) return false
  const items = getContentByPackage().get(filename)
  if (!items) return false
  for (const c of items) {
    if (!APPEARANCE_SOURCE_TYPES.has(c.type)) continue
    if (
      rowHasExtractedAppearance({
        vamDir,
        creator: pkg.creator,
        internalPath: c.internal_path,
        personAtomIdsJson: c.person_atom_ids,
        set,
      })
    ) {
      return true
    }
  }
  return false
}

/**
 * Content-row predicate, used by the content gallery to flag legacy looks
 * that already have an extracted appearance preset. Mirrors
 * `packageHasExtractedAppearance` but scoped to a single row's atoms.
 */
export function contentHasExtractedAppearance({ creator, internalPath, personAtomIdsJson }) {
  const set = getExtractedAppearanceBasenames()
  if (set.size === 0) return false
  const vamDir = getSetting('vam_dir')
  if (!vamDir) return false
  return rowHasExtractedAppearance({
    vamDir,
    creator: creator || '!local',
    internalPath,
    personAtomIdsJson,
    set,
  })
}

/**
 * Probe a single scene (or legacy appearance JSON): list its Person atoms and,
 * for each kind, whether the output preset already exists on disk. Callers
 * decide per source type which kinds they want to surface (outfit is hidden
 * for legacy looks in the UI); this function reports both unconditionally.
 */
export async function probeScene({ packageFilename, internalPath }) {
  const vamDir = getSetting('vam_dir')
  if (!vamDir) throw new Error('VaM directory not configured')
  const creator = creatorFor(packageFilename)

  const row = packageFilename ? getPersonAtomIds(packageFilename, internalPath) : null
  let atomIds
  if (row?.person_atom_ids != null && row.person_atom_ids !== '') {
    try {
      atomIds = JSON.parse(row.person_atom_ids)
    } catch {
      atomIds = []
    }
    if (!Array.isArray(atomIds)) atomIds = []
  } else {
    const { sceneJson } = await readScene({ vamDir, packageFilename, internalPath })
    atomIds = getPersonAtoms(sceneJson).map((a) => a.id)
  }

  const singleAtom = atomIds.length === 1

  const atomResults = atomIds.map((atomId) => {
    const targets = computeTargets({ vamDir, creator, internalPath, atomId, singleAtom })
    return {
      atomId,
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
 * Probe every scene / legacyScene / legacyLook content item inside a package,
 * skipping items whose every UI-surfaced output already exists. Legacy looks
 * don't expose outfit in the UI, so their `clothing` output isn't considered
 * when deciding whether an item has anything missing.
 */
export async function probePackage(filename) {
  const items = (getContentByPackage().get(filename) || []).filter((c) => APPEARANCE_SOURCE_TYPES.has(c.type))
  const limit = pLimit(PROBE_CONCURRENCY)
  const results = await Promise.all(
    items.map((c) =>
      limit(async () => {
        try {
          const probe = await probeScene({ packageFilename: filename, internalPath: c.internal_path })
          const considersOutfit = c.type !== 'legacyLook'
          const anyMissing = probe.atoms.some(
            (a) => !a.outputs.appearance.exists || (considersOutfit && !a.outputs.clothing.exists),
          )
          if (!anyMissing) return null
          return {
            packageFilename: filename,
            internalPath: c.internal_path,
            type: c.type,
            label: probe.label,
            atoms: probe.atoms,
          }
        } catch (err) {
          return {
            packageFilename: filename,
            internalPath: c.internal_path,
            type: c.type,
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

/**
 * Reverse of `computeTargets`: given an extracted preset that already lives on
 * disk (`Custom/Atom/Person/<Appearance|Clothing>/extracted/Preset_… .vap`) and
 * its owning package, find the source scene + atom + kind that produced it. The
 * "re-extract" escape hatch lives on the extracted item itself, so we invert
 * the naming to rediscover what to regenerate. Returns `null` when nothing in
 * the package maps to the preset (orphaned name, uninstalled source, …).
 *
 * `kind` comes from the output folder (Appearance → appearance, Clothing →
 * outfit); the source scene + atom are matched by recomputing each atom's
 * expected basename and comparing to the preset's own basename.
 */
export function resolveExtractedSource({ packageFilename, presetInternalPath }) {
  const vamDir = getSetting('vam_dir')
  if (!vamDir || !packageFilename || !presetInternalPath) return null
  const live = presetInternalPath.endsWith('.disabled')
    ? presetInternalPath.slice(0, -'.disabled'.length)
    : presetInternalPath
  const kind = live.startsWith('Custom/Atom/Person/Appearance/extracted/')
    ? 'appearance'
    : live.startsWith('Custom/Atom/Person/Clothing/extracted/')
      ? 'outfit'
      : null
  if (!kind) return null
  const wantBase = basename(live)
  const creator = creatorFor(packageFilename)
  const items = (getContentByPackage().get(packageFilename) || []).filter((c) => APPEARANCE_SOURCE_TYPES.has(c.type))
  for (const c of items) {
    // Legacy looks never produce an outfit preset — skip them for that kind.
    if (kind === 'outfit' && c.type === 'legacyLook') continue
    let atomIds
    try {
      atomIds = JSON.parse(c.person_atom_ids || '[]')
    } catch {
      continue
    }
    if (!Array.isArray(atomIds) || atomIds.length === 0) continue
    const singleAtom = atomIds.length === 1
    for (const atomId of atomIds) {
      const base = extractedPresetBasename({ creator, internalPath: c.internal_path, atomId, singleAtom })
      if (base === wantBase) return { packageFilename, internalPath: c.internal_path, atomId, kind, sourceType: c.type }
    }
  }
  return null
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
 * Extract presets for one scene or legacy appearance JSON.
 *
 * Reads the source + thumb once, applies SELF replacement if .var-sourced, then
 * for each requested atom writes the `kind` preset (+ sibling .jpg if thumb
 * available). Both kinds work against either source shape; it's up to the UI
 * whether to expose outfit extraction for legacy looks.
 *
 * `mode` controls what happens per target:
 *   - `'create'`    (default) — skip when the target already exists (never clobber).
 *   - `'refresh'`   — write only when a target *already* exists on disk (regenerate
 *                     exactly what the user had; never create new files uninvited).
 *                     A `.vap.disabled` sibling counts as existing and is rewritten
 *                     in place so a disabled preset stays disabled after refresh.
 *   - `'overwrite'` — always (re)write, ignoring existing files.
 *
 * @param {object} params
 * @param {string} params.packageFilename
 * @param {string} params.internalPath
 * @param {string[]} [params.atomIds] — when omitted, all Person atoms are processed.
 * @param {'appearance'|'outfit'} params.kind
 * @param {'create'|'refresh'|'overwrite'} [params.mode='create']
 * @returns {Promise<{written: string[], skipped: string[], errors: {scene: string, reason: string}[]}>}
 */
export async function runExtract({ packageFilename, internalPath, atomIds, kind, mode = 'create' }) {
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
  const sourceMtime = await sourceMtimeForExtract({ packageFilename, internalPath, vamDir })

  for (const atom of atoms) {
    if (wantAtoms && !wantAtoms.has(atom.id)) continue
    const targets = computeTargets({ vamDir, creator, internalPath, atomId: atom.id, singleAtom })
    const target = targets[targetKey(kind)].absPath

    // Resolve the write path per mode. `refresh` preserves an existing preset's
    // disabled state by rewriting the `.vap.disabled` sibling in place.
    let writePath = target
    if (mode === 'create') {
      if (existsSync(target)) {
        skipped.push(target)
        continue
      }
    } else if (mode === 'refresh') {
      if (existsSync(target)) {
        writePath = target
      } else if (existsSync(target + '.disabled')) {
        writePath = target + '.disabled'
      } else {
        skipped.push(target)
        continue
      }
    }

    try {
      const filtered = filterFor(kind, atom)
      const preset = buildPreset(filtered)
      await mkdir(dirname(writePath), { recursive: true })
      await writeFile(writePath, JSON.stringify(preset, null, 3), 'utf-8')
      const touched = [writePath]
      if (thumbBuffer) {
        // Thumb always lands on the live `.jpg` (never `.jpg.disabled`): the
        // disable cascade keeps the thumbnail un-renamed and the classifier
        // pairs it with the live stem, so a refreshed disabled preset stays paired.
        const imgPath = writePath.replace(/\.vap(\.disabled)?$/i, '.jpg')
        try {
          await writeFile(imgPath, thumbBuffer)
          touched.push(imgPath)
        } catch {
          // Thumb write is best-effort.
        }
      }
      await applyExtractMtimes(touched, sourceMtime)
      written.push(writePath)
    } catch (err) {
      errors.push({ scene: internalPath, reason: err.message })
    }
  }

  return { written, skipped, errors }
}

/**
 * Batch runner. Sequentially extracts across multiple scenes using runExtract.
 * `mode` is forwarded to each `runExtract` call; errors per scene don't abort
 * the batch.
 */
export async function runExtractBatch({ items, kind, mode = 'create' }) {
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
        mode,
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

function outputKeyForKind(kind) {
  return kind === 'appearance' ? 'appearance' : 'clothing'
}

/**
 * Collect per-scene extract rows with missing outputs across many packages.
 * Uses `probePackage` (lightweight) rather than full package detail.
 */
export async function collectMissingExtractItems({ filenames, kind, sourceTypes }) {
  if (kind !== 'appearance' && kind !== 'outfit') throw new Error(`Unknown kind: ${kind}`)
  const sources = sourceTypes instanceof Set ? sourceTypes : new Set(sourceTypes)
  const outKey = outputKeyForKind(kind)
  const items = []
  for (const filename of filenames) {
    if (!filename) continue
    const { scenes } = await probePackage(filename)
    for (const scene of scenes || []) {
      if (!sources.has(scene.type)) continue
      const atomIds = []
      for (const atom of scene.atoms || []) {
        if (!atom.outputs?.[outKey]?.exists) atomIds.push(atom.atomId)
      }
      if (atomIds.length) {
        items.push({
          packageFilename: scene.packageFilename,
          internalPath: scene.internalPath,
          atomIds,
        })
      }
    }
  }
  return items
}

/** Extract missing presets for every matching scene/look inside the given packages. */
export async function runExtractForPackageFilenames({ filenames, kind, sourceTypes }) {
  const items = await collectMissingExtractItems({ filenames, kind, sourceTypes })
  if (!items.length) return { written: [], skipped: [], errors: [] }
  return runExtractBatch({ items, kind })
}
