export function resolveLibraryRestoreIndex(items, scrollAnchorFilename, selectedFilename) {
  if (!items.length) return -1
  const anchorIndex = scrollAnchorFilename ? items.findIndex((p) => p.filename === scrollAnchorFilename) : -1
  if (anchorIndex >= 0) return anchorIndex
  const selectedIndex = selectedFilename ? items.findIndex((p) => p.filename === selectedFilename) : -1
  return selectedIndex >= 0 ? selectedIndex : 0
}

export function resolveContentRestoreIndex(
  items,
  scrollAnchorItemId,
  scrollAnchorPackageFilename,
  selectedItemId,
  selectedPackageFilename = null,
) {
  if (!items.length) return -1
  const matches = (item, idValue, packageFilename) =>
    idValue != null &&
    String(item.id) === String(idValue) &&
    (!packageFilename || item.packageFilename === packageFilename)
  const anchorIndex = items.findIndex((item) => matches(item, scrollAnchorItemId, scrollAnchorPackageFilename))
  if (anchorIndex >= 0) return anchorIndex
  const selectedIndex = items.findIndex((item) => matches(item, selectedItemId, selectedPackageFilename))
  return selectedIndex >= 0 ? selectedIndex : 0
}
