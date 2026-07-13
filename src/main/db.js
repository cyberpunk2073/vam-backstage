import Database from 'better-sqlite3'
import { existsSync, unlinkSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'
import { LOCAL_PACKAGE_FILENAME, LOCAL_PACKAGE_DISPLAY_NAME } from '@shared/local-package.js'

export const SCHEMA_VERSION = 25

/**
 * Normalize a value to a non-negative integer string, or null. Hub resource/user
 * ids are integers but arrive as strings; an unguarded `String(x)` of a nullish
 * value yields the literal 'null'/'undefined' that then slips past `IS NOT NULL`
 * filters once stored. This is the single chokepoint that rejects that garbage.
 */
export function toIntString(value) {
  if (value == null) return null
  const s = String(value).trim()
  return /^[0-9]+$/.test(s) ? s : null
}

/** SQL fragment asserting `col` holds a non-negative integer string (GLOB twin of toIntString). */
function intCheckSql(col) {
  return `${col} GLOB '[0-9]*' AND ${col} NOT GLOB '*[^0-9]*'`
}

let db

/**
 * DB path resolution. In production we live under Electron's userData dir.
 * Tests set `VAM_DB_PATH` (or call `setDatabasePathOverride`) to point at a
 * tempdir before opening, so they don't need to spin up Electron just to
 * exercise SQLite-backed code paths.
 */
let dbPathOverride = null

export function setDatabasePathOverride(path) {
  dbPathOverride = path || null
}

export function getDatabasePath() {
  if (dbPathOverride) return dbPathOverride
  if (process.env.VAM_DB_PATH) return process.env.VAM_DB_PATH
  return join(app.getPath('userData'), 'backstage.db')
}

export function deleteDatabaseFiles() {
  const base = getDatabasePath()
  for (const p of [base, `${base}-wal`, `${base}-shm`]) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch (err) {
      console.warn('deleteDatabaseFiles:', p, err.message)
    }
  }
}

/**
 * Open the SQLite database. `new Database(path)` dlopens the native
 * `better_sqlite3.node` binding, compiled for one specific NODE_MODULE_VERSION.
 *
 * Both `npm run dev` and `npm test` run under Electron's bundled Node (the
 * test script launches Vitest via `ELECTRON_RUN_AS_NODE=1 electron …`), so
 * the binding produced by `postinstall` (`electron-builder install-app-deps`,
 * Electron ABI — 140 for Electron 39) is the only one we ever need. There's
 * no host-Node-vs-Electron rebuild dance.
 *
 * If you ever invoke Vitest directly under host Node (`npx vitest`, plain
 * `vitest` watch mode, IDE test integrations), you'll hit a
 * NODE_MODULE_VERSION mismatch — use `npm test` instead.
 */
export function openDatabase() {
  const dbPath = getDatabasePath()
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate()
  return db
}

export function getDb() {
  return db
}

export function closeDatabase() {
  if (db) {
    db.close()
    db = null
  }
  stmtCache.clear()
}

/** Pre-release DBs with version 1–15 cannot be upgraded; delete backstage.db and restart. */
const LEGACY_SCHEMA_CUTOFF = 16

/** Read the on-disk schema version. 0 (the SQLite default) means "brand-new DB". */
function getSchemaVersion() {
  return db.pragma('user_version', { simple: true })
}

/**
 * Stamp the schema version into the DB header. `PRAGMA user_version` is a
 * header-field write that participates in the surrounding transaction (it rolls
 * back with it), so pairing it with each migration step keeps the step atomic.
 * The value is interpolated because PRAGMA doesn't bind parameters — it's always
 * our own trusted integer (a MIGRATIONS target or SCHEMA_VERSION), never input.
 */
function setSchemaVersion(version) {
  db.pragma(`user_version = ${version}`)
}

/**
 * Older builds tracked the version in a `schema_version` table rather than
 * `PRAGMA user_version`. On first open under the new scheme such a DB reports
 * user_version 0 (the default) and would be mistaken for a fresh install, so we
 * adopt the table's value into user_version and drop the table — once. The
 * table's presence is the legacy marker; a genuinely fresh DB never has it.
 */
function adoptLegacySchemaVersion() {
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'`).get()
  if (!hasTable) return
  db.transaction(() => {
    const row = db.prepare('SELECT version FROM schema_version').get()
    if (row?.version) setSchemaVersion(row.version)
    db.exec('DROP TABLE schema_version')
  })()
}

/**
 * Ordered incremental migrations: `[targetVersion, apply]`. Each step is run by
 * migrate() inside its own transaction together with the matching
 * `setSchemaVersion` bump, so a step is all-or-nothing. A crash mid-step rolls
 * the whole step back (SQLite DDL is transactional) and the next launch retries
 * from the same version boundary against an unchanged schema — never a
 * half-applied step layered on a partially-mutated table. To add a migration,
 * append a row here and reflect the same shape in createSchema().
 */
export const MIGRATIONS = [
  [17, applyV17],
  [18, applyV18],
  [19, applyV19],
  [20, applyV20],
  [21, applyV21],
  [22, applyV22],
  [23, applyV23],
  [24, applyV24],
  [25, applyV25],
]

function migrate() {
  if (getSchemaVersion() === 0) adoptLegacySchemaVersion()
  const current = getSchemaVersion()

  if (current === SCHEMA_VERSION) return

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Schema version ${current} is newer than this app supports (v${SCHEMA_VERSION}). ` +
        `Update the app to open this database.`,
    )
  }

  if (current === 0) {
    db.transaction(() => {
      createSchema()
      setSchemaVersion(SCHEMA_VERSION)
    })()
  } else {
    if (current < LEGACY_SCHEMA_CUTOFF) {
      throw new Error(
        `Schema version ${current} is from a pre-release build and cannot be migrated. ` +
          `Delete "${getDatabasePath()}" and restart the app.`,
      )
    }
    for (const [version, apply] of MIGRATIONS) {
      if (current < version) {
        db.transaction(() => {
          apply()
          setSchemaVersion(version)
        })()
      }
    }
  }

  ensureLocalPackage()
}

function applyV17() {
  db.exec('ALTER TABLE contents ADD COLUMN person_atom_ids TEXT')
  db.prepare('UPDATE packages SET file_mtime = 0').run()
}

/**
 * v18 — add `file_mtime` + `size_bytes` to `contents`. Used only for loose
 * (`__local__`) rows: lets the local scanner skip `readFile` + JSON parse for
 * scene-like items whose stat hasn't moved since the last scan, mirroring the
 * package-level mtime gate `.var` packages already get in `runScan()`.
 * Var-owned rows leave both at 0 — the package gate covers them.
 */
function applyV18() {
  db.exec(`
    ALTER TABLE contents ADD COLUMN file_mtime REAL NOT NULL DEFAULT 0;
    ALTER TABLE contents ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;
  `)
}

/**
 * v19 — add `hub_detail_applied_at` to `packages`. Mirrors `hub_resources.updated_at`
 * so `scanHubDetails` can skip rows whose cached detail has already been applied
 * (zero-cost warm starts). Existing rows land at NULL — the first scan after
 * deploy walks every linked row once, then steady state kicks in.
 */
function applyV19() {
  db.exec(`ALTER TABLE packages ADD COLUMN hub_detail_applied_at INTEGER`)
}

/**
 * v20 — user-defined Labels. `labels.color` semantics:
 *   `NULL`  → user picked "None" (muted gray)
 *   `-1`    → user picked "Auto" (derive from id hash; default at creation)
 *   `0..N`  → explicit palette index
 * `name` uses `COLLATE NOCASE` so case-insensitive uniqueness is enforced at the SQL layer.
 * Both junction tables cascade on `packages.filename` so uninstalling a package wipes its labels.
 * `label_contents` keys on `(package_filename, internal_path)` rather than `contents.id` because
 * `contents` rows can be REPLACEd during rescans (id changes); our composite is stable.
 */
function applyV20() {
  db.exec(`
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
}

