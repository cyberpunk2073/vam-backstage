/**
 * Reconciling `packages:enrich-from-hub` answers against what was asked for.
 *
 * The Hub's `findPackages` does not fail on a version it doesn't have — it
 * answers with the nearest one it does (`Creator.Pkg.9999` comes back as
 * `Creator.Pkg.6.var`, with a working URL for v6). So the stem we asked about
 * says nothing about what a download would produce, and every caller has to
 * decide against the *resolved* file instead: `{ filename, version, fileSize,
 * downloadUrl, installedLocally }`.
 *
 * Updates and missing deps want opposite things from that substitution, which is
 * why they don't share one rule:
 *  - an update is only an update if the resolved file beats what's installed,
 *  - a missing dep takes whatever the Hub will give, since some version beats none.
 */

/**
 * Fold one enrichment answer into an update entry from `packages:check-updates`.
 *
 * Three ways the resolved file fails to be an update, all landing on
 * `downloadUrl: null` so the UI renders it as unavailable rather than offering a
 * button that dead-ends in the install path:
 *
 *  - the Hub has no download for it (paid, externally hosted, unknown package),
 *  - it's already on disk — the common shape when the CDN index advertises a
 *    version the Hub retracted, because the substitution then lands on the very
 *    version that triggered the update offer,
 *  - it isn't newer than what's installed.
 *
 * Otherwise it's a genuine upgrade even when older than the advertised version,
 * so it becomes the install target (`availableFilename`) and the label's version.
 */
export function applyUpdateEnrichment(entry, detail) {
  const { filename = null, version = null } = detail
  const usable = !!detail.downloadUrl && !detail.installedLocally && version > entry.currentVersion
  return {
    ...entry,
    downloadUrl: usable ? detail.downloadUrl : null,
    fileSize: usable ? detail.fileSize : null,
    availableFilename: usable ? filename : null,
    availableVersion: usable ? version : null,
    hubCheckFailed: false,
  }
}

/**
 * Fold one enrichment answer into a missing-dep row's `hub` block.
 *
 * A dep the CDN index listed at v5 is still worth installing when the Hub only
 * has v6, so the resolved file simply replaces the advertised one whatever its
 * version. The single disqualifier is it already being on disk, which means the
 * dep is satisfied by fallback and there's nothing to install.
 */
export function applyDepEnrichment(hub, detail) {
  const filename = detail.filename || hub.filename
  const isExact = filename === hub.filename && hub.isExact
  return {
    ...hub,
    filename,
    isExact,
    hubVersion: isExact ? hub.hubVersion : (detail.version ?? hub.hubVersion),
    installedLocally: hub.installedLocally || detail.installedLocally,
    fileSize: detail.fileSize,
    downloadUrl: detail.installedLocally ? null : detail.downloadUrl,
  }
}

// --- Update entry states ---
//
// `downloadUrl` is the tri-state every Update control reads: `undefined` = the
// hub hasn't answered yet, `null` = it answered and there's nothing to install,
// a string = go. Shared by the detail panel, the cards and the context menu so
// they can't drift into disagreeing about whether a button should be live.
//
// Entries with `localNewerFilename` are excluded throughout: a newer version is
// already on disk, so those render a promote action and never consult the hub.

/** Definitively not installable — paid/external, resolved to something that isn't
 *  an upgrade, or the hub couldn't be reached. */
export function isUpdateUnavailable(updateInfo) {
  if (!updateInfo || updateInfo.localNewerFilename) return false
  return updateInfo.downloadUrl === null
}

/** Narrows `isUpdateUnavailable` to the case where the hub never answered. Nothing
 *  is installable either way, but "we couldn't check" is a claim about us and "not
 *  available" is a claim about the hub — conflating them tells the user a version
 *  doesn't exist on the strength of their own dropped connection. */
export function isUpdateCheckFailed(updateInfo) {
  return isUpdateUnavailable(updateInfo) && !!updateInfo.hubCheckFailed
}

/** Enrichment hasn't returned yet — only on the first check, since later ones
 *  merge prior enrichment forward. */
export function isUpdateChecking(updateInfo) {
  if (!updateInfo || updateInfo.localNewerFilename) return false
  return updateInfo.downloadUrl === undefined
}

/** Resolved to a concrete hub URL. Bulk actions need this positive form: "not
 *  unavailable" also admits entries still being checked, and installing those
 *  queues whatever the hub answers with — including files it can't serve. */
export function isUpdateDownloadable(updateInfo) {
  if (!updateInfo || updateInfo.localNewerFilename) return false
  return typeof updateInfo.downloadUrl === 'string'
}

/** The version an update would actually install, which differs from the
 *  CDN-advertised `hubVersion` when the hub substituted an older file. */
export function updateTargetVersion(updateInfo) {
  return updateInfo?.availableVersion ?? updateInfo?.hubVersion
}

/** The concrete `.var` an update would fetch. Falls back to the advertised name
 *  only before enrichment has answered. */
export function updateTargetFilename(updateInfo) {
  return updateInfo?.availableFilename || updateInfo?.hubFilename || null
}
