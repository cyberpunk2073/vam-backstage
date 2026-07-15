/**
 * JayJayWon BrowserAssist offload sidecars.
 *
 * BrowserAssist offloads `.var` packages out of `AddonPackages` into its own
 * folder, flattening every one to the root of that offload dir, and drops a
 * `<packagename>.var.json` sidecar next to each moved file recording where to put
 * it back:
 *
 *   {
 *     "BAMajorVersion": "1",
 *     "BAMinorVersion": "42",
 *     "BAFixVersion": "0",
 *     "OriginalFolder": "AddonPackages\\Some\\Subfolder"
 *   }
 *
 * `OriginalFolder` is `AddonPackages` plus the package's subpath (its parent folder
 * relative to `AddonPackages` — whatever nested layout you use, not a fixed schema).
 * Always spelled with Windows backslashes. BA writes a sidecar for every package,
 * but a *missing* sidecar is tolerated and means "restore to the `AddonPackages`
 * root" — so a root-level package doesn't actually need one. BA likewise tolerates
 * other tools keeping their own subfolder layout instead of flattening, as long as
 * the sidecar (when present) is correct.
 *
 * When an aux (offload) dir has BrowserAssist mode enabled we honor this contract
 * in both directions: we write a sidecar for any non-root package we offload into
 * it (so BA can restore it) — skipping root packages, since the no-sidecar default
 * already restores them to the root — and on restore/enable we read the sidecar to
 * recover the original folder (so we can restore a package BA offloaded). The
 * physical `.var` stays wherever it sits — `subpath` (its folder within the aux
 * dir) is unchanged; the sidecar carries the *restore* location, which may differ.
 *
 * These sidecars are pure `.json` files, so the scanner and package watcher (which
 * key on `.var` names) never index or react to them.
 */

import { readFile, writeFile, unlink } from 'fs/promises'
import { posix } from 'path'
import { recordOwnedPath } from './watcher.js'

// Version stamp written into fresh sidecars (in BA's own key shape so it spreads
// straight into the body). BA reads `OriginalFolder` tolerantly (SimpleJSON), so the
// exact version isn't load-bearing for restore; we mirror a known-good recent release.
export const BA_SIDECAR_VERSION = { BAMajorVersion: '1', BAMinorVersion: '42', BAFixVersion: '0' }

/** Absolute path of the sidecar that sits beside a `.var` (`<var>.json`). */
export function sidecarPathFor(varPath) {
  return varPath + '.json'
}

/**
 * Build BrowserAssist's `OriginalFolder` string from a POSIX-style subpath
 * (relative to `AddonPackages`, '' at the root). Always rooted at `AddonPackages`
 * and joined with backslashes, e.g. 'Some/Subfolder' → 'AddonPackages\\Some\\Subfolder'.
 */
export function originalFolderFromSubpath(subpath) {
  const parts = subpath ? String(subpath).split('/').filter(Boolean) : []
  return ['AddonPackages', ...parts].join('\\')
}

/**
 * Inverse of `originalFolderFromSubpath`: parse a sidecar `OriginalFolder` into a
 * POSIX-style subpath relative to `AddonPackages` ('' at the root). Accepts either
 * slash style and a leading `AddonPackages` segment (case-insensitive), which is
 * dropped. Returns '' for a missing/blank value or the bare `AddonPackages` root.
 *
 * A sidecar is hand-authored / third-party input, so we never let it steer a
 * restore outside `AddonPackages`: the parsed subpath is resolved against a
 * sentinel root and rejected (→ safe root restore, '') if it climbs out via `..`
 * (or an absolute / drive path). Asserting containment beats blocklisting `..` —
 * it's the property we actually need and survives spellings we didn't foresee.
 */
export function subpathFromOriginalFolder(originalFolder) {
  if (typeof originalFolder !== 'string') return ''
  const parts = originalFolder.split(/[\\/]+/).filter(Boolean)
  if (parts.length > 0 && parts[0].toLowerCase() === 'addonpackages') parts.shift()
  const root = '/__ba_root__'
  const resolved = posix.resolve(root, parts.join('/'))
  if (resolved !== root && !resolved.startsWith(root + '/')) return ''
  return resolved === root ? '' : resolved.slice(root.length + 1)
}

/**
 * Write a sidecar beside the offloaded `.var` at `varPath`, recording `subpath`
 * (its home relative to `AddonPackages`) as `OriginalFolder`. A root-level package
 * (empty subpath) gets no sidecar — BA restores the root by default — so this is a
 * no-op returning false. Returns true when a sidecar was written.
 */
export async function writeSidecar(varPath, subpath) {
  if (!subpath) return false
  const sidecarPath = sidecarPathFor(varPath)
  const body = {
    ...BA_SIDECAR_VERSION,
    OriginalFolder: originalFolderFromSubpath(subpath),
  }
  recordOwnedPath(sidecarPath)
  await writeFile(sidecarPath, JSON.stringify(body, null, 3) + '\n')
  return true
}

/**
 * Read the restore subpath from the sidecar beside `varPath`. Returns a POSIX-style
 * subpath relative to `AddonPackages` ('' for a root restore) when a readable
 * sidecar exists, or null when it's absent/unparseable so the caller can fall back
 * to the package's tracked subpath.
 */
export async function readSidecarSubpath(varPath) {
  try {
    const raw = await readFile(sidecarPathFor(varPath), 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || !('OriginalFolder' in data)) return null
    return subpathFromOriginalFolder(data.OriginalFolder)
  } catch {
    return null
  }
}

/** Remove the sidecar beside `varPath` if present. Returns true when one was deleted. */
export async function removeSidecar(varPath) {
  const sidecarPath = sidecarPathFor(varPath)
  recordOwnedPath(sidecarPath)
  try {
    await unlink(sidecarPath)
    return true
  } catch {
    return false
  }
}
