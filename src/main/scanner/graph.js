/**
 * Parse a dependency ref string from meta.json.
 * Format: "Author.PackageName.Version" where version is one of:
 *   - digits (exact version)
 *   - "latest" (highest available)
 *   - "minN" where N is digits (at least version N; behaves like .latest with a floor)
 */
export function parseDepRef(ref) {
  if (typeof ref !== 'string') return null
  const parts = ref.split('.')
  if (parts.length < 3) return null
  const last = parts[parts.length - 1]
  const lower = last.toLowerCase()
  const packageName = parts.slice(0, -1).join('.')
  const base = { creator: parts[0], packageName, raw: ref }
  if (last.match(/^\d+$/)) return { ...base, version: last }
  if (lower === 'latest') return { ...base, version: 'latest' }
  const minMatch = lower.match(/^min(\d+)$/)
  if (minMatch) return { ...base, version: 'min', minVersion: parseInt(minMatch[1], 10) }
  return null
}

/** True when a parsed dep-ref's version is a flexible (non-exact) constraint. */
export function isFlexibleRef(parsed) {
  return parsed?.version === 'latest' || parsed?.version === 'min'
}

/**
 * Extract dep refs from meta.json's dependencies field.
 * Handles three formats:
 *  - array: ["ref", ...]
 *  - flat dict: { "ref": "url", ... }
 *  - nested dict (VaM tree): { "ref": { licenseType, dependencies: { ... } }, ... }
 * The nested format is walked recursively so sub-dependencies are included.
 * @param {object} meta - parsed meta.json
 * @param {string} selfFilename - this package's filename (to filter self-refs)
 */
export function extractDepRefs(meta, selfFilename) {
  if (!meta?.dependencies) return []
  const raw = meta.dependencies
  const selfStem = selfFilename.replace(/\.var$/i, '')

  const collected = new Set()
  collectDepKeys(raw, collected)

  const refs = []
  for (const key of collected) {
    const parts = key.split('.')
    if (parts.length >= 3) {
      const last = parts[parts.length - 1]
      const lower = last.toLowerCase()
      if (lower === 'latest') {
        parts[parts.length - 1] = 'latest'
      } else if (/^min\d+$/.test(lower)) {
        parts[parts.length - 1] = lower
      }
    }
    const normalized = parts.join('.')
    if (normalized !== selfStem) refs.push(normalized)
  }
  return refs
}

/** Recursively collect dependency keys from array, flat dict, or nested VaM dict. */
function collectDepKeys(node, out) {
  if (Array.isArray(node)) {
    for (const entry of node) {
      if (typeof entry === 'string') out.add(entry)
    }
  } else if (typeof node === 'object' && node !== null) {
    for (const key of Object.keys(node)) {
      out.add(key)
      const val = node[key]
      if (typeof val === 'object' && val !== null && !Array.isArray(val) && val.dependencies) {
        collectDepKeys(val.dependencies, out)
      }
    }
  }
}

/**
 * Resolve a single dep ref against local packages.
 * @param {string} ref - dep ref like "Author.Pkg.123" or "Author.Pkg.latest"
 * @param {Map<string, object>} packageIndex - filename -> package
 * @param {Map<string, string[]>} groupIndex - packageName -> [filenames]
 * @returns {{ resolved: string|null, resolution: string }}
 */
