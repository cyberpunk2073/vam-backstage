import { useLibraryStore } from '@/stores/useLibraryStore'
import { toast } from '@/components/Toast'
import { isPackageActive } from '@shared/storage-state-predicates.js'

/**
 * Side-effectful operations on labels that talk to IPC + stores. Lives apart
 * from the chip / menu component files so those stay component-only and Vite
 * Fast Refresh recognizes them as refresh-eligible modules.
 */

/**
 * Enable or disable every package carrying `labelId` via `packages.setEnabled`
 * (explicit target state — no toggle invert semantics, so safe even if the
 * local store has drifted relative to disk). Filters to packages whose state
 * actually needs to change. Returns the affected count.
 */
export async function enableMatchingPackages(labelId, enable) {
  let { packages, fetchPackages } = useLibraryStore.getState()
  if (!packages.length) {
    await fetchPackages()
    packages = useLibraryStore.getState().packages
  }
  const targets = packages.filter(
    (p) => Array.isArray(p.labelIds) && p.labelIds.includes(labelId) && isPackageActive(p.storageState) !== enable,
  )
  if (!targets.length) {
    toast(enable ? 'All labeled packages are already enabled' : 'All labeled packages are already disabled', 'info')
    return 0
  }
  try {
    const filenames = targets.map((p) => p.filename)
    await window.api.packages.setEnabled(filenames, enable)
    await fetchPackages()
    toast(`${enable ? 'Enabled' : 'Disabled'} ${targets.length} package${targets.length === 1 ? '' : 's'}`, 'success')
  } catch (err) {
    toast(`Failed: ${err.message}`)
  }
  return targets.length
}

/**
 * Apply or remove `labelId` on N packages in one IPC call. Toast on failure;
 * caller-side updates come from the `packages:updated` / `labels:updated`
 * notifications fired by the main-process handler.
 */
export async function applyLabelToFilenames(id, filenames, applied) {
  if (!filenames.length) return
  try {
    await window.api.labels.applyToPackages({ id, filenames, applied })
  } catch (err) {
    toast(`Failed to ${applied ? 'apply' : 'remove'} label: ${err.message}`)
  }
}

/**
 * Apply or remove `labelId` on N content items in one IPC call. Same toast +
 * notify rules as `applyLabelToFilenames`.
 */
export async function applyLabelToContentItems(id, items, applied) {
  if (!items.length) return
  try {
    await window.api.labels.applyToContents({ id, items, applied })
  } catch (err) {
    toast(`Failed to ${applied ? 'apply' : 'remove'} label: ${err.message}`)
  }
}
