/** Canonical values for `packages.storage_state`. */
export const STORAGE_STATES = ['enabled', 'disabled', 'offloaded']

/** True when VaM treats the package file as actively installed (readable from main/aux as applicable). */
export function isPackageActive(storageState) {
  return storageState === 'enabled'
}
