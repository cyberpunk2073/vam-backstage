import { migrateThumbCacheLayout } from './thumb-cache-migrate.js'

/**
 * Home for one-time, versioned upgrades that run once at boot (after the DB is
 * open) so the startup sequence in index.js doesn't accrete feature-specific
 * one-offs. Each step self-guards on a stored version/flag, making this cheap
 * and idempotent on every launch; retiring a finished migration is a localized
 * edit here rather than surgery on initBackend.
 */
export function runStartupMigrations() {
  migrateThumbCacheLayout()
}
