import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkTempVamDir, openTestDatabase } from '../../test/fixtures/index.js'
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  closeDatabase,
  getDb,
  insertDownload,
  setHubResourceId,
  setHubUserId,
  toIntString,
  upsertHubResourceDetail,
  upsertHubUser,
} from './db.js'

// ⚠ NODE_MODULE_VERSION mismatch? Use `npm test` (Electron-as-Node).

let tmp

afterEach(async () => {
  closeDatabase()
  if (tmp) await tmp.cleanup()
  delete process.env.VAM_DB_PATH
})

// ── toIntString (the id normalizer) ────────────────────────────────────────────

describe('toIntString', () => {
  it('passes non-negative integer strings through, stringifying and trimming', () => {
    expect(toIntString('123')).toBe('123')
    expect(toIntString('0')).toBe('0')
    expect(toIntString(123)).toBe('123')
    expect(toIntString('  42  ')).toBe('42')
  })

  it('returns null for nullish and the stringified-nullish garbage that caused the bug', () => {
    for (const v of [null, undefined, '', 'null', 'undefined']) expect(toIntString(v)).toBeNull()
  })

  it('rejects non-integer numeric-ish strings', () => {
    for (const v of ['1.0', '-1', '1e3', '12a', '0x10']) expect(toIntString(v)).toBeNull()
  })
})

// ── v22 migration: hub_name_checked_at (idempotent) ───────────────────────────
//
// If applyV22 added the column but crashed before schema_version was bumped, the
// next launch must not fail on "duplicate column name".

