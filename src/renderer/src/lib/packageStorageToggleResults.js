import { toast } from '@/components/Toast'

/** Single-filename vs batch return from `packages:toggle-enabled` / `packages:set-enabled`. */
export function normalizeStorageToggleResults(res) {
  if (!res) return []
  if (Array.isArray(res.results)) return res.results
  return [res]
}

export function toastIfBulkToggleFailures(res) {
  const rows = normalizeStorageToggleResults(res)
  const failed = rows.filter((r) => r.ok === false).length
  if (failed) toast(`${failed} of ${rows.length} packages failed`)
}

export function toastIfSingleToggleFailed(res) {
  if (res?.ok === false) toast(`Failed to toggle package: ${res.error ?? 'unknown error'}`)
}
