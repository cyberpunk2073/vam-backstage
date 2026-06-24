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
 * `__local__` sentinel. Used by the scanner walk (`runLocalScan`), the prefs
 * reader (`readAllPrefs`), and the filesystem watcher (`initLocalWatcher`).
 *
 * These are *specific* content-bearing subtrees, not the bare `Saves`/`Custom`
 * roots. Two reasons:
 *
 *   1. Domain separation from offload dirs. Everything outside this set is fair
 *      game for a user-registered offload (aux) library dir — e.g. JayJayWon
 *      BrowserAssist's `Saves/PluginData/.../OffloadedVARs`. The package watcher
 *      owns those; the loose-content machinery must never walk or watch them.
 *      `validateNewAuxDirPath` enforces that an aux dir can't overlap any entry
 *      here (either direction), so "monitored loose content" and "offload
 *      territory" stay disjoint by construction.
 *   2. We skip walking/watching subtrees that classify to nothing anyway
 *      (`Saves/PluginData`, plugin runtime scratch, etc.).
 *
 * COUPLING: this must remain a superset of every `Saves/`-anchored prefix the
 * classifier recognizes (see `RULES` in `scanner/classifier.js`). Today that's
 * `Saves/scene` (scene/legacyScene) and `Saves/Person` (legacyLook/legacyPose).
 * All of `Custom` is monitored because the `atomPreset` catch-all rule matches
 * `Custom/<anything>/<file>.vap`, so it can't be narrowed without dropping
 * content. If you add a classifier rule under a new `Saves/` prefix, add it
 * here too.
 */
export const LOCAL_CONTENT_DIRS = ['Saves/scene', 'Saves/Person', 'Custom']

export function isLocalPackage(filename) {
  return filename === LOCAL_PACKAGE_FILENAME
}