describe('migrate v22 (hub_name_checked_at)', () => {
  beforeEach(async () => {
    tmp = await mkTempVamDir()
    buildV22Database(tmp.dbPath)
    const raw = new Database(tmp.dbPath)
    raw.prepare('UPDATE schema_version SET version = 21').run()
    raw.close()
    await openTestDatabase(tmp.dbPath)
  })

  it('retries cleanly when the column exists but schema_version is still 21', () => {
    expect(getDb().pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('adopts the legacy schema_version table into user_version and drops it', () => {
    expect(
      getDb().prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'`).get(),
    ).toBeUndefined()
  })
})

// ── newer-than-supported schema ────────────────────────────────────────────────

describe('unsupported newer schema', () => {
  beforeEach(async () => {
    tmp = await mkTempVamDir()
    const raw = new Database(tmp.dbPath)
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    raw.close()
  })

  it('refuses to open a database migrated by a newer app', async () => {
    await expect(openTestDatabase(tmp.dbPath)).rejects.toThrow(
      new RegExp(`newer than this app supports \\(v${SCHEMA_VERSION}\\)`),
    )
  })
})

// ── fresh install (no legacy table, user_version=0) ────────────────────────────

describe('fresh database', () => {
  beforeEach(async () => {
    tmp = await mkTempVamDir()
    await openTestDatabase(tmp.dbPath)
  })

  it('builds the latest schema in one step and stamps user_version', () => {
    expect(getDb().pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('never creates the legacy schema_version table', () => {
    expect(
      getDb().prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'`).get(),
    ).toBeUndefined()
  })
})

// ── v23 migration: hub-id scrub + cache-table CHECK ────────────────────────────
//
// Builds a realistic pre-v23 (schema_version=22) DB by hand with the bogus
// string ids that affinity used to allow, runs the real migrate() via
// openDatabase, and asserts the cleanup + the new guardrail.

/** Hand-build the subset of the v22 schema that applyV23 + ensureLocalPackage touch. */
function buildV22Database(dbPath) {
  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE packages (
      filename TEXT PRIMARY KEY,
      creator TEXT NOT NULL,
      package_name TEXT NOT NULL,
      version TEXT NOT NULL,
      type TEXT, title TEXT, description TEXT, license TEXT,
      size_bytes INTEGER NOT NULL,
      file_mtime REAL NOT NULL,
      is_direct INTEGER NOT NULL DEFAULT 0,
      storage_state TEXT NOT NULL DEFAULT 'enabled',
      library_dir_id INTEGER,
      hub_resource_id TEXT,
      dep_refs TEXT NOT NULL DEFAULT '[]',
      first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      scanned_at INTEGER, image_url TEXT,
      thumb_checked INTEGER NOT NULL DEFAULT 0,
      hub_user_id TEXT, hub_display_name TEXT, hub_tags TEXT, promotional_link TEXT,
      type_override TEXT, is_corrupted INTEGER NOT NULL DEFAULT 0,
      hub_detail_applied_at INTEGER, hub_name_checked_at INTEGER
    );
    CREATE TABLE downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_ref TEXT NOT NULL UNIQUE,
      hub_resource_id TEXT, download_url TEXT, file_size INTEGER,
      priority TEXT NOT NULL DEFAULT 'dependency', parent_ref TEXT,
      status TEXT NOT NULL DEFAULT 'queued', temp_path TEXT, error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), completed_at INTEGER,
      display_name TEXT, auto_queue_deps INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE hub_resources (
      resource_id TEXT PRIMARY KEY, hub_json TEXT, search_json TEXT, find_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE hub_users (
      user_id TEXT PRIMARY KEY, username TEXT, hub_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (22);
  `)

  const pkg = raw.prepare(
    `INSERT INTO packages (filename, creator, package_name, version, size_bytes, file_mtime, hub_resource_id, hub_user_id)
     VALUES (?, 'C', 'C.P', '1', 1, 0, ?, ?)`,
  )
  pkg.run('Good.Pkg.1.var', '123', '45')
  pkg.run('Bad.Pkg.1.var', 'null', 'null')
  pkg.run('Empty.Pkg.1.var', '', null)

  const dl = raw.prepare(`INSERT INTO downloads (package_ref, hub_resource_id) VALUES (?, ?)`)
  dl.run('Good.Ref', '77')
  dl.run('Bad.Ref', 'null')

  const hr = raw.prepare(`INSERT INTO hub_resources (resource_id) VALUES (?)`)
  for (const id of ['100', '200', 'null', '', '12a']) hr.run(id)

  const hu = raw.prepare(`INSERT INTO hub_users (user_id) VALUES (?)`)
  for (const id of ['5', 'null']) hu.run(id)

  raw.close()
}

describe('migrate v23 (hub-id cleanup)', () => {
  beforeEach(async () => {
    tmp = await mkTempVamDir()
    buildV22Database(tmp.dbPath)
    await openTestDatabase(tmp.dbPath)
  })

  it('bumps schema_version to the latest', () => {
    expect(getDb().pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('nulls non-numeric ids in packages without dropping rows', () => {
    const db = getDb()
    const rows = Object.fromEntries(
      db
        .prepare('SELECT filename, hub_resource_id, hub_user_id FROM packages')
        .all()
        .map((r) => [r.filename, r]),
    )
    expect(rows['Good.Pkg.1.var']).toMatchObject({ hub_resource_id: '123', hub_user_id: '45' })
    expect(rows['Bad.Pkg.1.var']).toMatchObject({ hub_resource_id: null, hub_user_id: null })
    expect(rows['Empty.Pkg.1.var']).toMatchObject({ hub_resource_id: null, hub_user_id: null })
  })

  it('nulls non-numeric ids in downloads without dropping rows', () => {
    const db = getDb()
    expect(
      db.prepare(`SELECT hub_resource_id FROM downloads WHERE package_ref = 'Good.Ref'`).get().hub_resource_id,
    ).toBe('77')
    expect(
      db.prepare(`SELECT hub_resource_id FROM downloads WHERE package_ref = 'Bad.Ref'`).get().hub_resource_id,
    ).toBeNull()
  })

  it('drops invalid-PK rows from the cache tables', () => {
    const db = getDb()
    expect(
      db
        .prepare('SELECT resource_id FROM hub_resources ORDER BY resource_id')
        .all()
        .map((r) => r.resource_id),
    ).toEqual(['100', '200'])
    expect(
      db
        .prepare('SELECT user_id FROM hub_users')
        .all()
        .map((r) => r.user_id),
    ).toEqual(['5'])
  })

  it('enforces the numeric CHECK on hub_resources / hub_users going forward', () => {
    const db = getDb()
    expect(() => db.prepare(`INSERT INTO hub_resources (resource_id) VALUES ('null')`).run()).toThrow(
      /CONSTRAINT|constraint/,
    )
    expect(() => db.prepare(`INSERT INTO hub_users (user_id) VALUES ('')`).run()).toThrow(/CONSTRAINT|constraint/)
    expect(() => db.prepare(`INSERT INTO hub_resources (resource_id) VALUES ('999')`).run()).not.toThrow()
  })
})

// ── v24 migration: packages.subpath ───────────────────────────────────────────
//
// A pre-v24 DB has no `subpath` column. After migrate(), the column exists and
// every existing row backfills to '' (the historical flat-library assumption).

describe('migrate v24 (package subpath)', () => {
  beforeEach(async () => {
    tmp = await mkTempVamDir()
    buildV22Database(tmp.dbPath)
    await openTestDatabase(tmp.dbPath)
  })

  it('adds a subpath column to packages', () => {
    const cols = getDb()
      .prepare(`PRAGMA table_info(packages)`)
      .all()
      .map((c) => c.name)
    expect(cols).toContain('subpath')
  })

  it('backfills existing rows to an empty subpath', () => {
    const rows = getDb().prepare('SELECT filename, subpath FROM packages').all()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.subpath).toBe('')
  })

  it('sets needs_rescan so the next scan re-derives nested subpaths', () => {
    expect(getDb().prepare(`SELECT value FROM settings WHERE key = 'needs_rescan'`).get()?.value).toBe('1')
  })
})

// ── schema parity: createSchema() ↔ sum of MIGRATIONS ──────────────────────────
//
// createSchema() (fresh install) and the incremental MIGRATIONS are two
// hand-maintained descriptions of the same schema; they silently drift when a
// migration is added but not mirrored into createSchema (or vice versa). This
// replays every migration on top of a frozen v22 baseline and asserts the result
// is schema-identical to a fresh install.
//
// The comparison is order-independent on purpose: `ALTER TABLE ADD COLUMN`
// appends to the CREATE text stored in sqlite_master, so a migrated table lists
// its columns in a different order than a freshly-created one. A raw SQL string
// diff would flag that as drift. `schemaFingerprint` instead reduces each table
// to the *set* of its top-level definitions (columns + table constraints),
// whitespace-normalized, so only content matters — not column order or the
// `IF NOT EXISTS` / rename cosmetics migrations leave behind.

/** Split a CREATE-TABLE body on top-level commas (respecting nested parens + quotes). */
function splitTopLevelCommas(body) {
  const parts = []
  let depth = 0
  let quote = null
  let cur = ''
  for (const ch of body) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

/** Column/constraint definitions of a table, whitespace-normalized and sorted (order-independent). */
function canonicalTableDefs(sql) {
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'))
  return splitTopLevelCommas(body)
    .map((d) => d.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .sort()
}

function normalizeSql(sql) {
  return sql
    .replace(/\bIF NOT EXISTS\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** { tables: name→sorted defs, indexes: name→normalized sql } for every user object in `db`. */
function schemaFingerprint(db) {
  const rows = db
    .prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`)
    .all()
  const tables = {}
  const indexes = {}
  for (const { type, name, sql } of rows) {
    if (type === 'table') tables[name] = canonicalTableDefs(sql)
    else if (type === 'index') indexes[name] = normalizeSql(sql)
  }
  return { tables, indexes }
}

/**
 * Frozen, complete v22 schema — this is *history*, copied verbatim from the
 * createSchema() at commit 24c8447^ (the last v22 build, before the v23 bump).
 * Do NOT edit it when createSchema() changes: new schema changes ship as new
 * migrations, which the parity test replays on top of this baseline. Only
 * re-baseline (to a newer verbatim snapshot) when old migrations are pruned.
 * The v22→head deltas: hub-id CHECK (v23), packages.subpath (v24), hub_wishlist
 * (v25). idx_hub_users_username already existed at v22 (v23 only re-ensures it).
 */
function buildV22Schema(dbPath) {
  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE library_dirs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE packages (
      filename TEXT PRIMARY KEY,
      creator TEXT NOT NULL,
      package_name TEXT NOT NULL,
      version TEXT NOT NULL,
      type TEXT,
      title TEXT,
      description TEXT,
      license TEXT,
      size_bytes INTEGER NOT NULL,
      file_mtime REAL NOT NULL,
      is_direct INTEGER NOT NULL DEFAULT 0,
      storage_state TEXT NOT NULL DEFAULT 'enabled',
      library_dir_id INTEGER NULL REFERENCES library_dirs(id) ON DELETE RESTRICT,
      hub_resource_id TEXT,
      dep_refs TEXT NOT NULL DEFAULT '[]',
      first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
      scanned_at INTEGER,
      image_url TEXT,
      thumb_checked INTEGER NOT NULL DEFAULT 0,
      hub_user_id TEXT,
      hub_display_name TEXT,
      hub_tags TEXT,
      promotional_link TEXT,
      type_override TEXT,
      is_corrupted INTEGER NOT NULL DEFAULT 0,
      hub_detail_applied_at INTEGER,
      hub_name_checked_at INTEGER
    );
    CREATE INDEX idx_packages_package_name ON packages(package_name);
    CREATE INDEX idx_packages_creator ON packages(creator);

    CREATE TABLE contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_filename TEXT NOT NULL REFERENCES packages(filename) ON DELETE CASCADE,
      internal_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      type TEXT NOT NULL,
      thumbnail_path TEXT,
      person_atom_ids TEXT,
      file_mtime REAL NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      UNIQUE(package_filename, internal_path)
    );
    CREATE INDEX idx_contents_package ON contents(package_filename);
    CREATE INDEX idx_contents_type ON contents(type);

    CREATE TABLE downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_ref TEXT NOT NULL UNIQUE,
      hub_resource_id TEXT,
      download_url TEXT,
      file_size INTEGER,
      priority TEXT NOT NULL DEFAULT 'dependency',
      parent_ref TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      temp_path TEXT,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER,
      display_name TEXT,
      auto_queue_deps INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE hub_resources (
      resource_id TEXT PRIMARY KEY,
      hub_json TEXT,
      search_json TEXT,
      find_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE hub_users (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      hub_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_hub_users_username ON hub_users(username);

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE label_packages (
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      package_filename TEXT NOT NULL REFERENCES packages(filename) ON DELETE CASCADE,
      PRIMARY KEY (label_id, package_filename)
    );
    CREATE INDEX idx_label_packages_pkg ON label_packages(package_filename);

    CREATE TABLE label_contents (
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      package_filename TEXT NOT NULL REFERENCES packages(filename) ON DELETE CASCADE,
      internal_path TEXT NOT NULL,
      PRIMARY KEY (label_id, package_filename, internal_path)
    );
    CREATE INDEX idx_label_contents_pkgpath ON label_contents(package_filename, internal_path);
  `)
  raw.pragma('user_version = 22')
  raw.close()
}

describe('schema parity (createSchema ↔ migrations)', () => {
  it('MIGRATIONS ends exactly at SCHEMA_VERSION', () => {
    expect(MIGRATIONS.at(-1)[0]).toBe(SCHEMA_VERSION)
  })

  it('a v22 DB migrated to head is schema-identical to a fresh install', async () => {
    tmp = await mkTempVamDir()
    await openTestDatabase(tmp.dbPath)
    const fresh = schemaFingerprint(getDb())
    closeDatabase()

    const migratedTmp = await mkTempVamDir()
    try {
      buildV22Schema(migratedTmp.dbPath)
      await openTestDatabase(migratedTmp.dbPath)
      expect(schemaFingerprint(getDb())).toEqual(fresh)
    } finally {
      closeDatabase()
      await migratedTmp.cleanup()
    }
  })
})

// ── writer guards (toIntString at the DB chokepoints) ──────────────────────────

describe('hub-id writer guards', () => {
  beforeEach(async () => {
    tmp = await mkTempVamDir()
    await openTestDatabase(tmp.dbPath)
    getDb()
      .prepare(
        `INSERT INTO packages (filename, creator, package_name, version, size_bytes, file_mtime) VALUES ('P.1.var','C','C.P','1',1,0)`,
      )
      .run()
  })

  const ridOf = (filename) =>
    getDb().prepare('SELECT hub_resource_id FROM packages WHERE filename = ?').get(filename).hub_resource_id
  const uidOf = (filename) =>
    getDb().prepare('SELECT hub_user_id FROM packages WHERE filename = ?').get(filename).hub_user_id

  it('setHubResourceId ignores junk and never clears a good link', () => {
    expect(setHubResourceId('P.1.var', 'null')).toBe(0)
    expect(ridOf('P.1.var')).toBeNull()

    expect(setHubResourceId('P.1.var', '555')).toBe(1)
    expect(ridOf('P.1.var')).toBe('555')

    // junk after a good link is a no-op, not a clear
    expect(setHubResourceId('P.1.var', 'null')).toBe(0)
    expect(ridOf('P.1.var')).toBe('555')
  })

  it('setHubUserId ignores junk', () => {
    setHubUserId('P.1.var', 'undefined')
    expect(uidOf('P.1.var')).toBeNull()
    setHubUserId('P.1.var', '42')
    expect(uidOf('P.1.var')).toBe('42')
  })

  it('insertDownload coerces a junk hub_resource_id to null', () => {
    const base = { downloadUrl: null, fileSize: null, priority: 'dependency', parentRef: null, displayName: null }
    insertDownload({ ...base, packageRef: 'Junk.Ref', hubResourceId: 'null' })
    insertDownload({ ...base, packageRef: 'Ok.Ref', hubResourceId: '88' })
    const db = getDb()
    expect(
      db.prepare(`SELECT hub_resource_id FROM downloads WHERE package_ref = 'Junk.Ref'`).get().hub_resource_id,
    ).toBeNull()
    expect(db.prepare(`SELECT hub_resource_id FROM downloads WHERE package_ref = 'Ok.Ref'`).get().hub_resource_id).toBe(
      '88',
    )
  })

  // The cache writers are fed raw Hub API responses, where a missing field can
  // arrive as the string 'null' via String(x). They must no-op rather than throw
  // against the new CHECK constraint.
  it('upsertHubResourceDetail / upsertHubUser no-op on junk ids without throwing', () => {
    const db = getDb()
    expect(() => upsertHubResourceDetail('null', { x: 1 })).not.toThrow()
    expect(() => upsertHubResourceDetail(null, { x: 1 })).not.toThrow()
    expect(() => upsertHubUser('undefined', 'name', { x: 1 })).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM hub_resources').get().n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM hub_users').get().n).toBe(0)

    upsertHubResourceDetail('321', { x: 1 })
    upsertHubUser('654', 'name', { x: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM hub_resources').get().n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM hub_users').get().n).toBe(1)
  })
})