export function resolveRef(ref, packageIndex, groupIndex) {
  const parsed = parseDepRef(ref)
  if (!parsed) return { resolved: null, resolution: 'invalid' }

  // Flexible refs (.latest, .minN) always go through group resolution — never match a literal
  // ".latest.var" or ".min5.var" file even if one is present on disk.
  if (!isFlexibleRef(parsed)) {
    const exactKey = ref + '.var'
    if (packageIndex.has(exactKey)) {
      return { resolved: exactKey, resolution: 'exact' }
    }
    if (packageIndex.has(ref)) {
      return { resolved: ref, resolution: 'exact' }
    }
  }

  const candidates = groupIndex.get(parsed.packageName) || []
  if (candidates.length === 0) {
    return { resolved: null, resolution: 'missing' }
  }

  if (parsed.version === 'latest') {
    const best = pickHighestVersion(candidates, packageIndex)
    return best ? { resolved: best, resolution: 'latest' } : { resolved: null, resolution: 'missing' }
  }

  if (parsed.version === 'min') {
    const satisfying = pickHighestVersion(candidates, packageIndex, parsed.minVersion)
    if (satisfying) return { resolved: satisfying, resolution: 'latest' }
    // Group exists but no version meets the floor — fall back to the overall highest.
    const best = pickHighestVersion(candidates, packageIndex)
    return best ? { resolved: best, resolution: 'fallback' } : { resolved: null, resolution: 'missing' }
  }

  // Exact numeric version not found, try fallback to any available version
  const best = pickHighestVersion(candidates, packageIndex)
  return best ? { resolved: best, resolution: 'fallback' } : { resolved: null, resolution: 'missing' }
}

function pickHighestVersion(filenames, packageIndex, minVersion = 0) {
  let best = null,
    bestVer = -1
  for (const fn of filenames) {
    const pkg = packageIndex.get(fn)
    if (!pkg) continue
    const v = parseInt(pkg.version, 10)
    if (!isNaN(v) && v >= minVersion && v > bestVer) {
      bestVer = v
      best = fn
    }
  }
  return best
}

/**
 * Build forward dependency map for all packages.
 * @returns {Map<string, Array<{ref, resolved, resolution}>>}
 */
export function buildForwardDeps(packageIndex, groupIndex) {
  const forward = new Map()
  for (const [filename, pkg] of packageIndex) {
    const depRefs = JSON.parse(pkg.dep_refs || '[]')
    const resolved = depRefs.map((ref) => {
      const { resolved: resolvedFn, resolution } = resolveRef(ref, packageIndex, groupIndex)
      return { ref, resolved: resolvedFn, resolution }
    })
    forward.set(filename, resolved)
  }
  return forward
}

/**
 * Build reverse dependency map (who depends on this package).
 * @returns {Map<string, Set<string>>}
 */
export function buildReverseDeps(forwardDeps) {
  const reverse = new Map()
  for (const [filename, deps] of forwardDeps) {
    for (const dep of deps) {
      if (!dep.resolved) continue
      if (!reverse.has(dep.resolved)) reverse.set(dep.resolved, new Set())
      reverse.get(dep.resolved).add(filename)
    }
  }
  return reverse
}

/**
 * Build a group index: packageName -> [filenames] for .latest/.minN resolution.
 */
export function buildGroupIndex(packageIndex) {
  const groups = new Map()
  for (const [filename, pkg] of packageIndex) {
    const name = pkg.package_name
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(filename)
  }
  return groups
}

/**
 * Detect leaf packages (no reverse deps and no other installed packages depend on them).
 * Used during initial scan to classify direct vs dependency.
 * Returns Set of filenames that are leaves (should be is_direct = 1).
 */
export function detectLeaves(packageIndex, reverseDeps) {
  const leaves = new Set()
  for (const filename of packageIndex.keys()) {
    const dependents = reverseDeps.get(filename)
    if (!dependents || dependents.size === 0) {
      leaves.add(filename)
    }
  }
  return leaves
}

/**
 * Compute transitive dependencies of a package.
 */
export function getTransitiveDeps(filename, forwardDeps) {
  const visited = new Set()
  const queue = [filename]
  while (queue.length > 0) {
    const current = queue.pop()
    const deps = forwardDeps.get(current) || []
    for (const dep of deps) {
      if (dep.resolved && !visited.has(dep.resolved)) {
        visited.add(dep.resolved)
        queue.push(dep.resolved)
      }
    }
  }
  return visited
}

