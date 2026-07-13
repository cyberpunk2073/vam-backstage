/**
 * Detect default offload directories used by common third-party VaM tools and
 * suggest them as offload (aux) library dirs.
 *
 * Each tool physically moves `.var` files out of `AddonPackages` into its own
 * folder. Registering that folder as an offload dir lets us index those packages
 * as `offloaded` instead of treating them as missing. We only suggest a folder
 * that actually exists on disk (proxy for "the user runs this tool"), isn't
 * already registered, and passes the same overlap/validation rules as a manual
 * add (`validateNewAuxDirPath`). All known paths sit outside the monitored
 * loose-content dirs, so they're allowed by construction.
 */

import { join } from 'path'
import { existsSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { validateNewAuxDirPath } from './library-dirs.js'

/**
 * Known tools and their default offload/storage folder, relative to the VaM dir.
 * `id` is a stable key used for per-tool dismissal in Settings.
 */
export const KNOWN_OFFLOAD_TOOLS = [
  {
    id: 'browser-assist',
    label: 'BrowserAssist',
    relParts: ['Saves', 'PluginData', 'JayJayWon', 'BrowserAssist', 'OffloadedVARs'],
  },
  {
    id: 'var-browser',
    label: 'var_browser',
    relParts: ['AllPackages'],
  },
]

/** Absolute path of a tool's offload folder for the given VaM dir. */
export function offloadToolPath(vamDir, tool) {
  return join(vamDir, ...tool.relParts)
}

/**
 * If `path` is the default offload folder of a known tool, return that tool's id,
 * else null. Used so removing such a dir also dismisses its re-suggestion (the
 * folder still exists on disk after un-registering).
 */
export function matchOffloadToolId(path, vamDir) {
  if (!path || !vamDir) return null
  const strip = (p) => p.replace(/[\\/]+$/, '')
  const target = strip(path)
  for (const tool of KNOWN_OFFLOAD_TOOLS) {
    if (strip(offloadToolPath(vamDir, tool)) === target) return tool.id
  }
  return null
}

/** Count `.var` files anywhere under `dir` (cheap confidence signal for the UI). */
async function countVars(dir) {
  try {
    const entries = await readdir(dir, { recursive: true })
    return entries.filter((n) => n.toLowerCase().endsWith('.var')).length
  } catch {
    return 0
  }
}

/**
 * Detect offload folders from known tools that exist on disk and can be added.
 * Callers should `refreshLibraryDirs()` + ensure `vam_dir` is persisted first so
 * `validateNewAuxDirPath` sees the current registry.
 *
 * @param {string|null|undefined} vamDir
 * @returns {Promise<Array<{ id: string, label: string, path: string, varCount: number }>>}
 */
export async function detectOffloadSuggestions(vamDir) {
  if (!vamDir || typeof vamDir !== 'string') return []
  const out = []
  for (const tool of KNOWN_OFFLOAD_TOOLS) {
    const path = offloadToolPath(vamDir, tool)
    if (!existsSync(path)) continue
    try {
      const s = await stat(path)
      if (!s.isDirectory()) continue
    } catch {
      continue
    }
    // Rejects already-registered dirs and any overlap with managed roots.
    if (await validateNewAuxDirPath(path)) continue
    const varCount = await countVars(path)
    out.push({ id: tool.id, label: tool.label, path, varCount })
  }
  return out
}
