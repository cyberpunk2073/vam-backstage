/**
 * Sentinel package row used to own loose user content found in `vamDir/Saves`
 * and `vamDir/Custom`. The `packages` table requires every `contents` row to
 * point at a package, but loose files don't live inside a `.var`. A single
 * synthetic row with this filename keeps the foreign key happy without forcing
 * a schema-wide nullable column or a new join table.
 *
 * The sentinel is filtered out of the Library view, Library facets, and most
 * stats; sentinel-owned content rows are surfaced in the Content gallery as
 * normal items, with the renderer special-casing the detail panel.
 */
export const LOCAL_PACKAGE_FILENAME = '__local__'

/**
 * Subdirectories of the VaM install that hold loose user content owned by the
 * `__local__` sentinel. Used by the scanner walk, the prefs reader, and the
 * filesystem watcher.
 */
export const LOCAL_CONTENT_ROOTS = ['Saves', 'Custom']

export function isLocalPackage(filename) {
  return filename === LOCAL_PACKAGE_FILENAME
}
