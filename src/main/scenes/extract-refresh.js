/**
 * Auto-refresh of extracted presets when a package is updated.
 *
 * Extracted presets are unversioned loose files that reference their source
 * package via `.latest`, so they keep working across updates — but their inline
 * snapshot (morphs, storables) still reflects the version they were extracted
 * from. When a strictly-newer version of a package is installed, we regenerate
 * exactly the presets the user already had (never creating new ones) from the
 * new version's scenes, so the snapshot tracks the update too.
 *
 * Driven off the existing inherit pipeline: every ingest path (scan, download,
 * watcher) computes a donor version and calls `inheritFromOlderVersion`. The
 * caller hands us the donor + the new version's content items; we run after the
 * caller's own DB rebuild so `readScene` can resolve the new `.var`.
 */

import { existsSync } from 'fs'
import { getPersonAtomIds } from '../db.js'
import { parseVarFilename } from '../scanner/var-reader.js'
import { runLocalScan } from '../scanner/local.js'
import { buildFromDb } from '../store.js'
import { notify } from '../notify.js'
import { computeTargets, runExtractBatch, APPEARANCE_SOURCE_TYPES } from './extract.js'

/** Parse a cached `person_atom_ids` JSON string into an array (empty on any miss). */
function parseAtomIds(json) {
  if (!json) return []
  try {
    const a = JSON.parse(json)
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}

/** A preset target counts as "existing" in either its enabled or disabled form. */
function targetExists(absPath) {
  return existsSync(absPath) || existsSync(absPath + '.disabled')
}

/**
 * For one freshly-installed *higher* version, collect the scene-source items
 * whose extracted preset targets already exist on disk (so we regenerate only
 * what the user had). Returns `{ appearance, outfit }` batch item lists, or null
 * when the gate fails / nothing matches.
 *
 * Upgrade-only gate: `inheritFromOlderVersion` picks its donor by first-seen
 * time, so a downgrade install can have a *higher* donor. Settings inheritance
 * stays unconditional upstream, but the refresh fires only when the new version
 * is strictly newer.
 */
export function collectExtractRefreshItems({ vamDir, filename, donorFilename, contentItems }) {
  if (!vamDir || !filename || !donorFilename || !contentItems?.length) return null
  const newParsed = parseVarFilename(filename)
  const newV = parseInt(newParsed?.version, 10) || 0
  const oldV = parseInt(parseVarFilename(donorFilename)?.version, 10) || 0
  if (!(newV > oldV)) return null
  const creator = newParsed?.creator || '!local'

  const appearance = []
  const outfit = []
  for (const c of contentItems) {
    if (!APPEARANCE_SOURCE_TYPES.has(c.type)) continue
    const atomIds = parseAtomIds(getPersonAtomIds(filename, c.internalPath)?.person_atom_ids)
    if (atomIds.length === 0) continue
    const singleAtom = atomIds.length === 1
    const canOutfit = c.type !== 'legacyLook' // legacy looks only surface an appearance preset
    // Atom-drift safe: probe only the *new* scene's atoms; a target for an atom
    // dropped in the new version is simply left untouched.
    let hasAppearance = false
    let hasOutfit = false
    for (const atomId of atomIds) {
      const t = computeTargets({ vamDir, creator, internalPath: c.internalPath, atomId, singleAtom })
      hasAppearance ||= targetExists(t.appearance.absPath)
      hasOutfit ||= canOutfit && targetExists(t.clothing.absPath)
      if (hasAppearance && (hasOutfit || !canOutfit)) break
    }
    const ref = { packageFilename: filename, internalPath: c.internalPath }
    if (hasAppearance) appearance.push(ref)
    if (hasOutfit) outfit.push(ref)
  }
  if (!appearance.length && !outfit.length) return null
  return { appearance, outfit }
}

/**
 * Run the extracted-preset refresh for a batch of freshly-installed packages.
 * `additions` is `[{ filename, donorFilename, contentItems }]`. Safe to call
 * with an empty/irrelevant set (no-op). Never throws — failures are logged and
 * never affect ingest. Rebuilds the store + notifies only when something wrote.
 */
export async function refreshExtractedPresetsForUpdates(additions, vamDir) {
  if (!vamDir || !additions?.length) return
  const appearance = []
  const outfit = []
  for (const a of additions) {
    const items = collectExtractRefreshItems({ vamDir, ...a })
    if (!items) continue
    appearance.push(...items.appearance)
    outfit.push(...items.outfit)
  }
  if (!appearance.length && !outfit.length) return

  let written = 0
  try {
    for (const [kind, items] of [
      ['appearance', appearance],
      ['outfit', outfit],
    ]) {
      if (items.length) written += (await runExtractBatch({ items, kind, mode: 'refresh' })).written.length
    }
  } catch (err) {
    console.warn('Extracted-preset refresh failed:', err.message)
  }

  if (written > 0) {
    // The rewritten presets can carry fresh thumbnails/mtimes, so re-scan the
    // loose files and rebuild. Only `contents:updated` is relevant — refresh
    // never adds/removes rows, so package-level data is untouched.
    try {
      await runLocalScan(vamDir)
      buildFromDb()
      notify('contents:updated')
    } catch (err) {
      console.warn('Extracted-preset refresh rebuild failed:', err.message)
    }
  }
}
