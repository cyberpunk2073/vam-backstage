import { toast } from '@/components/Toast'

/**
 * Side-effectful operations on labels that talk to IPC + stores. Lives apart
 * from the chip / menu component files so those stay component-only and Vite
 * Fast Refresh recognizes them as refresh-eligible modules.
 */

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
