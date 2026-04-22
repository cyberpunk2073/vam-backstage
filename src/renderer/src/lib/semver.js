/**
 * Parse "MAJOR.MINOR.PATCH" (semver core only). Strips a leading `v` and any
 * pre-release or build tail after `+` or `-` / `+` (e.g. 1.2.3-beta.1 -> 1.2.3).
 * @param {string | null | undefined} v
 * @returns {readonly [number, number, number] | null}
 */
export function parseVersionCore(v) {
  if (v == null || typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  const withoutV = t.startsWith('v') || t.startsWith('V') ? t.slice(1) : t
  const i = withoutV.search(/[-+]/u)
  const head = i === -1 ? withoutV : withoutV.slice(0, i)
  const m = head.match(/^(\d+)\.(\d+)\.(\d+)$/u)
  if (!m) {
    const m2 = head.match(/^(\d+)\.(\d+)$/u)
    if (!m2) return null
    return [parseInt(m2[1], 10), parseInt(m2[2], 10), 0]
  }
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

/**
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {number} -1 if a < b, 0 if equal, 1 if a > b, NaN if either is invalid
 */
export function compareVersions(a, b) {
  const pa = parseVersionCore(a)
  const pb = parseVersionCore(b)
  if (!pa || !pb) return Number.NaN
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1
    if (pa[i] > pb[i]) return 1
  }
  return 0
}

/**
 * @param {readonly { version: string, date: string, notes: string[] }[]} changelog newest first
 * @param {string} lastSeen
 * @param {string} current
 * @returns {readonly { version: string, date: string, notes: string[] }[]}
 */
export function selectUnseen(changelog, lastSeen, current) {
  const c = parseVersionCore(current)
  if (!c) return []
  return changelog.filter((e) => {
    const gLast = compareVersions(e.version, lastSeen)
    const gCur = compareVersions(e.version, current)
    if (Number.isNaN(gLast) || Number.isNaN(gCur)) return false
    return gLast > 0 && gCur <= 0
  })
}
