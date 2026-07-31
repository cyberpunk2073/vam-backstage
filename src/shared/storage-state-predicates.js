/** Canonical values for `packages.storage_state`. */
export const STORAGE_STATES = ['enabled', 'disabled', 'offloaded', 'archived']

/** True when VaM treats the package file as actively installed (readable from main/aux as applicable). */
export function isPackageActive(storageState) {
  return storageState === 'enabled'
}

/**
 * True for the cold-storage tier: indexed and browsable, but exempt from
 * missing-dep, broken, orphan and update logic. Archived is inactive
 * (`isPackageActive` stays false for it).
 */
export function isPackageArchived(storageState) {
  return storageState === 'archived'
}
