import { existsSync, readdirSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getSetting, setSetting } from './db.js'

// Bump when the loose-sidecar on-disk convention changes; the migration runs once
// per bump. Layout 1 retired the `.disabled`-marker sidecar form: favorites/hidden
// now bind to the canonical live stem (`X.vap.fav`), so a preset keeps its flags
// across the `.disabled` toggle without the sidecar ever being renamed. This folds
// any leftover `X.vap.disabled.{hide,fav}` from older builds back onto the stem.
const LOOSE_SIDECAR_LAYOUT = 1

// Extracted presets are the only loose content that ever carries a `.disabled`
// marker, so their two dirs are the only place legacy `.disabled` sidecars can be —
// no need to walk all of Custom.
const EXTRACTED_DIRS = ['Custom/Atom/Person/Appearance/extracted', 'Custom/Atom/Person/Clothing/extracted']

const LEGACY_RE = /\.disabled(\.hide|\.fav)$/

// Sync fs, no recordOwnedPath: this runs at boot before startWatcher (see
// runStartupMigrations), so the renames/unlinks can't surface as watcher events.
function normalizeDir(dirPath) {
  let entries
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return 0 // dir absent (fresh install / no presets) — nothing to do
  }
  let moved = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      moved += normalizeDir(full)
      continue
    }
    if (!entry.isFile()) continue
    const m = entry.name.match(LEGACY_RE)
    if (!m) continue
    // `X.vap.disabled.<ext>` -> `X.vap.<ext>`: drop just the `.disabled` marker.
    const canonical = join(dirPath, entry.name.slice(0, -m[0].length) + m[1])
    try {
      if (existsSync(canonical)) unlinkSync(full)
      else renameSync(full, canonical)
      moved++
    } catch {}
  }
  return moved
}

/**
 * Fold every legacy `X.vap.disabled.{hide,fav}` sidecar under the extracted-preset
 * dirs onto its canonical live stem, dropping the legacy file when a canonical one
 * already exists. Pure (takes the VaM dir, touches only disk); returns the count
 * normalized. Exported for unit tests.
 */
export function normalizeExtractedSidecars(vamDir) {
  if (!vamDir) return 0
  let moved = 0
  for (const rel of EXTRACTED_DIRS) moved += normalizeDir(join(vamDir, rel))
  return moved
}

/**
 * One-time, versioned startup migration (see `runStartupMigrations`). Runs
 * synchronously at boot — before the scan reads prefs off disk — so favorite/
 * hidden state binds to the canonical path without any legacy handling downstream.
 * No-op on a fresh install (no `vam_dir` yet, or the dirs are absent); the flag is
 * only stamped once a `vam_dir` is configured, so an upgrading user still gets the
 * fold on their first launch after pointing at their library.
 */
export function migrateLooseSidecarLayout() {
  if (Number(getSetting('loose_sidecar_layout') || 0) >= LOOSE_SIDECAR_LAYOUT) return
  const vamDir = getSetting('vam_dir')
  if (!vamDir) return // retry next launch once configured

  const moved = normalizeExtractedSidecars(vamDir)
  if (moved > 0) console.log(`Normalized ${moved} legacy .disabled sidecar(s) to canonical`)
  setSetting('loose_sidecar_layout', String(LOOSE_SIDECAR_LAYOUT))
}
