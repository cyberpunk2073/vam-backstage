import { isPackageActive } from '@shared/storage-state-predicates.js'

/** Enabled dependents that would actually break if this package is disabled. */
export function activeBreakingDependents(pkg) {
  return (pkg.dependents || []).filter((d) => isPackageActive(d.storageState ?? 'enabled'))
}

/** Whether disabling should show the dependents/cascade confirmation (unless suppressed in Settings). */
export function packageNeedsDisableConfirmation(pkg, suppressWarnings) {
  if (suppressWarnings) return false
  if (!isPackageActive(pkg.storageState ?? 'enabled')) return false
  const hasDependents = activeBreakingDependents(pkg).length > 0
  const hasCascadeDeps = (pkg.cascadeDisableDeps?.length ?? 0) > 0
  return hasDependents || hasCascadeDeps
}
