import Database from 'better-sqlite3'
import { existsSync, unlinkSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'
import { LOCAL_PACKAGE_FILENAME } from '../shared/local-package.js'

const SCHEMA_VERSION = 20

let db

export function getDatabasePath() {
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

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)
  const row = db.prepare('SELECT version FROM schema_version').get()
  const current = row?.version ?? 0

  if (current === SCHEMA_VERSION) return

  if (current === 0) {
    createSchema()
  } else {
    if (current < LEGACY_SCHEMA_CUTOFF) {
      throw new Error(
        `Schema version ${current} is from a pre-release build and cannot be migrated. ` +
          `Delete "${getDatabasePath()}" and restart the app.`,
      )
    }
    if (current < 17) applyV17()
    if (current < 18) applyV18()
    if (current < 19) applyV19()
    if (current < 20) applyV20()
  }

  ensureLocalPackage()

  db.prepare('DELETE FROM schema_version').run()
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
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
 * Ensure the synthetic "local content" package row exists. Loose files under
 * `vamDir/Saves` and `vamDir/Custom` are stored as `contents` rows that point
 * at this sentinel so the foreign key holds without nullable columns. The
 * sentinel is filtered out of every user-visible Library iteration in
 * `store.js`. Idempotent — safe to call on every open.
 */
export function ensureLocalPackage() {
  db.prepare(
    `INSERT OR IGNORE INTO packages (
      filename, creator, package_name, version, type, title, description, license,
      size_bytes, file_mtime, is_direct, is_enabled, dep_refs, first_seen_at
    ) VALUES (?, '', '', '', NULL, 'Local content', NULL, NULL, 0, 0, 1, 1, '[]', unixepoch())`,
  ).run(LOCAL_PACKAGE_FILENAME)
}

/** Full schema as of LEGACY_SCHEMA_CUTOFF — new installs skip incremental migrations. */
function createSchema() {
  db.exec(`
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
      is_enabled INTEGER NOT NULL DEFAULT 1,
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
      hub_detail_applied_at INTEGER
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
      resource_id TEXT PRIMARY KEY,
      hub_json TEXT,
      search_json TEXT,
      find_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS hub_users (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      hub_json TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_hub_users_username ON hub_users(username);

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
export function upsertPackage(pkg) {
  stmt(`
    INSERT INTO packages (filename, creator, package_name, version, type, title, description, license, size_bytes, file_mtime, is_direct, is_enabled, dep_refs, scanned_at)
    VALUES (@filename, @creator, @packageName, @version, @type, @title, @description, @license, @sizeBytes, @fileMtime, @isDirect, @isEnabled, @depRefs, unixepoch())
    ON CONFLICT(filename) DO UPDATE SET
      creator = excluded.creator, package_name = excluded.package_name, version = excluded.version,
      type = excluded.type, title = excluded.title, description = excluded.description,
      license = excluded.license, size_bytes = excluded.size_bytes, file_mtime = excluded.file_mtime,
      is_enabled = excluded.is_enabled, dep_refs = excluded.dep_refs, scanned_at = excluded.scanned_at
  `).run(pkg)
}

export function deletePackage(filename) {
  stmt('DELETE FROM packages WHERE filename = ?').run(filename)
}

export function setPackageDirect(filename, isDirect) {
  stmt('UPDATE packages SET is_direct = ? WHERE filename = ?').run(isDirect ? 1 : 0, filename)
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

export function setPackageEnabled(filename, isEnabled) {
  stmt('UPDATE packages SET is_enabled = ? WHERE filename = ?').run(isEnabled ? 1 : 0, filename)
}

export function getPackageCacheInfo(filename) {
  return stmt('SELECT file_mtime, size_bytes, is_enabled FROM packages WHERE filename = ?').get(filename)
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
  const r = stmt('UPDATE packages SET hub_resource_id = ? WHERE filename = ? AND hub_resource_id IS NOT ?').run(
    resourceId,
    filename,
    resourceId,
  )
  return r.changes
}

export function setHubUserId(filename, userId) {
  stmt('UPDATE packages SET hub_user_id = ? WHERE filename = ?').run(userId, filename)
}

export function setHubDisplayName(filename, displayName) {
  stmt('UPDATE packages SET hub_display_name = ? WHERE filename = ?').run(displayName, filename)
}

// Downloads
export function insertDownload(entry) {
  return stmt(`
    INSERT OR IGNORE INTO downloads (package_ref, hub_resource_id, download_url, file_size, priority, parent_ref, display_name, auto_queue_deps, status)
    VALUES (@packageRef, @hubResourceId, @downloadUrl, @fileSize, @priority, @parentRef, @displayName, @autoQueueDeps, 'queued')
  `).run({ autoQueueDeps: 1, ...entry })
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
export function getAllDbFilenames() {
  return stmt('SELECT filename FROM packages')
    .all()
    .map((r) => r.filename)
}

// Thumbnail resolution.
// Every run we retry any package that doesn't have an image_url yet — CDN fetches
// are cheap, so we no longer permanently "mark as checked" on failures/misses.
// The thumb_checked column is kept for schema compatibility but is no longer
// consulted for fetch decisions.
export function getPackagesNeedingThumbnail() {
  return stmt('SELECT filename, package_name, hub_resource_id FROM packages WHERE image_url IS NULL').all()
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
  stmt(`INSERT INTO hub_resources (resource_id, hub_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(resource_id) DO UPDATE SET
      hub_json = excluded.hub_json, updated_at = excluded.updated_at
    WHERE hub_resources.hub_json IS NOT excluded.hub_json
  `).run(resourceId, JSON.stringify(json))
}

export function upsertHubResourceSearch(resourceId, json) {
  stmt(`INSERT INTO hub_resources (resource_id, search_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(resource_id) DO UPDATE SET
      search_json = excluded.search_json, updated_at = excluded.updated_at
    WHERE hub_resources.search_json IS NOT excluded.search_json
  `).run(resourceId, JSON.stringify(json))
}

export function upsertHubResourceFind(resourceId, json) {
  stmt(`INSERT INTO hub_resources (resource_id, find_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(resource_id) DO UPDATE SET
      find_json = excluded.find_json, updated_at = excluded.updated_at
    WHERE hub_resources.find_json IS NOT excluded.find_json
  `).run(resourceId, JSON.stringify(json))
}

export function getAllHubResourceJsons() {
  return stmt('SELECT resource_id, hub_json, search_json, find_json FROM hub_resources').all()
}

export function upsertHubUser(userId, username, json) {
  stmt(`INSERT INTO hub_users (user_id, username, hub_json, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username, hub_json = excluded.hub_json, updated_at = excluded.updated_at
  `).run(userId, username || null, JSON.stringify(json))
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
  const userId = detail?.user_id ? String(detail.user_id) : null
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
