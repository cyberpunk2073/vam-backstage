import { describe, it, expect } from 'vitest'
import { applyUpdateEnrichment, applyDepEnrichment } from './hub-availability'

// ── Hub availability reconciliation ───────────────────────────────────────────
//
// `findPackages` substitutes the nearest version it has for one it doesn't, so
// enrichment answers routinely describe a different file than the one asked
// about. These are the two policies that decide what that substitution means.

/** An enrichment answer for a file the Hub can serve. */
function answer(filename, version, extra = {}) {
  return {
    filename,
    version,
    fileSize: 1000,
    downloadUrl: `https://hub.example/${filename}`,
    installedLocally: false,
    ...extra,
  }
}

/** An update entry as `packages:check-updates` produces it, pre-enrichment. */
function entry(currentVersion, hubVersion) {
  return {
    currentVersion,
    hubVersion,
    hubFilename: `A.Pkg.${hubVersion}.var`,
    hubResourceId: '42',
    packageName: 'A.Pkg',
    localNewerFilename: null,
  }
}

describe('applyUpdateEnrichment', () => {
  it('accepts the advertised version when the Hub really has it', () => {
    const res = applyUpdateEnrichment(entry(6, 7), answer('A.Pkg.7.var', 7))
    expect(res.downloadUrl).toBe('https://hub.example/A.Pkg.7.var')
    expect(res.availableFilename).toBe('A.Pkg.7.var')
    expect(res.availableVersion).toBe(7)
  })

  it('marks unavailable when the Hub substitutes the version already installed', () => {
    // The retracted-version case: CDN advertises v7, Hub only has v6, and v6 is
    // exactly what triggered the offer. Left unchecked this renders as a live
    // "Update to v7" button carrying v6's URL.
    const res = applyUpdateEnrichment(entry(6, 7), answer('A.Pkg.6.var', 6, { installedLocally: true }))
    expect(res.downloadUrl).toBeNull()
    expect(res.availableFilename).toBeNull()
  })

  it('marks unavailable when the substitute is not newer, even if absent locally', () => {
    const res = applyUpdateEnrichment(entry(6, 7), answer('A.Pkg.5.var', 5))
    expect(res.downloadUrl).toBeNull()
  })

  it('offers a substitute that is older than advertised but still an upgrade', () => {
    // Installed v3, CDN advertises v7, Hub serves v6 — a real update, just not the
    // one advertised, so the label and install target both follow the resolved file.
    const res = applyUpdateEnrichment(entry(3, 7), answer('A.Pkg.6.var', 6))
    expect(res.availableVersion).toBe(6)
    expect(res.availableFilename).toBe('A.Pkg.6.var')
    expect(res.downloadUrl).toBe('https://hub.example/A.Pkg.6.var')
  })

  it('marks unavailable when the Hub has no download URL', () => {
    const res = applyUpdateEnrichment(entry(6, 7), answer('A.Pkg.7.var', 7, { downloadUrl: null }))
    expect(res.downloadUrl).toBeNull()
    expect(res.fileSize).toBeNull()
  })

  it('clears a prior failed-check flag once the Hub answers', () => {
    const res = applyUpdateEnrichment({ ...entry(6, 7), hubCheckFailed: true }, answer('A.Pkg.7.var', 7))
    expect(res.hubCheckFailed).toBe(false)
  })
})

describe('applyDepEnrichment', () => {
  it('takes a substitute version rather than reporting nothing', () => {
    const hub = { filename: 'A.Pkg.5.var', resourceId: '42', isExact: true, downloadUrl: null }
    const res = applyDepEnrichment(hub, answer('A.Pkg.6.var', 6))
    expect(res.filename).toBe('A.Pkg.6.var')
    expect(res.downloadUrl).toBe('https://hub.example/A.Pkg.6.var')
    expect(res.isExact).toBe(false)
    expect(res.hubVersion).toBe(6)
  })

  it('treats a substitute already on disk as a satisfied fallback, not an install', () => {
    const hub = { filename: 'A.Pkg.5.var', resourceId: '42', isExact: true, downloadUrl: null }
    const res = applyDepEnrichment(hub, answer('A.Pkg.6.var', 6, { installedLocally: true }))
    expect(res.installedLocally).toBe(true)
    expect(res.downloadUrl).toBeNull()
  })

  it('keeps the exact flag and advertised version when the Hub returns what was asked', () => {
    const hub = { filename: 'A.Pkg.5.var', resourceId: '42', isExact: true, hubVersion: 5, downloadUrl: null }
    const res = applyDepEnrichment(hub, answer('A.Pkg.5.var', 5))
    expect(res.isExact).toBe(true)
    expect(res.hubVersion).toBe(5)
  })

  it('keeps the advertised filename when the Hub returned none', () => {
    const hub = { filename: 'A.Pkg.5.var', resourceId: '42', isExact: true, downloadUrl: null }
    const res = applyDepEnrichment(hub, { filename: null, version: null, fileSize: null, downloadUrl: null })
    expect(res.filename).toBe('A.Pkg.5.var')
    expect(res.downloadUrl).toBeNull()
  })
})