/**
 * v21 — offload library directories.
 *  - `library_dirs` table (aux only; main is implicit, NULL pointer in packages).
 *  - `packages.library_dir_id` (NULL = main).
 *  - `packages.storage_state` TEXT replaces `is_enabled` (backfilled, then dropped).
 *  - On-disk suffix follows storage_state in main; aux dirs are always suffix-less
 *    (any stray `.disabled` in aux is normalized to bare `.var` on first scan).
 *  - `needs_rescan = '1'` so storage_state is reconciled against disk on startup.
 *
 * Order matters relative to ensureLocalPackage(): migrate() runs all migrations
 * before ensureLocalPackage() so the local sentinel insert below sees the new
 * column shape.
 */
function applyV21() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_dirs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
  const cols = db
    .prepare(`PRAGMA table_info(packages)`)
    .all()
    .map((c) => c.name)
  if (!cols.includes('library_dir_id')) {
    db.exec(
      'ALTER TABLE packages ADD COLUMN library_dir_id INTEGER NULL REFERENCES library_dirs(id) ON DELETE RESTRICT',
    )
  }
  if (!cols.includes('storage_state')) {
    db.exec(`ALTER TABLE packages ADD COLUMN storage_state TEXT NOT NULL DEFAULT 'enabled'`)
  }
  // Backfill while is_enabled still exists. Idempotent: if a previous run added storage_state
  // but crashed before dropping is_enabled, this rewrites storage_state from is_enabled again,
  // which is correct because external state changes are reconciled by the post-migration rescan.
  if (cols.includes('is_enabled')) {
    db.prepare(`UPDATE packages SET storage_state = CASE WHEN is_enabled = 1 THEN 'enabled' ELSE 'disabled' END`).run()
    try {
      db.exec('ALTER TABLE packages DROP COLUMN is_enabled')
    } catch (err) {
      console.warn('Could not drop is_enabled column:', err.message)
    }
  }
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('needs_rescan', '1')`).run()
}

/**
 * v22 — add `hub_name_checked_at` to `packages`. Negative cache for the
 * name-based Hub lookup that resolves packages absent from `packages.json`
 * (paid, hub-removed, or genuinely off-Hub). A name miss has no resource_id to
 * key the `hub_resources` cache on, so this column records "already asked the
 * Hub for this package's name" — stamped on a definitive answer (hit or
 * authoritative not-found) and left NULL on transient errors so they retry.
 *
 * The column-existence guard is recovery scaffolding, not a pattern for new
 * migrations: this step shipped on the dev channel under the old non-atomic
 * migrate(), which could leave the column added but schema_version stuck below
 * 22 after a crash. Such a DB re-runs applyV22, so a bare ADD COLUMN would throw
 * "duplicate column name" and wedge the upgrade forever. Now that migrate() runs
 * each step atomically with its version bump, fresh migrations don't need this.
 */
function applyV22() {
  const cols = db
    .prepare(`PRAGMA table_info(packages)`)
    .all()
    .map((c) => c.name)
  if (!cols.includes('hub_name_checked_at')) {
    db.exec(`ALTER TABLE packages ADD COLUMN hub_name_checked_at INTEGER`)
  }
}

/**
 * v23 — hub-id correctness. Two failure modes converge on the bogus string
 * `'null'` (and friends): a `TEXT` column accepts it, and it then slips past
 * every `IS NOT NULL` filter. This migration (a) scrubs non-numeric ids out of
 * the value columns (`packages.hub_resource_id`/`hub_user_id`,
 * `downloads.hub_resource_id`) by nulling them — never dropping a row — and
 * (b) rebuilds the two cache tables (`hub_resources`, `hub_users`) with a
 * numeric-only PK CHECK, dropping invalid-PK rows (pure cache, regenerable).
 * The cache tables have no foreign keys in either direction, so no FK dance is
 * needed. migrate() runs this (like every step) inside a transaction, so an
 * unexpected failure rolls back clean and retries next launch. Code-side, every
 * DB writer of a hub id now runs it through `toIntString` (the `setHub*`
 * setters, `insertDownload`, and the `upsertHub*` cache writers fed by raw Hub
 * API responses), so junk ids — most often a `String(null)` from an API field —
 * can't be reintroduced.
 */
function applyV23() {
  const bad = (col) => `${col} IS NOT NULL AND NOT (${intCheckSql(col)})`
  const p1 = db.prepare(`UPDATE packages SET hub_resource_id = NULL WHERE ${bad('hub_resource_id')}`).run()
  const p2 = db.prepare(`UPDATE packages SET hub_user_id = NULL WHERE ${bad('hub_user_id')}`).run()
  const d1 = db.prepare(`UPDATE downloads SET hub_resource_id = NULL WHERE ${bad('hub_resource_id')}`).run()

  db.exec(`
    CREATE TABLE hub_resources_new (
      resource_id TEXT PRIMARY KEY CHECK (${intCheckSql('resource_id')}),
      hub_json TEXT,
      search_json TEXT,
      find_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    INSERT INTO hub_resources_new (resource_id, hub_json, search_json, find_json, updated_at)
      SELECT resource_id, hub_json, search_json, find_json, updated_at
      FROM hub_resources WHERE ${intCheckSql('resource_id')};
    DROP TABLE hub_resources;
    ALTER TABLE hub_resources_new RENAME TO hub_resources;

    CREATE TABLE hub_users_new (
      user_id TEXT PRIMARY KEY CHECK (${intCheckSql('user_id')}),
      username TEXT,
      hub_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    INSERT INTO hub_users_new (user_id, username, hub_json, updated_at)
      SELECT user_id, username, hub_json, updated_at
      FROM hub_users WHERE ${intCheckSql('user_id')};
    DROP TABLE hub_users;
    ALTER TABLE hub_users_new RENAME TO hub_users;
    CREATE INDEX IF NOT EXISTS idx_hub_users_username ON hub_users(username);
  `)

  const scrubbed = p1.changes + p2.changes + d1.changes
  if (scrubbed > 0) console.info(`[migrate v23] nulled ${scrubbed} non-numeric hub id(s) across packages/downloads`)
}

/**
 * v24 — track each package's subpath within its library dir. A `.var` is valid
 * anywhere under a library root (main `AddonPackages` or an aux/offload dir),
 * not just at the top level. `subpath` is the POSIX-style relative directory
 * ('' at the root) of the file's containing folder, so `pkgVarPath` can resolve
 * nested files for enable/disable/offload, thumbnails, integrity, redownload
 * and uninstall — every operation that previously assumed a flat library dir.
 *
 * Existing rows backfill to '' (the historical flat assumption). `needs_rescan`
 * is set so the next startup scan re-derives the real subpath of any nested file
 * via runScan's stat-cache reconciliation (a cache hit now also compares
 * `subpath` and corrects it without re-reading the archive).
 */
function applyV24() {
  db.exec(`ALTER TABLE packages ADD COLUMN subpath TEXT NOT NULL DEFAULT ''`)
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('needs_rescan', '1')`).run()
}

