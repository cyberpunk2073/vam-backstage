import Database from 'better-sqlite3'
import { existsSync, unlinkSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'

const SCHEMA_VERSION = 16

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
  } else if (current < LEGACY_SCHEMA_CUTOFF) {
    throw new Error(
      `Schema version ${current} is from a pre-release build and cannot be migrated. ` +
        `Delete "${getDatabasePath()}" and restart the app.`,
    )
  }

  // Future incremental migrations (e.g. SCHEMA_VERSION 17):
  // if (current < 17) applyV17()

  db.prepare('DELETE FROM schema_version').run()
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
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
      is_corrupted INTEGER NOT NULL DEFAULT 0
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

// Contents
export function insertContents(rows) {
  const ins = stmt(`
    INSERT OR IGNORE INTO contents (package_filename, internal_path, display_name, type, thumbnail_path)
    VALUES (@packageFilename, @internalPath, @displayName, @type, @thumbnailPath)
  `)
  const tx = db.transaction((items) => {
    for (const item of items) ins.run(item)
  })
  tx(rows)
}

export function deleteContentsForPackage(filename) {
  stmt('DELETE FROM contents WHERE package_filename = ?').run(filename)
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

export function setHubResourceId(filename, resourceId) {
  stmt('UPDATE packages SET hub_resource_id = ? WHERE filename = ?').run(resourceId, filename)
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

// Hub auxiliary tables — raw JSON blob cache

export function upsertHubResourceDetail(resourceId, json) {
  stmt(`INSERT INTO hub_resources (resource_id, hub_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(resource_id) DO UPDATE SET
      hub_json = excluded.hub_json, updated_at = excluded.updated_at
  `).run(resourceId, JSON.stringify(json))
}

export function upsertHubResourceSearch(resourceId, json) {
  stmt(`INSERT INTO hub_resources (resource_id, search_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(resource_id) DO UPDATE SET
      search_json = excluded.search_json, updated_at = excluded.updated_at
  `).run(resourceId, JSON.stringify(json))
}

export function upsertHubResourceFind(resourceId, json) {
  stmt(`INSERT INTO hub_resources (resource_id, find_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(resource_id) DO UPDATE SET
      find_json = excluded.find_json, updated_at = excluded.updated_at
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

export function transact(fn) {
  db.transaction(fn)()
}
