import { ipcMain } from 'electron'
import { getSetting } from '../db.js'
import {
  getFilteredContents,
  getContentTypeCounts,
  getContentVisibilityCounts,
  getContentByPackage,
  updatePref,
} from '../store.js'
import { setHidden, setFavorite } from '../vam-prefs.js'
import { notify } from '../notify.js'

const BATCH_CONCURRENCY = 20

export function registerContentHandlers() {
  ipcMain.handle('contents:list', (_, filters) => {
    return getFilteredContents(filters)
  })

  ipcMain.handle('contents:type-counts', () => {
    return getContentTypeCounts()
  })

  ipcMain.handle('contents:visibility-counts', () => {
    return getContentVisibilityCounts()
  })

  ipcMain.handle('contents:toggle-hidden', async (_, { id, packageFilename, internalPath }) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')

    const items = getContentByPackage().get(packageFilename)
    const item = items?.find((c) => c.id === id)
    if (!item) throw new Error('Content item not found')

    const newHidden = !item.hidden
    await setHidden(vamDir, packageFilename, internalPath, newHidden)
    updatePref(packageFilename, internalPath, 'hidden', newHidden)
    notify('contents:updated')
    return { ok: true, hidden: newHidden }
  })

  ipcMain.handle('contents:toggle-favorite', async (_, { id, packageFilename, internalPath }) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')

    const items = getContentByPackage().get(packageFilename)
    const item = items?.find((c) => c.id === id)
    if (!item) throw new Error('Content item not found')

    const newFav = !item.favorite
    await setFavorite(vamDir, packageFilename, internalPath, newFav)
    updatePref(packageFilename, internalPath, 'favorite', newFav)
    notify('contents:updated')
    return { ok: true, favorite: newFav }
  })

  ipcMain.handle('contents:set-hidden-batch', async (_, { items, hidden }) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    await runBatched(items, BATCH_CONCURRENCY, ({ packageFilename, internalPath }) =>
      setHidden(vamDir, packageFilename, internalPath, hidden),
    )
    for (const { packageFilename, internalPath } of items) {
      updatePref(packageFilename, internalPath, 'hidden', hidden)
    }
    notify('contents:updated')
    return { ok: true }
  })

  ipcMain.handle('contents:set-favorite-batch', async (_, { items, favorite }) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    await runBatched(items, BATCH_CONCURRENCY, ({ packageFilename, internalPath }) =>
      setFavorite(vamDir, packageFilename, internalPath, favorite),
    )
    for (const { packageFilename, internalPath } of items) {
      updatePref(packageFilename, internalPath, 'favorite', favorite)
    }
    notify('contents:updated')
    return { ok: true }
  })
}

async function runBatched(items, concurrency, fn) {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn))
  }
}