/**
 * v25 — local wishlist for hub packages. Unlike `hub_resources` (a disposable,
 * regenerable cache), this table is the feature's own durable copy of the
 * detail-shaped resource JSON: paid/removed packages have no `.var` filename and
 * can vanish from the Hub, so we can't re-fetch a gallery from ids alone.
 * `snapshot_json` stores raw hub fields only (app-injected `_`-prefixed
 * annotations are stripped at write time and recomputed at read time).
 * `unavailable_at` is stamped when the Hub definitively reports the resource
 * gone, and cleared on any later successful refresh. Numeric-only PK CHECK
 * matches the hub-id hygiene of the other hub tables.
 */
function applyV25() {
  db.exec(`
    CREATE TABLE hub_wishlist (
      resource_id TEXT PRIMARY KEY CHECK (${intCheckSql('resource_id')}),
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      snapshot_at INTEGER NOT NULL DEFAULT (unixepoch()),
      unavailable_at INTEGER
    );
  `)
}

/**
 * Ensure the synthetic "local content" package row exists. Loose files under
 * `vamDir/Saves` and `vamDir/Custom` are stored as `contents` rows that point
 * at this sentinel so the foreign key holds without nullable columns. The
 * sentinel is filtered out of every user-visible Library iteration in
 * `store.js`. Idempotent — safe to call on every open. Lives in main
 * (`library_dir_id` NULL) with `storage_state='enabled'` so its content is
 * treated as active in the gallery store.
 */
export function ensureLocalPackage() {
  db.prepare(
    `INSERT OR IGNORE INTO packages (
      filename, creator, package_name, version, type, title, description, license,
      size_bytes, file_mtime, is_direct, storage_state, library_dir_id, dep_refs, first_seen_at
    ) VALUES (?, '', '', '', NULL, ?, NULL, NULL, 0, 0, 1, 'enabled', NULL, '[]', unixepoch())`,
  ).run(LOCAL_PACKAGE_FILENAME, LOCAL_PACKAGE_DISPLAY_NAME)
}

