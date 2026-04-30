import { isPackageActive } from '@shared/storage-state-predicates.js'

/** Whether disabling should show the dependents/cascade confirmation (unless suppressed in Settings). */
export function packageNeedsDisableConfirmation(pkg, suppressWarnings) {
  if (suppressWarnings) return false
  if (!isPackageActive(pkg.storageState ?? 'enabled')) return false
  const hasDependents = (pkg.dependents?.length ?? 0) > 0
  const hasCascadeDeps = (pkg.cascadeDisableDeps?.length ?? 0) > 0
  return hasDependents || hasCascadeDeps
}
