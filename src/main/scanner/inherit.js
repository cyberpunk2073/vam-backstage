import {
  getDonorVersionsByPackageName,
  copyPackageLabels,
  copyContentLabelsForPaths,
  setPackageTypeOverride,
} from '../db.js'
import { copySidecarsToNewVersion } from '../vam-prefs.js'

/**
 * When a new package version is installed, copy over the user-set settings of the
 * most recent **older** version of the same `package_name` (creator + name without
 * version). Settings inherited:
 *
 *   - `packages.type_override`        — user-picked custom category
 *   - `label_packages` rows           — package-level labels
 *   - `label_contents` rows           — content-level labels (only for `internal_path`s
 *                                        that exist in the new package)
 *   - `.hide` / `.fav` sidecars       — content visibility flags (per-stem on disk;
 *                                        new stem ≠ old stem, so we copy explicitly)
 *
 * Donor selection: highest integer version among rows whose `first_seen_at` is
 * strictly before the new package's. The `first_seen_at` gate is what makes batch
 * inserts safe — when several new versions of the same package land together
 * (watcher debounce, parallel downloads, runScan added-set) all share the same
 * insertion second, so none of the still-empty peers can become a donor for the
 * others; they all correctly reach back to the previous DB state.
 *
 * Precondition: the new row must already be upserted before calling — the donor
 * SQL self-references its `first_seen_at`, and a missing row resolves to NULL
 * which makes every comparison fall through and the function silently no-ops.
 *
 * Idempotent and safe to call multiple times: label inserts are `INSERT OR IGNORE`
 * and sidecar writes overwrite empty marker files. `vamDir` is optional — when not
 * configured (very early bootstrap, tests) we skip the on-disk sidecar copy and
 * still inherit the DB-backed settings.
 *
 * @param {object} args
 * @param {string} args.filename       — the freshly-installed `.var` filename
 * @param {string} args.packageName    — the `creator.packageName` portion (no version)
 * @param {Array<{ internalPath: string }>} args.contentItems — items in the new package
 * @param {string|null|undefined} args.vamDir — VaM root for sidecar copy (optional)
 * @returns {Promise<{ donor: string, copiedTypeOverride: boolean } | null>}
 *   Null when there's no eligible donor. Otherwise the donor filename and a flag
 *   indicating whether a type_override was carried over.
 */
export async function inheritFromOlderVersion({ filename, packageName, contentItems, vamDir }) {
  if (!packageName || !filename) return null
  const donors = getDonorVersionsByPackageName(packageName, filename)
  if (donors.length === 0) return null
  const donor = donors[0]

  let copiedTypeOverride = false
  if (donor.type_override) {
    setPackageTypeOverride(filename, donor.type_override)
    copiedTypeOverride = true
  }

  copyPackageLabels(donor.filename, filename)

  const internalPaths = contentItems.map((c) => c.internalPath).filter(Boolean)
  copyContentLabelsForPaths(donor.filename, filename, internalPaths)

  if (vamDir) {
    try {
      await copySidecarsToNewVersion(vamDir, donor.filename, filename, internalPaths)
    } catch (err) {
      console.warn(`inheritFromOlderVersion: sidecar copy ${donor.filename} -> ${filename} failed:`, err.message)
    }
  }

  return { donor: donor.filename, copiedTypeOverride }
}