/** Full schema as of current SCHEMA_VERSION — new installs skip incremental migrations. */
function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_dirs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS packages (
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
      subpath TEXT NOT NULL DEFAULT '',
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

    CREATE INDEX IF NOT EXISTS idx_packages_package_name ON packages(package_name);
    CREATE INDEX IF NOT EXISTS idx_packages_creator ON packages(creator);

    CREATE TABLE IF NOT EXISTS contents (
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

    CREATE INDEX IF NOT EXISTS idx_contents_package ON contents(package_filename);
    CREATE INDEX IF NOT EXISTS idx_contents_type ON contents(type);

    CREATE TABLE IF NOT EXISTS downloads (
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

    CREATE TABLE IF NOT EXISTS hub_resources (
      resource_id TEXT PRIMARY KEY CHECK (${intCheckSql('resource_id')}),
      hub_json TEXT,
      search_json TEXT,
      find_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS hub_users (
      user_id TEXT PRIMARY KEY CHECK (${intCheckSql('user_id')}),
      username TEXT,
      hub_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_hub_users_username ON hub_users(username);

    CREATE TABLE IF NOT EXISTS hub_wishlist (
      resource_id TEXT PRIMARY KEY CHECK (${intCheckSql('resource_id')}),
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      snapshot_at INTEGER NOT NULL DEFAULT (unixepoch()),
      unavailable_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS label_packages (
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      package_filename TEXT NOT NULL REFERENCES packages(filename) ON DELETE CASCADE,
      PRIMARY KEY (label_id, package_filename)
    );
    CREATE INDEX IF NOT EXISTS idx_label_packages_pkg ON label_packages(package_filename);

    CREATE TABLE IF NOT EXISTS label_contents (
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      package_filename TEXT NOT NULL REFERENCES packages(filename) ON DELETE CASCADE,
      internal_path TEXT NOT NULL,
      PRIMARY KEY (label_id, package_filename, internal_path)
    );
    CREATE INDEX IF NOT EXISTS idx_label_contents_pkgpath ON label_contents(package_filename, internal_path);
  `)
}

// --- Prepared statement helpers ---

const stmtCache = new Map()
function stmt(sql) {
  let s = stmtCache.get(sql)
  if (!s) {
    s = db.prepare(sql)
    stmtCache.set(sql, s)
  }
  return s
}

// Packages
/**
 * Upsert a package row. `firstSeenAt` (unix seconds) is written on INSERT only —
 * it is deliberately absent from the ON CONFLICT UPDATE so re-scans never move a
 * package's discovery time. Callers that ingest a whole scan run pass one shared
 * timestamp so every package discovered in that run shares an identical
 * `first_seen_at`; that keeps the "Recently installed" sort ordering whole batches
 * by file mtime within the run, and keeps the inheritance donor gate
 * (`first_seen_at < self`) excluding same-run peers. Defaults to now when omitted.
 */
export function upsertPackage(pkg) {
  stmt(`
    INSERT INTO packages (filename, creator, package_name, version, type, title, description, license, size_bytes, file_mtime, is_direct, storage_state, library_dir_id, subpath, dep_refs, first_seen_at, scanned_at)
    VALUES (@filename, @creator, @packageName, @version, @type, @title, @description, @license, @sizeBytes, @fileMtime, @isDirect, @storageState, @libraryDirId, @subpath, @depRefs, @firstSeenAt, unixepoch())
    ON CONFLICT(filename) DO UPDATE SET
      creator = excluded.creator, package_name = excluded.package_name, version = excluded.version,
      type = excluded.type, title = excluded.title, description = excluded.description,
      license = excluded.license, size_bytes = excluded.size_bytes, file_mtime = excluded.file_mtime,
      storage_state = excluded.storage_state,
      library_dir_id = excluded.library_dir_id,
      subpath = excluded.subpath,
      dep_refs = excluded.dep_refs, scanned_at = excluded.scanned_at
  `).run({ subpath: '', firstSeenAt: Math.floor(Date.now() / 1000), ...pkg })
}

export function deletePackage(filename) {
  stmt('DELETE FROM packages WHERE filename = ?').run(filename)
}

export function setPackageDirect(filename, isDirect) {
  stmt('UPDATE packages SET is_direct = ? WHERE filename = ?').run(isDirect ? 1 : 0, filename)
}

export function touchPackageFirstSeen(filename) {
  stmt('UPDATE packages SET first_seen_at = unixepoch() WHERE filename = ?').run(filename)
}

/** @param {string | null} typeOverride — null clears override (use scanned / Hub type) */
export function setPackageTypeOverride(filename, typeOverride) {
  stmt('UPDATE packages SET type_override = ? WHERE filename = ?').run(
    typeOverride == null || typeOverride === '' ? null : String(typeOverride),
    filename,
  )
}

/**
 * Set `packages.type` from Hub detail. Independent of `type_override`; effectivePackageType()
 * still prefers the override column for display when set.
 */
export function setPackageTypeFromHub(filename, hubType) {
  const t = typeof hubType === 'string' ? hubType.trim() : ''
  if (!t) return
  stmt('UPDATE packages SET type = ? WHERE filename = ?').run(t, filename)
}

/**
 * Update storage_state and library_dir_id for a package. The on-disk suffix is implied by
 * storage_state (`.disabled` only when storage_state==='disabled', and only ever in main).
 *
 * `subpath` (the package's relative dir within its library dir) is updated only when
 * provided — pass it whenever the physical file moved (cross-dir move recovery, or a
 * scan/watch cache hit that detected a different subfolder). Omit it for in-place
 * state flips that don't relocate the file (enable/disable/offload preserve subpath
 * and pass the existing value explicitly).
 */
export function setStorageState(filename, storageState, libraryDirId, subpath) {
  if (subpath === undefined) {
    stmt('UPDATE packages SET storage_state = ?, library_dir_id = ? WHERE filename = ?').run(
      storageState,
      libraryDirId ?? null,
      filename,
    )
  } else {
    stmt('UPDATE packages SET storage_state = ?, library_dir_id = ?, subpath = ? WHERE filename = ?').run(
      storageState,
      libraryDirId ?? null,
      subpath,
      filename,
    )
  }
}

export function getPackageCacheInfo(filename) {
  return stmt(
    'SELECT file_mtime, size_bytes, storage_state, library_dir_id, subpath FROM packages WHERE filename = ?',
  ).get(filename)
}

/**
 * Find rows that share `package_name` (creator + name without version) with `filename`
 * AND were first seen strictly before it, sorted by integer version desc. Used by the
 * "inherit settings from older version on update" flow — caller picks rows[0] as the
 * donor of labels / type_override / sidecars for a freshly installed package.
 *
 * The `first_seen_at` gate sidesteps the peer-install race: when several new versions
 * of the same package land in one batch (watcher debounce window, runScan added-set,
 * parallel downloads), all share the same insertion second and `first_seen_at < self`
 * excludes every still-empty peer naturally — they all reach back to the previous
 * version that was in the DB before the batch began.
 */
export function getDonorVersionsByPackageName(packageName, filename) {
  return stmt(
    `SELECT filename, version, type_override FROM packages
     WHERE package_name = ? AND filename != ? AND package_name != ''
       AND first_seen_at < (SELECT first_seen_at FROM packages WHERE filename = ?)
     ORDER BY CAST(version AS INTEGER) DESC`,
  ).all(packageName, filename, filename)
}

// Library directories (aux only — main is implicit via vam_dir setting + NULL pointer)

export function listLibraryDirs() {
  return stmt('SELECT id, path, created_at FROM library_dirs ORDER BY created_at ASC').all()
}

export function getLibraryDir(id) {
  return stmt('SELECT id, path, created_at FROM library_dirs WHERE id = ?').get(id)
}

export function getLibraryDirByPath(path) {
  return stmt('SELECT id, path, created_at FROM library_dirs WHERE path = ?').get(path)
}

export function insertLibraryDir(path) {
  const info = stmt('INSERT INTO library_dirs (path) VALUES (?)').run(path)
  return info.lastInsertRowid
}

export function deleteLibraryDir(id) {
  stmt('DELETE FROM library_dirs WHERE id = ?').run(id)
}

export function countPackagesInLibraryDir(id) {
  if (id == null) {
    return stmt(
      'SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM packages WHERE library_dir_id IS NULL',
    ).get()
  }
  return stmt('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM packages WHERE library_dir_id = ?').get(
    id,
  )
}

export function getAllPackages() {
  return stmt('SELECT * FROM packages').all()
}

/** All local packages for hub metadata scan (direct + dependencies). */
export function getAllPackagesForHubScan() {
  return stmt('SELECT filename, package_name, is_direct FROM packages').all()
}

/**
 * Work-list for scanHubDetails apply step: rows whose linked hub_resources entry
 * has been updated (or has never been applied) since the last apply. Warm steady
 * state returns zero rows — no JSON parses, no DB writes, no IPC events.
 */
export function getPackagesNeedingHubDetailApply() {
  return stmt(`
    SELECT p.filename, hr.hub_json
    FROM packages p
    JOIN hub_resources hr ON hr.resource_id = p.hub_resource_id
    WHERE p.hub_resource_id IS NOT NULL
      AND hr.hub_json IS NOT NULL
      AND (p.hub_detail_applied_at IS NULL OR p.hub_detail_applied_at < hr.updated_at)
  `).all()
}

/**
 * Linked packages whose hub detail JSON has never been fetched (or was wiped).
 * Failed fetches store an `_unavailable` JSON, so they are NOT returned here —
 * matching the previous applyCachedDetail-based behaviour of not retrying
 * known-failed rids on every launch.
 */
export function getPackagesNeedingHubDetailFetch() {
  return stmt(`
    SELECT p.filename, p.hub_resource_id AS rid
    FROM packages p
    LEFT JOIN hub_resources hr ON hr.resource_id = p.hub_resource_id
    WHERE p.hub_resource_id IS NOT NULL AND hr.hub_json IS NULL
  `).all()
}

/**
 * Work-list for the name-based Hub resolution pass: packages absent from
 * `packages.json`, plus packages whose indexed resource now authoritatively
 * returns "Resource not found" (usually re-published under a new id).
 *
 * A dead link is retained until lookup finds a replacement, preserving useful
 * metadata for genuinely removed resources. Each state is checked once:
 * `hub_name_checked_at` retires unresolved packages until their tombstone moves.
 */
export function getPackagesNeedingHubNameLookup() {
  return stmt(`
    SELECT p.filename, p.package_name AS packageName
    FROM packages p
    LEFT JOIN hub_resources hr ON hr.resource_id = p.hub_resource_id
    WHERE p.filename != ?
      AND (
        (p.hub_resource_id IS NULL AND p.hub_name_checked_at IS NULL)
        OR (
          json_extract(hr.hub_json, '$._unavailable') = 1
          AND lower(COALESCE(json_extract(hr.hub_json, '$._error'), '')) LIKE '%resource not found%'
          AND (p.hub_name_checked_at IS NULL OR p.hub_name_checked_at < hr.updated_at)
        )
      )
  `).all(LOCAL_PACKAGE_FILENAME)
}

// Contents
export function insertContents(rows) {
  if (rows.length === 0) return
  const ins = stmt(`
    INSERT OR IGNORE INTO contents (
      package_filename, internal_path, display_name, type, thumbnail_path,
      person_atom_ids, file_mtime, size_bytes
    )
    VALUES (
      @packageFilename, @internalPath, @displayName, @type, @thumbnailPath,
      @personAtomIds, @fileMtime, @sizeBytes
    )
  `)
  const tx = db.transaction((items) => {
    for (const item of items) ins.run({ fileMtime: 0, sizeBytes: 0, ...item })
  })
  tx(rows)
}

/** @returns {{ person_atom_ids: string | null } | undefined} */
export function getPersonAtomIds(packageFilename, internalPath) {
  return stmt('SELECT person_atom_ids FROM contents WHERE package_filename = ? AND internal_path = ?').get(
    packageFilename,
    internalPath,
  )
}

/**
 * Per-row metadata for the loose-content sentinel — the inputs the local
 * scanner needs to decide whether each item is "unchanged" since its last row
 * write. Includes the stat gate (`mtime`, `size`), the cached
 * `person_atom_ids` JSON, and the classification fields (`displayName`,
 * `type`, `thumbnailPath`) so we can also catch sibling-thumbnail additions
 * that don't move the content file's mtime.
 * @returns {Map<string, { mtime: number, size: number, personAtomIds: string|null, displayName: string, type: string, thumbnailPath: string|null }>}
 */
export function getLocalContentMeta(packageFilename) {
  const rows = stmt(
    `SELECT internal_path, file_mtime, size_bytes, person_atom_ids, display_name, type, thumbnail_path
       FROM contents WHERE package_filename = ?`,
  ).all(packageFilename)
  return new Map(
    rows.map((r) => [
      r.internal_path,
      {
        mtime: r.file_mtime,
        size: r.size_bytes,
        personAtomIds: r.person_atom_ids,
        displayName: r.display_name,
        type: r.type,
        thumbnailPath: r.thumbnail_path,
      },
    ]),
  )
}

/**
 * Insert-or-update a batch of `contents` rows, keyed on
 * `(package_filename, internal_path)`. Preserves `contents.id` on update —
 * unlike `INSERT OR REPLACE` (which is delete+insert under the hood) — so
 * future joins against `contents.id` stay stable across rescans.
 */
export function upsertContents(rows) {
  if (rows.length === 0) return
  const ins = stmt(`
    INSERT INTO contents (
      package_filename, internal_path, display_name, type, thumbnail_path,
      person_atom_ids, file_mtime, size_bytes
    )
    VALUES (
      @packageFilename, @internalPath, @displayName, @type, @thumbnailPath,
      @personAtomIds, @fileMtime, @sizeBytes
    )
    ON CONFLICT(package_filename, internal_path) DO UPDATE SET
      display_name = excluded.display_name,
      type = excluded.type,
      thumbnail_path = excluded.thumbnail_path,
      person_atom_ids = excluded.person_atom_ids,
      file_mtime = excluded.file_mtime,
      size_bytes = excluded.size_bytes
  `)
  const tx = db.transaction((items) => {
    for (const item of items) ins.run({ fileMtime: 0, sizeBytes: 0, ...item })
  })
  tx(rows)
}

export function deleteContentsForPackage(filename) {
  stmt('DELETE FROM contents WHERE package_filename = ?').run(filename)
}

/** Targeted bulk delete of specific `internal_path`s under one package, in a transaction. */
export function deleteContentsForPackagePaths(packageFilename, paths) {
  if (paths.length === 0) return
  const del = stmt('DELETE FROM contents WHERE package_filename = ? AND internal_path = ?')
  const tx = db.transaction((ps) => {
    for (const p of ps) del.run(packageFilename, p)
  })
  tx(paths)
}

export function getAllContents() {
  return stmt('SELECT * FROM contents').all()
}

// Settings
export function getSetting(key) {
  const row = stmt('SELECT value FROM settings WHERE key = ?').get(key)
  return row?.value ?? null
}

export function setSetting(key, value) {
  stmt('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

/**
 * Best-effort variant for callers where losing the write is acceptable (e.g.
 * window-state persistence flushed during shutdown, after the DB may already
 * be closed by the dev "nuke" path). Returns true on success, false otherwise.
 */
export function trySetSetting(key, value) {
  try {
    setSetting(key, value)
    return true
  } catch {
    return false
  }
}

/**
 * No-op when the column already matches — keeps `scanHubDetails`'s pass-1
 * link step from issuing ~1700 redundant UPDATEs on warm starts. Returns the
 * number of rows actually changed (0 or 1) so callers can gate downstream
 * `buildFromDb`/`notify` work on real changes.
 * @returns {number}
 */
export function setHubResourceId(filename, resourceId) {
  // Guard the sole writer of packages.hub_resource_id: reject non-numeric input
  // (e.g. the string 'null' from an unguarded String(null) upstream) as a no-op
  // so it neither writes junk nor clears an existing good link.
  const rid = toIntString(resourceId)
  if (rid === null) return 0
  const r = stmt('UPDATE packages SET hub_resource_id = ? WHERE filename = ? AND hub_resource_id IS NOT ?').run(
    rid,
    filename,
    rid,
  )
  return r.changes
}

/**
 * Stamp a package as "name-checked" against the Hub so the name-based lookup
 * pass never asks again. Called on a definitive answer only — a hit (after
 * setHubResourceId) or an authoritative not-found — never on transient errors.
 */
export function markHubNameChecked(filename) {
  stmt('UPDATE packages SET hub_name_checked_at = unixepoch() WHERE filename = ?').run(filename)
}

/** Hub ids with an authoritative "Resource not found" response, loaded once per operation. */
export function getNotFoundHubResourceIds() {
  return new Set(
    stmt(`
      SELECT resource_id FROM hub_resources
      WHERE json_extract(hub_json, '$._unavailable') = 1
        AND lower(COALESCE(json_extract(hub_json, '$._error'), '')) LIKE '%resource not found%'
    `)
      .pluck()
      .all(),
  )
}

export function setHubUserId(filename, userId) {
  const uid = toIntString(userId)
  if (uid === null) return
  stmt('UPDATE packages SET hub_user_id = ? WHERE filename = ?').run(uid, filename)
}

export function setHubDisplayName(filename, displayName) {
  stmt('UPDATE packages SET hub_display_name = ? WHERE filename = ?').run(displayName, filename)
}

// Downloads
export function insertDownload(entry) {
  return stmt(`
    INSERT OR IGNORE INTO downloads (package_ref, hub_resource_id, download_url, file_size, priority, parent_ref, display_name, auto_queue_deps, status)
    VALUES (@packageRef, @hubResourceId, @downloadUrl, @fileSize, @priority, @parentRef, @displayName, @autoQueueDeps, 'queued')
  `).run({ autoQueueDeps: 1, ...entry, hubResourceId: toIntString(entry.hubResourceId) })
}

export function getDownload(id) {
  return stmt('SELECT * FROM downloads WHERE id = ?').get(id)
}

export function getDownloadByRef(packageRef) {
  return stmt('SELECT * FROM downloads WHERE package_ref = ?').get(packageRef)
}

export function getAllDownloads() {
  return stmt('SELECT * FROM downloads ORDER BY created_at ASC').all()
}

export function updateDownloadStatus(id, status, extra = {}) {
  const sets = ['status = ?']
  const params = [status]
  if (extra.tempPath !== undefined) {
    sets.push('temp_path = ?')
    params.push(extra.tempPath)
  }
  if (extra.error !== undefined) {
    sets.push('error = ?')
    params.push(extra.error)
  }
  if (status === 'completed') {
    sets.push('completed_at = unixepoch()')
  }
  params.push(id)
  db.prepare(`UPDATE downloads SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function resetActiveDownloads() {
  stmt("UPDATE downloads SET status = 'queued' WHERE status = 'active'").run()
}

export function failUnfinishedDownloads() {
  stmt("UPDATE downloads SET status = 'failed', error = 'Interrupted' WHERE status IN ('active', 'queued')").run()
}

export function cancelAllDownloads() {
  stmt("UPDATE downloads SET status = 'cancelled' WHERE status IN ('queued', 'active')").run()
}

export function clearCompletedDownloads() {
  stmt("DELETE FROM downloads WHERE status = 'completed'").run()
}

export function clearFailedDownloads() {
  stmt("DELETE FROM downloads WHERE status = 'failed'").run()
}

export function cancelDownload(id) {
  stmt("UPDATE downloads SET status = 'cancelled' WHERE id = ? AND status IN ('queued', 'active')").run(id)
}

export function retryDownload(id) {
  stmt("UPDATE downloads SET status = 'queued', error = NULL, created_at = 0 WHERE id = ? AND status = 'failed'").run(
    id,
  )
}

export function deleteDownload(id) {
  stmt('DELETE FROM downloads WHERE id = ?').run(id)
}

// Bulk operations
export function getAllDbFilenamesWithDir() {
  return stmt('SELECT filename, library_dir_id FROM packages').all()
}

// Thumbnail resolution.
// Every run we retry any package that doesn't have an image_url yet — CDN fetches
// are cheap, so we no longer permanently "mark as checked" on failures/misses.
// The thumb_checked column is kept for schema compatibility but is no longer
// consulted for fetch decisions.
export function getPackagesNeedingThumbnail() {
  return stmt('SELECT filename, package_name, hub_resource_id FROM packages WHERE image_url IS NULL').all()
}

/** filename → hub_resource_id for every package. Used by the thumb-cache layout migration. */
export function getAllPackageHubIds() {
  return stmt('SELECT filename, hub_resource_id FROM packages').all()
}

export function setPackageThumbnail(filename, imageUrl) {
  stmt('UPDATE packages SET image_url = ?, thumb_checked = 1 WHERE filename = ?').run(imageUrl, filename)
}

const THUMB_TYPE_ORDER = `
  CASE type
    WHEN 'scene' THEN 1
    WHEN 'legacyScene' THEN 1
    WHEN 'subscene' THEN 2
    WHEN 'look' THEN 3
    WHEN 'legacyLook' THEN 3
    WHEN 'skinPreset' THEN 3
    WHEN 'pose' THEN 4
    WHEN 'legacyPose' THEN 4
    WHEN 'clothingItem' THEN 5
    WHEN 'clothingPreset' THEN 5
    WHEN 'hairItem' THEN 6
    WHEN 'hairPreset' THEN 6
    ELSE 7
  END`

export function getContentThumbnailPath(packageFilename) {
  return (
    stmt(
      `SELECT thumbnail_path FROM contents WHERE package_filename = ? AND thumbnail_path IS NOT NULL ORDER BY ${THUMB_TYPE_ORDER}, internal_path LIMIT 1`,
    ).get(packageFilename)?.thumbnail_path ?? null
  )
}

export function deletePackages(filenames) {
  const tx = db.transaction((names) => {
    const del = stmt('DELETE FROM packages WHERE filename = ?')
    for (const f of names) del.run(f)
  })
  tx(filenames)
}

export function batchSetDirect(filenameMap) {
  const tx = db.transaction((entries) => {
    const upd = stmt('UPDATE packages SET is_direct = ? WHERE filename = ?')
    for (const [filename, isDirect] of entries) upd.run(isDirect ? 1 : 0, filename)
  })
  tx(filenameMap)
}

// Integrity / corrupted flag
export function setPackageCorrupted(filename, isCorrupted) {
  stmt('UPDATE packages SET is_corrupted = ? WHERE filename = ?').run(isCorrupted ? 1 : 0, filename)
}

export function batchSetCorrupted(entries) {
  const tx = db.transaction((items) => {
    const upd = stmt('UPDATE packages SET is_corrupted = ? WHERE filename = ?')
    for (const [filename, isCorrupted] of items) upd.run(isCorrupted ? 1 : 0, filename)
  })
  tx(entries)
}

export function clearAllCorrupted() {
  stmt('UPDATE packages SET is_corrupted = 0 WHERE is_corrupted = 1').run()
}

// Hub auxiliary tables — raw JSON blob cache.
//
// The three upserts share `updated_at`. Each gates its UPDATE on a real change
// to the column it owns (`WHERE existing IS NOT excluded`), so unchanged Hub
// responses don't bump the timestamp and don't trigger downstream re-applies
// (see `packages.hub_detail_applied_at` dirty-check in scanHubDetails).
// One side effect: a real change to search_json/find_json bumps the shared
// `updated_at`, causing one spurious hub_detail re-apply per package whose
// detail JSON happens to match byte-for-byte. Acceptable — re-apply is
// idempotent and rare; the alternative (per-column timestamps) isn't worth it.

export function upsertHubResourceDetail(resourceId, json) {
  const rid = toIntString(resourceId)
  if (rid === null) return false

  // The scanner writes `_unavailable` tombstones for failed fetches purely to make
  // hub_json non-NULL (so the row drops out of getPackagesNeedingHubDetailFetch).
  // The extra `hub_json IS NULL` clause enforces that a stub only fills an empty
  // slot, never overwrites real detail.
  const isUnavailableStub = !!(json && json._unavailable)
  stmt(`INSERT INTO hub_resources (resource_id, hub_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(resource_id) DO UPDATE SET
      hub_json = excluded.hub_json, updated_at = excluded.updated_at
    WHERE hub_resources.hub_json IS NOT excluded.hub_json
      ${isUnavailableStub ? 'AND hub_resources.hub_json IS NULL' : ''}
  `).run(rid, JSON.stringify(json))

  // Piggyback wishlist maintenance: a real payload refreshes the durable snapshot;
  // a stub must never reach refreshWishlistSnapshot (would clobber it). Returns
  // whether a wishlist row changed so the caller can emit `wishlist:updated` —
  // db stays event-free. (The stub branch is a safety net: wishlisting requires
  // opening the detail, which caches hub_json non-NULL, so the scanner never
  // re-stubs a wishlisted rid.)
  try {
    return isUnavailableStub ? markWishlistItemUnavailable(rid) : refreshWishlistSnapshot(rid, json)
  } catch {
    return false
  }
}

export function upsertHubResourceSearch(resourceId, json) {
  const rid = toIntString(resourceId)
  if (rid === null) return
  stmt(`INSERT INTO hub_resources (resource_id, search_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(resource_id) DO UPDATE SET
      search_json = excluded.search_json, updated_at = excluded.updated_at
    WHERE hub_resources.search_json IS NOT excluded.search_json
  `).run(rid, JSON.stringify(json))
}

export function upsertHubResourceFind(resourceId, json) {
  const rid = toIntString(resourceId)
  if (rid === null) return
  stmt(`INSERT INTO hub_resources (resource_id, find_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(resource_id) DO UPDATE SET
      find_json = excluded.find_json, updated_at = excluded.updated_at
    WHERE hub_resources.find_json IS NOT excluded.find_json
  `).run(rid, JSON.stringify(json))
}

export function getAllHubResourceJsons() {
  return stmt('SELECT resource_id, hub_json, search_json, find_json FROM hub_resources').all()
}

// --- Wishlist (local, durable snapshots of hub resources) ---
//
// This is NOT a cache: paid/removed packages can't be re-fetched from ids alone,
// so the wishlist owns its copy of the detail-shaped resource JSON. The renderer
// passes the fully-annotated detail object on add; `_`-prefixed annotations are
// stripped here and recomputed at read time (see ipc/wishlist.js).
//
// Background mutations (refresh / unavailability stamp) return whether a row
// changed; the hub client emits `wishlist:updated` on that so the renderer
// re-lists — no manual refresh, and db stays event-free.

/** JSON.stringify replacer dropping every `_`-prefixed key at any depth. */
function stripUnderscoreKeys(key, value) {
  return key.startsWith('_') ? undefined : value
}

function stringifyWishlistSnapshot(snapshot) {
  return JSON.stringify(snapshot, stripUnderscoreKeys)
}

/** Add or replace a wishlist item, refreshing its snapshot and clearing any prior unavailability. */
export function addWishlistItem(resourceId, snapshot, { createdAt } = {}) {
  const rid = toIntString(resourceId)
  if (rid === null) return
  const created = createdAt != null ? Number(createdAt) : null
  stmt(`INSERT INTO hub_wishlist (resource_id, snapshot_json, created_at, snapshot_at)
    VALUES (?, ?, COALESCE(?, unixepoch()), unixepoch())
    ON CONFLICT(resource_id) DO UPDATE SET
      snapshot_json = excluded.snapshot_json,
      snapshot_at = excluded.snapshot_at,
      unavailable_at = NULL
  `).run(rid, stringifyWishlistSnapshot(snapshot), created)
}

export function removeWishlistItem(resourceId) {
  const rid = toIntString(resourceId)
  if (rid === null) return
  stmt('DELETE FROM hub_wishlist WHERE resource_id = ?').run(rid)
}

/** All wishlist rows, newest first. Snapshot JSON is returned raw for the caller to parse + annotate. */
export function getAllWishlistItems() {
  return stmt(
    'SELECT resource_id, snapshot_json, created_at, unavailable_at FROM hub_wishlist ORDER BY created_at DESC',
  ).all()
}

export function getWishlistIds() {
  return stmt('SELECT resource_id FROM hub_wishlist')
    .all()
    .map((r) => r.resource_id)
}

export function isWishlisted(resourceId) {
  const rid = toIntString(resourceId)
  if (rid === null) return false
  return !!stmt('SELECT 1 FROM hub_wishlist WHERE resource_id = ?').get(rid)
}

/**
 * Refresh an existing wishlist item's snapshot (no-op if not wishlisted). Called
 * opportunistically from `upsertHubResourceDetail` on every fresh detail payload,
 * so a wishlisted resource that reappears also clears its unavailability flag.
 * Returns true when a row actually changed (caller emits `wishlist:updated`).
 */
export function refreshWishlistSnapshot(resourceId, snapshot) {
  const rid = toIntString(resourceId)
  if (rid === null) return false
  const json = stringifyWishlistSnapshot(snapshot)
  // Only write on a real change (or when clearing unavailability) so a
  // byte-identical detail re-open doesn't churn snapshot_at or the event.
  const info = stmt(`UPDATE hub_wishlist
    SET snapshot_json = ?, snapshot_at = unixepoch(), unavailable_at = NULL
    WHERE resource_id = ? AND (snapshot_json IS NOT ? OR unavailable_at IS NOT NULL)
  `).run(json, rid, json)
  return info.changes > 0
}

/**
 * Stamp a wishlisted item as gone from the Hub (no-op if not wishlisted or already
 * stamped). Returns true when a row changed (caller emits `wishlist:updated`).
 */
export function markWishlistItemUnavailable(resourceId) {
  const rid = toIntString(resourceId)
  if (rid === null) return false
  const info = stmt(
    'UPDATE hub_wishlist SET unavailable_at = unixepoch() WHERE resource_id = ? AND unavailable_at IS NULL',
  ).run(rid)
  return info.changes > 0
}

export function upsertHubUser(userId, username, json) {
  const uid = toIntString(userId)
  if (uid === null) return
  stmt(`INSERT INTO hub_users (user_id, username, hub_json, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username, hub_json = excluded.hub_json, updated_at = excluded.updated_at
  `).run(uid, username || null, JSON.stringify(json))
}

export function getHubResource(resourceId) {
  return stmt('SELECT * FROM hub_resources WHERE resource_id = ?').get(resourceId)
}

export function getHubUserByUsername(username) {
  return stmt('SELECT * FROM hub_users WHERE username = ?').get(username)
}

export function setPackageHubMeta(filename, { tags, promotionalLink }) {
  stmt('UPDATE packages SET hub_tags = ?, promotional_link = ? WHERE filename = ?').run(
    tags || null,
    promotionalLink || null,
    filename,
  )
}

/**
 * Bundle every Hub-detail-derived field write into a single UPDATE and stamp
 * `hub_detail_applied_at`. Called on every successful detail apply (cached or
 * freshly fetched) and also on `_unavailable` cache rows so they aren't
 * re-checked on subsequent scans. Mirrors the COALESCE/null-clear rules of the
 * scattered setters: missing user_id / display_name / type leave the existing
 * column untouched; tags / promotional_link can be cleared.
 */
export function applyHubDetailToPackage(filename, detail) {
  if (detail?._unavailable) {
    stmt('UPDATE packages SET hub_detail_applied_at = unixepoch() WHERE filename = ?').run(filename)
    return
  }
  const userId = toIntString(detail?.user_id)
  const displayName = detail?.title || null
  const tags = detail?.tags || null
  const promotionalLink = detail?.promotional_link || null
  const hubType = typeof detail?.type === 'string' ? detail.type.trim() : ''
  stmt(`
    UPDATE packages SET
      hub_user_id = COALESCE(?, hub_user_id),
      hub_display_name = COALESCE(?, hub_display_name),
      hub_tags = ?,
      promotional_link = ?,
      type = COALESCE(?, type),
      hub_detail_applied_at = unixepoch()
    WHERE filename = ?
  `).run(userId, displayName, tags, promotionalLink, hubType || null, filename)
}

export function transact(fn) {
  db.transaction(fn)()
}

// --- Labels ---

/**
 * Insert or fetch by case-insensitive name. Returns `{ id, name, color, created }`.
 * `created` is true when this call inserted the row, false when it already existed.
 * Newly-created labels start with `color = -1` (Auto — derive from id hash).
 */
export function findOrCreateLabel(name) {
  const existing = stmt('SELECT id, name, color FROM labels WHERE name = ?').get(name)
  if (existing) return { ...existing, created: false }
  const r = stmt('INSERT INTO labels (name, color) VALUES (?, -1)').run(name)
  return { id: r.lastInsertRowid, name, color: -1, created: true }
}

export function getAllLabels() {
  return stmt('SELECT id, name, color, created_at FROM labels ORDER BY name COLLATE NOCASE').all()
}

export function getAllLabelPackages() {
  return stmt('SELECT label_id, package_filename FROM label_packages').all()
}

export function getAllLabelContents() {
  return stmt('SELECT label_id, package_filename, internal_path FROM label_contents').all()
}

export function getLabelById(id) {
  return stmt('SELECT id, name, color FROM labels WHERE id = ?').get(id)
}

/**
 * Rename a label. Throws on case-insensitive collision with another label.
 * Returns the updated row.
 */
export function renameLabel(id, name) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('Label name cannot be empty')
  const existing = stmt('SELECT id FROM labels WHERE name = ? AND id != ?').get(trimmed, id)
  if (existing) {
    const err = new Error(`A label named "${trimmed}" already exists`)
    err.code = 'LABEL_NAME_EXISTS'
    throw err
  }
  stmt('UPDATE labels SET name = ? WHERE id = ?').run(trimmed, id)
  return getLabelById(id)
}

/** `color = -1` means Auto (derive from id hash); `null` means None (muted); else palette index. */
export function recolorLabel(id, color) {
  stmt('UPDATE labels SET color = ? WHERE id = ?').run(color, id)
  return getLabelById(id)
}

export function deleteLabel(id) {
  stmt('DELETE FROM labels WHERE id = ?').run(id)
}

export function applyLabelToPackages(id, filenames) {
  if (!filenames.length) return
  const ins = stmt('INSERT OR IGNORE INTO label_packages (label_id, package_filename) VALUES (?, ?)')
  const tx = db.transaction((items) => {
    for (const fn of items) ins.run(id, fn)
  })
  tx(filenames)
}

export function removeLabelFromPackages(id, filenames) {
  if (!filenames.length) return
  const del = stmt('DELETE FROM label_packages WHERE label_id = ? AND package_filename = ?')
  const tx = db.transaction((items) => {
    for (const fn of items) del.run(id, fn)
  })
  tx(filenames)
}

export function applyLabelToContents(id, items) {
  if (!items.length) return
  const ins = stmt('INSERT OR IGNORE INTO label_contents (label_id, package_filename, internal_path) VALUES (?, ?, ?)')
  const tx = db.transaction((arr) => {
    for (const it of arr) ins.run(id, it.packageFilename, it.internalPath)
  })
  tx(items)
}

/**
 * Copy `label_packages` rows from one package filename to another. INSERT OR IGNORE
 * so re-application is a no-op. Used by the inheritance flow when a new version of
 * a package is installed and should pick up the labels of the previous version.
 */
export function copyPackageLabels(fromFilename, toFilename) {
  stmt(
    `INSERT OR IGNORE INTO label_packages (label_id, package_filename)
     SELECT label_id, ? FROM label_packages WHERE package_filename = ?`,
  ).run(toFilename, fromFilename)
}

/**
 * Copy `label_contents` rows from one package filename to another, restricted to the
 * `internal_path`s that exist in the target package. Built dynamically because the
 * placeholder count varies; small batches and not in a hot loop, so the per-call
 * prepare cost is fine. INSERT OR IGNORE so partial overlap is safe.
 */
export function copyContentLabelsForPaths(fromFilename, toFilename, internalPaths) {
  if (!internalPaths.length) return
  const placeholders = internalPaths.map(() => '?').join(',')
  db.prepare(
    `INSERT OR IGNORE INTO label_contents (label_id, package_filename, internal_path)
     SELECT label_id, ?, internal_path FROM label_contents
     WHERE package_filename = ? AND internal_path IN (${placeholders})`,
  ).run(toFilename, fromFilename, ...internalPaths)
}

export function removeLabelFromContents(id, items) {
  if (!items.length) return
  const del = stmt('DELETE FROM label_contents WHERE label_id = ? AND package_filename = ? AND internal_path = ?')
  const tx = db.transaction((arr) => {
    for (const it of arr) del.run(id, it.packageFilename, it.internalPath)
  })
  tx(items)
}

/**
 * Garbage-collect labels with zero applications.
 *
 * Run only at startup so abandoned labels don't accumulate long-term, while
 * keeping in-session labels alive across mid-edit application count → 0
 * transitions (see UX plan §12). Do not call this from CRUD handlers.
 *
 * @returns {number} rows removed
 */
export function gcOrphanLabels() {
  const r = db
    .prepare(
      `DELETE FROM labels
       WHERE id NOT IN (SELECT label_id FROM label_packages)
         AND id NOT IN (SELECT label_id FROM label_contents)`,
    )
    .run()
  return r.changes
}
