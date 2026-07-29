import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── enqueueInstall targeting ──────────────────────────────────────────────────
//
// The CDN index (`packages.json`) advertises a concrete filename per package
// group, and the Hub does not always still serve it: the resource page can list
// only older files, or the mapped `resource_id` can be gone outright. Neither is
// visible to the update check, so `enqueueInstall` is handed the exact filename
// the UI offered and must either produce that file or fail saying so.
//
// The trap both cases used to fall into is `findPackages`, which answers a
// version it doesn't have with the nearest one it does — so an unguarded
// fallback silently queues some other version, and a resource page listing an
// already-installed sibling reads as "nothing to do, try a re-scan".

const hub = { getResourceDetail: vi.fn(), getResourceDetailByName: vi.fn(), findPackages: vi.fn() }
const db = { insertDownload: vi.fn(), getDownloadByRef: vi.fn(), getAllDownloads: vi.fn(() => []) }
let localFilenames = new Set()

vi.mock('../notify.js', () => ({ notify: vi.fn(), notifyToast: vi.fn() }))

vi.mock('../hub/client.js', async () => ({
  ...(await vi.importActual('../hub/client.js')),
  getResourceDetail: (...a) => hub.getResourceDetail(...a),
  getResourceDetailByName: (...a) => hub.getResourceDetailByName(...a),
  findPackages: (...a) => hub.findPackages(...a),
}))

vi.mock('../db.js', async () => ({
  ...(await vi.importActual('../db.js')),
  insertDownload: (...a) => db.insertDownload(...a),
  getDownloadByRef: (...a) => db.getDownloadByRef(...a),
  getAllDownloads: (...a) => db.getAllDownloads(...a),
  deleteDownload: vi.fn(),
  upsertHubUser: vi.fn(),
}))

vi.mock('../store.js', async () => ({
  ...(await vi.importActual('../store.js')),
  findLocalByFilename: (fn) => (localFilenames.has(fn) ? { filename: fn } : null),
  getPackageIndex: () => new Map(),
  getGroupIndex: () => new Map(),
}))

/** A hubFiles / findPackages entry with a working download URL. */
function file(filename, extra = {}) {
  return { filename, file_size: '1000', downloadUrl: `https://hub.example/${filename}`, ...extra }
}

let enqueueInstall

beforeEach(async () => {
  vi.clearAllMocks()
  localFilenames = new Set()
  db.getAllDownloads.mockReturnValue([])
  db.getDownloadByRef.mockReturnValue(null)
  hub.findPackages.mockResolvedValue({})
  ;({ enqueueInstall } = await import('./manager.js'))
})

const insertedRefs = () => db.insertDownload.mock.calls.map((c) => c[0].packageRef)

describe('enqueueInstall — targetFilename', () => {
  it('queues only the target, ignoring other files on the resource page', async () => {
    // A resource page carrying both the installed version and the new one. Without
    // narrowing, v6 counts as `alreadyLocal` and dilutes the result.
    localFilenames.add('A.Pkg.6.var')
    hub.getResourceDetail.mockResolvedValue({
      resource_id: '42',
      hubFiles: [file('A.Pkg.6.var'), file('A.Pkg.7.var')],
    })

    const res = await enqueueInstall({ resourceId: '42', targetFilename: 'A.Pkg.7.var' })

    expect(res).toMatchObject({ inserted: 1, alreadyLocal: 0, alreadyQueued: 0 })
    expect(insertedRefs()).toEqual(['A.Pkg.7.var'])
  })

  it('reports the target as gone rather than as already installed', async () => {
    // The shape that produced a permanent "already on disk — try a re-scan": the CDN
    // advertises v7, the resource page only has v6, and findPackages clamps v7 → v6.
    localFilenames.add('A.Pkg.6.var')
    hub.getResourceDetail.mockResolvedValue({ resource_id: '42', hubFiles: [file('A.Pkg.6.var')] })
    hub.findPackages.mockResolvedValue({ 'A.Pkg.7': file('A.Pkg.6.var') })

    await expect(enqueueInstall({ resourceId: '42', targetFilename: 'A.Pkg.7.var' })).rejects.toThrow(
      'A.Pkg.7.var is no longer available on the Hub',
    )
    expect(db.insertDownload).not.toHaveBeenCalled()
  })

  it('resolves the target by name when the mapped resource id is gone', async () => {
    // packages.json can point at a deleted resource while the file itself is still
    // reachable by name — the update is downloadable, just not through that id.
    hub.getResourceDetail.mockRejectedValue(new Error('Resource not found.'))
    hub.findPackages.mockResolvedValue({ 'A.Pkg.7': file('A.Pkg.7.var', { resource_id: '99' }) })

    const res = await enqueueInstall({ resourceId: '42', targetFilename: 'A.Pkg.7.var' })

    expect(res).toMatchObject({ inserted: 1, unresolvedDeps: [] })
    expect(db.insertDownload).toHaveBeenCalledWith(expect.objectContaining({ packageRef: 'A.Pkg.7.var' }))
    expect(db.insertDownload.mock.calls[0][0].hubResourceId).toBe('99')
  })

  it('propagates a transport failure instead of treating it as a missing resource', async () => {
    // "Hub API 503" says nothing about whether the resource exists, so it must not
    // be demoted into the by-name fallback and reported as gone.
    hub.getResourceDetail.mockRejectedValue(new Error('Hub API 503: Service Unavailable'))

    await expect(enqueueInstall({ resourceId: '42', targetFilename: 'A.Pkg.7.var' })).rejects.toThrow('Hub API 503')
    expect(hub.findPackages).not.toHaveBeenCalled()
  })

  it('still reports an already-installed target as such', async () => {
    // With the target pinned, "already on disk" is a real index/disk disagreement
    // again, so the re-scan advice the caller toasts is warranted.
    localFilenames.add('A.Pkg.7.var')
    hub.getResourceDetail.mockResolvedValue({ resource_id: '42', hubFiles: [file('A.Pkg.7.var')] })

    const res = await enqueueInstall({ resourceId: '42', targetFilename: 'A.Pkg.7.var' })

    expect(res).toMatchObject({ inserted: 0, alreadyLocal: 1 })
  })

  it('installs whatever the Hub serves a URL for, regardless of listing labels', async () => {
    // Downloadability is the URL's business. A "Paid" / non-hub-downloadable label
    // on the listing used to hard-block the install even when the Hub was handing
    // out a perfectly good link.
    hub.getResourceDetail.mockResolvedValue({
      resource_id: '42',
      category: 'Paid',
      hubDownloadable: 'false',
      hubFiles: [file('A.Pkg.7.var')],
    })

    const res = await enqueueInstall({ resourceId: '42', targetFilename: 'A.Pkg.7.var' })

    expect(res.inserted).toBe(1)
  })

  it('queues every listed file when no target is given', async () => {
    hub.getResourceDetail.mockResolvedValue({
      resource_id: '42',
      hubFiles: [file('A.Pkg.6.var'), file('A.Other.1.var')],
    })

    const res = await enqueueInstall({ resourceId: '42' })

    expect(res.inserted).toBe(2)
    expect(insertedRefs()).toEqual(['A.Pkg.6.var', 'A.Other.1.var'])
  })

  it('fails a dead resource id when there is no target to fall back to', async () => {
    hub.getResourceDetail.mockRejectedValue(new Error('Resource not found.'))

    await expect(enqueueInstall({ resourceId: '42' })).rejects.toThrow('Resource not found.')
  })
})
