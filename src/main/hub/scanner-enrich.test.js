import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkTempVamDir, openTestDatabase } from '../../../test/fixtures/index.js'
import { closeDatabase, getDb, markHubNameChecked } from '../db.js'
import { setPackagesIndexForTests } from './packages-json.js'

vi.mock('./client.js', () => ({
  getResourceDetail: vi.fn(),
  getResourceDetailByName: vi.fn(async () => null),
  getCachedDetail: vi.fn(() => null),
}))

vi.mock('../thumb-resolver.js', () => ({
  resolvePackageThumbnails: vi.fn(),
}))

import { getResourceDetailByName } from './client.js'
import { enrichNewPackages } from './scanner.js'

let tmp

beforeEach(async () => {
  tmp = await mkTempVamDir()
  await openTestDatabase(tmp.dbPath)
  setPackagesIndexForTests({ index: new Map(), fnIndex: new Map() })
  getResourceDetailByName.mockClear()
  getResourceDetailByName.mockResolvedValue(null)
})

afterEach(async () => {
  setPackagesIndexForTests({ index: null, fnIndex: null })
  closeDatabase()
  if (tmp) await tmp.cleanup()
  delete process.env.VAM_DB_PATH
})

function insertPkg(filename, { hubResourceId = null, hubNameCheckedAt = null } = {}) {
  const stem = filename.replace(/\.var$/i, '')
  const parts = stem.split('.')
  const version = parts.pop()
  const packageName = parts.join('.')
  getDb()
    .prepare(
      `INSERT INTO packages (filename, creator, package_name, version, size_bytes, file_mtime, hub_resource_id, hub_name_checked_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
    )
    .run(filename, parts[0], packageName, version, hubResourceId, hubNameCheckedAt)
}

describe('enrichNewPackages name-lookup tombstones', () => {
  it('skips name lookup when hub_name_checked_at is already set', async () => {
    insertPkg('Local.Only.1.var', { hubNameCheckedAt: 100 })
    enrichNewPackages(['Local.Only.1.var'])
    // runNameResolution is async; give the microtask queue a turn.
    await Promise.resolve()
    await Promise.resolve()
    expect(getResourceDetailByName).not.toHaveBeenCalled()
  })

  it('name-looks up unlinked packages that have never been checked', async () => {
    insertPkg('Paid.Look.1.var')
    enrichNewPackages(['Paid.Look.1.var'])
    await vi.waitFor(() => {
      expect(getResourceDetailByName).toHaveBeenCalledWith('Paid.Look')
    })
  })

  it('still links from the CDN index even when a prior name miss was stamped', () => {
    insertPkg('Now.Free.1.var', { hubNameCheckedAt: 100 })
    setPackagesIndexForTests({
      data: { 'Now.Free.1.var': '999' },
    })
    enrichNewPackages(['Now.Free.1.var'])
    expect(getDb().prepare(`SELECT hub_resource_id FROM packages WHERE filename = ?`).get('Now.Free.1.var')).toEqual({
      hub_resource_id: '999',
    })
    expect(getResourceDetailByName).not.toHaveBeenCalled()
  })

  it('does not clear an existing hub_name_checked_at when skipped', () => {
    insertPkg('Local.Only.1.var', { hubNameCheckedAt: 42 })
    enrichNewPackages(['Local.Only.1.var'])
    expect(
      getDb().prepare(`SELECT hub_name_checked_at FROM packages WHERE filename = ?`).get('Local.Only.1.var')
        .hub_name_checked_at,
    ).toBe(42)
    // Sanity: markHubNameChecked still works for the positive path.
    markHubNameChecked('Local.Only.1.var')
    expect(
      getDb().prepare(`SELECT hub_name_checked_at FROM packages WHERE filename = ?`).get('Local.Only.1.var')
        .hub_name_checked_at,
    ).toBeGreaterThan(42)
  })
})