/**
 * Compute dependencies to cascade-disable when disabling `filename`.
 * Returns the set of dep filenames whose only enabled dependents are `filename`
 * or other deps already in the cascade set (fixpoint iteration).
 */
export function computeCascadeDisable(filename, packageIndex, forwardDeps, reverseDeps) {
  const toDisable = new Set()
  let changed = true
  while (changed) {
    changed = false
    const transitiveDeps = getTransitiveDeps(filename, forwardDeps)
    for (const dep of transitiveDeps) {
      if (toDisable.has(dep)) continue
      const pkg = packageIndex.get(dep)
      if (!pkg || !pkg.is_enabled) continue
      const dependents = reverseDeps.get(dep) || new Set()
      const hasOtherEnabledDependent = [...dependents].some((d) => {
        if (d === filename || toDisable.has(d)) return false
        const p = packageIndex.get(d)
        return p && p.is_enabled
      })
      if (!hasOtherEnabledDependent) {
        toDisable.add(dep)
        changed = true
      }
    }
  }
  return toDisable
}

/**
 * Compute dependencies to cascade-enable when enabling `filename`.
 * Returns the set of transitive dep filenames that are currently disabled.
 */
export function computeCascadeEnable(filename, packageIndex, forwardDeps) {
  const toEnable = new Set()
  const transitiveDeps = getTransitiveDeps(filename, forwardDeps)
  for (const dep of transitiveDeps) {
    const pkg = packageIndex.get(dep)
    if (pkg && !pkg.is_enabled) toEnable.add(dep)
  }
  return toEnable
}

/**
 * Compute the full cascading set of orphan dependencies.
 * Direct orphans: non-direct packages with no reverse deps.
 * Cascade orphans: non-direct packages whose ALL dependents are in the orphan set.
 * Returns { orphans: Set<string>, directOrphans: Set<string>, totalSize: number }
 */
export function computeOrphanCascade(packageIndex, forwardDeps, reverseDeps) {
  const directOrphans = new Set()
  for (const [filename, pkg] of packageIndex) {
    if (pkg.is_direct) continue
    const dependents = reverseDeps.get(filename)
    if (!dependents || dependents.size === 0) directOrphans.add(filename)
  }

  const toRemove = new Set(directOrphans)
  let changed = true
  while (changed) {
    changed = false
    for (const [filename, pkg] of packageIndex) {
      if (pkg.is_direct || toRemove.has(filename)) continue
      const dependents = reverseDeps.get(filename) || new Set()
      if (dependents.size === 0) continue
      if ([...dependents].every((d) => toRemove.has(d))) {
        toRemove.add(filename)
        changed = true
      }
    }
  }

  let totalSize = 0
  for (const fn of toRemove) {
    const pkg = packageIndex.get(fn)
    if (pkg) totalSize += pkg.size_bytes
  }

  return { orphans: toRemove, directOrphans, totalSize }
}

/**
 * Compute which deps would become orphans if `filename` is removed.
 * Returns { removableFilenames: Set<string>, removableSize: number }
 */
export function computeRemovableDeps(filename, packageIndex, forwardDeps, reverseDeps) {
  const toRemove = new Set([filename])
  let changed = true
  while (changed) {
    changed = false
    const transitiveDeps = getTransitiveDeps(filename, forwardDeps)
    for (const dep of transitiveDeps) {
      if (toRemove.has(dep)) continue
      const pkg = packageIndex.get(dep)
      if (!pkg || pkg.is_direct) continue
      const dependents = reverseDeps.get(dep) || new Set()
      const allInRemoveSet = [...dependents].every((d) => toRemove.has(d))
      if (allInRemoveSet) {
        toRemove.add(dep)
        changed = true
      }
    }
  }
  toRemove.delete(filename) // don't include the target itself

  let removableSize = 0
  for (const fn of toRemove) {
    const pkg = packageIndex.get(fn)
    if (pkg) removableSize += pkg.size_bytes
  }
  return { removableFilenames: toRemove, removableSize }
}
