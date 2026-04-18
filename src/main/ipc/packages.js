import { createWriteStream } from 'fs'
import { ipcMain, session } from 'electron'
import { access, rename, unlink } from 'fs/promises'
import { join } from 'path'
import { ADDON_PACKAGES } from '../../shared/paths.js'
import { HUB_HTTP_USER_AGENT } from '../../shared/hub-http.js'
import {
  setPackageDirect,
  setPackageEnabled,
  deletePackage,
  getSetting,
  setPackageTypeOverride,
  setPackageCorrupted,
} from '../db.js'
import { scanAndUpsert } from '../scanner/ingest.js'
import { readVar } from '../scanner/var-reader.js'
import { verifyPackageFull } from '../scanner/integrity.js'
import {
  getFilteredPackages,
  getPackageDetail,
  getPackageIndex,
  getGroupIndex,
  getStats,
  getStatusCounts,
  getTypeCounts,
  getTagCounts,
  getAuthorCounts,
  getForwardDeps,
  getReverseDeps,
  getOrphanSet,
  getMissingDeps,
  setPrefsMap,
  buildFromDb,
  patchTypeOverride,
  patchEnabled,
  getFilteredContents,
  isNotDownloadable,
} from '../store.js'
import { hidePackageContent, unhidePackageContent, readAllPrefs } from '../vam-prefs.js'
import { computeRemovableDeps, computeCascadeDisable, computeCascadeEnable } from '../scanner/graph.js'
import {
  enqueueInstall,
  enqueueInstallMissing,
  enqueueInstallAllMissing,
  enqueueInstallRef,
  enqueueInstallBatch,
} from '../downloads/manager.js'
import {
  fetchPackagesJson,
  getPackagesIndex,
  getPackagesFilenameIndex,
  checkUpdatesFromIndex,
  getPackagesIndexAge,
} from '../hub/packages-json.js'
import { notify } from '../notify.js'
import { suppressPath } from '../watcher.js'
import { getResourceDetail, findPackages } from '../hub/client.js'
import { cacheAvatarsFromResources } from '../avatar-cache.js'
import { VISIBLE_CATEGORIES } from '../../shared/content-types.js'

const ALLOWED_PACKAGE_TYPE_OVERRIDES = new Set([...VISIBLE_CATEGORIES, 'Other'])

function normalizeFilenameArgs(arg) {
  return Array.isArray(arg) ? arg : [arg]
}

export function registerPackageHandlers() {
  ipcMain.handle('packages:list', (_, filters) => {
    return getFilteredPackages(filters)
  })

  ipcMain.handle('packages:detail', (_, filename) => {
    return getPackageDetail(filename)
  })

  ipcMain.handle('packages:stats', () => {
    return getStats()
  })

  ipcMain.handle('packages:status-counts', () => {
    return getStatusCounts()
  })

  ipcMain.handle('packages:type-counts', () => {
    return getTypeCounts()
  })

  ipcMain.handle('packages:tag-counts', () => {
    return getTagCounts()
  })

  ipcMain.handle('packages:author-counts', () => {
    return getAuthorCounts()
  })

  ipcMain.handle('packages:install', async (_, { resourceId, hubDetail, autoQueueDeps, packageName, asDependency }) => {
    return await enqueueInstall(resourceId, hubDetail, autoQueueDeps !== false, packageName, !!asDependency)
  })

  ipcMain.handle('packages:install-missing', async (_, { filename, autoQueueDeps }) => {
    return await enqueueInstallMissing(filename, autoQueueDeps !== false)
  })

  ipcMain.handle('packages:promote', async (_, filenameOrFilenames, hubResourceId) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')

    const filenames = normalizeFilenameArgs(filenameOrFilenames)
    for (const filename of filenames) {
      setPackageDirect(filename, true)
      const contents = getFilteredContents({ packageFilename: filename })
      const paths = contents.map((c) => c.internalPath)
      await unhidePackageContent(vamDir, filename, paths)
    }
    const prefs = await readAllPrefs(vamDir)
    setPrefsMap(prefs)
    buildFromDb({ skipGraph: true })

    if (filenames.length === 1 && hubResourceId != null && String(hubResourceId).trim() !== '') {
      try {
        const detail = await getResourceDetail(String(hubResourceId))
        await cacheAvatarsFromResources([detail])
        notify('avatars:updated')
      } catch {}
    }

    notify('packages:updated')
    notify('contents:updated')
    return filenames.length === 1 ? { ok: true } : { ok: true, count: filenames.length }
  })

  ipcMain.handle('packages:uninstall', async (_, filenameOrFilenames) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    const addonDir = join(vamDir, ADDON_PACKAGES)
    const filenames = normalizeFilenameArgs(filenameOrFilenames)
    const results = []
    for (const filename of filenames) {
      const pkg = getPackageIndex().get(filename)
      if (!pkg) throw new Error(`Package not found: ${filename}`)

      const dependents = getReverseDeps().get(filename)
      if (dependents && dependents.size > 0) {
        setPackageDirect(filename, false)
        const contents = getFilteredContents({ packageFilename: filename })
        const paths = contents.map((c) => c.internalPath)
        await hidePackageContent(vamDir, filename, paths)
        const prefs = await readAllPrefs(vamDir)
        setPrefsMap(prefs)
        buildFromDb({ skipGraph: true })
        results.push({ ok: true, demoted: true })
        continue
      }

      const { removableFilenames } = computeRemovableDeps(
        filename,
        getPackageIndex(),
        getForwardDeps(),
        getReverseDeps(),
      )
      // Keep local-only deps (not available on Hub) as orphans instead of auto-deleting
      const filteredRemovable = [...removableFilenames].filter((fn) => {
        const depPkg = getPackageIndex().get(fn)
        return !depPkg || !isNotDownloadable(depPkg)
      })
      const toDelete = [filename, ...filteredRemovable]
      for (const fn of toDelete) {
        suppressPath(join(addonDir, fn))
        suppressPath(join(addonDir, fn + '.disabled'))
        try {
          await unlink(join(addonDir, fn))
        } catch {}
        try {
          await unlink(join(addonDir, fn + '.disabled'))
        } catch {}
        deletePackage(fn)
      }
      buildFromDb()
      results.push({ ok: true, deleted: toDelete.length })
    }

    notify('packages:updated')
    notify('contents:updated')
    if (filenames.length === 1) return results[0]
    return { ok: true, results }
  })

  ipcMain.handle('packages:set-type-override', (_, payload) => {
    const { filename, typeOverride, filenames: filenamesField } = payload
    const filenames = filenamesField?.length ? filenamesField : filename != null ? normalizeFilenameArgs(filename) : []
    if (filenames.length === 0) throw new Error('Package not found')
    if (typeOverride != null && !ALLOWED_PACKAGE_TYPE_OVERRIDES.has(typeOverride)) {
      throw new Error('Invalid package type')
    }
    for (const fn of filenames) {
      const pkg = getPackageIndex().get(fn)
      if (!pkg) throw new Error(`Package not found: ${fn}`)
      setPackageTypeOverride(fn, typeOverride)
      patchTypeOverride(fn, typeOverride)
    }
    notify('packages:updated')
    return { ok: true, count: filenames.length }
  })

  ipcMain.handle('packages:toggle-enabled', async (_, filenameOrFilenames) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    const addonDir = join(vamDir, ADDON_PACKAGES)
    const filenames = normalizeFilenameArgs(filenameOrFilenames)
    const out = []
    for (const filename of filenames) {
      const pkg = getPackageIndex().get(filename)
      if (!pkg) throw new Error(`Package not found: ${filename}`)

      const newEnabled = !pkg.is_enabled

      const cascadeSet = newEnabled
        ? computeCascadeEnable(filename, getPackageIndex(), getForwardDeps())
        : computeCascadeDisable(filename, getPackageIndex(), getForwardDeps(), getReverseDeps())

      const oldDiskPath = join(addonDir, newEnabled ? filename + '.disabled' : filename)
      const newDiskPath = join(addonDir, newEnabled ? filename : filename + '.disabled')

      suppressPath(oldDiskPath)
      suppressPath(newDiskPath)
      try {
        await rename(oldDiskPath, newDiskPath)
      } catch (err) {
        throw new Error(`Failed to ${newEnabled ? 'enable' : 'disable'} package: ${err.message}`)
      }
      setPackageEnabled(filename, newEnabled)

      for (const depFilename of cascadeSet) {
        const oldDepPath = join(addonDir, newEnabled ? depFilename + '.disabled' : depFilename)
        const newDepPath = join(addonDir, newEnabled ? depFilename : depFilename + '.disabled')
        suppressPath(oldDepPath)
        suppressPath(newDepPath)
        try {
          await rename(oldDepPath, newDepPath)
        } catch {
          continue
        }
        setPackageEnabled(depFilename, newEnabled)
      }

      patchEnabled([filename, ...cascadeSet], newEnabled)
      out.push({ ok: true, isEnabled: newEnabled, cascadeCount: cascadeSet.size })
    }

    notify('packages:updated')
    return filenames.length === 1 ? out[0] : { ok: true, results: out }
  })

  ipcMain.handle('packages:force-remove', async (_, filenameOrFilenames) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    const addonDir = join(vamDir, ADDON_PACKAGES)
    const filenames = normalizeFilenameArgs(filenameOrFilenames)
    for (const filename of filenames) {
      suppressPath(join(addonDir, filename))
      suppressPath(join(addonDir, filename + '.disabled'))
      try {
        await unlink(join(addonDir, filename))
      } catch {}
      try {
        await unlink(join(addonDir, filename + '.disabled'))
      } catch {}
      deletePackage(filename)
    }
    buildFromDb()
    notify('packages:updated')
    notify('contents:updated')
    return filenames.length === 1 ? { ok: true } : { ok: true, count: filenames.length }
  })

  ipcMain.handle('packages:missing-deps', async () => {
    // Ensure packages.json is loaded (same stale logic as check-updates)
    const STALE_MS = 5 * 60 * 1000
    if (!getPackagesIndex() || getPackagesIndexAge() > STALE_MS) {
      try {
        await fetchPackagesJson()
      } catch (err) {
        console.warn('[missing-deps] Failed to fetch packages.json:', err.message)
      }
    }
    return getMissingDeps(getPackagesIndex(), getPackagesFilenameIndex())
  })

  ipcMain.handle('packages:enrich-from-hub', async (_, packageStems) => {
    if (!packageStems?.length) return {}
    const results = await findPackages(packageStems)
    const enriched = {}
    const isReal = (v) => v && v !== 'null'
    for (const [stem, hubFile] of Object.entries(results)) {
      const url = isReal(hubFile.downloadUrl)
        ? hubFile.downloadUrl
        : isReal(hubFile.urlHosted)
          ? hubFile.urlHosted
          : null
      enriched[stem] = {
        fileSize: isReal(hubFile.file_size) ? parseInt(hubFile.file_size, 10) || null : null,
        downloadUrl: url,
      }
    }
    return enriched
  })

  ipcMain.handle('packages:remove-orphans', async () => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    const addonDir = join(vamDir, ADDON_PACKAGES)

    const orphans = getOrphanSet()
    if (orphans.size === 0) return { ok: true, count: 0, freedBytes: 0 }

    let freedBytes = 0
    for (const fn of orphans) {
      const pkg = getPackageIndex().get(fn)
      if (pkg) freedBytes += pkg.size_bytes
      suppressPath(join(addonDir, fn))
      suppressPath(join(addonDir, fn + '.disabled'))
      try {
        await unlink(join(addonDir, fn))
      } catch {}
      try {
        await unlink(join(addonDir, fn + '.disabled'))
      } catch {}
      deletePackage(fn)
    }

    buildFromDb()
    notify('packages:updated')
    notify('contents:updated')
    return { ok: true, count: orphans.size, freedBytes }
  })

  ipcMain.handle('packages:install-all-missing', async () => {
    return await enqueueInstallAllMissing()
  })

  ipcMain.handle('packages:install-deps-batch', async (_, { items, autoQueueDeps }) => {
    return await enqueueInstallBatch(items, autoQueueDeps !== false)
  })

  ipcMain.handle('packages:install-dep', async (_, hubFileData) => {
    return await enqueueInstallRef(hubFileData)
  })

  ipcMain.handle('packages:file-list', async (_, filename) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    const addonDir = join(vamDir, ADDON_PACKAGES)

    let varPath = join(addonDir, filename)
    try {
      await access(varPath)
    } catch {
      varPath = join(addonDir, filename + '.disabled')
      await access(varPath)
    }

    const { fileList } = await readVar(varPath)
    return { fileList, varPath }
  })

  ipcMain.handle('packages:check-updates', async (_, { forceRefresh } = {}) => {
    // Fetch or refresh the CDN packages index
    const STALE_MS = 5 * 60 * 1000
    if (!getPackagesIndex() || forceRefresh || getPackagesIndexAge() > STALE_MS) {
      try {
        await fetchPackagesJson({ force: !!forceRefresh })
      } catch (err) {
        console.warn('[check-updates] Failed to fetch packages.json:', err.message)
        if (!getPackagesIndex()) return {}
      }
    }

    return checkUpdatesFromIndex(getPackageIndex(), getGroupIndex(), getForwardDeps()) ?? {}
  })

  ipcMain.handle('packages:redownload', async (_, filename) => {
    const vamDir = getSetting('vam_dir')
    if (!vamDir) throw new Error('VaM directory not configured')
    const addonDir = join(vamDir, ADDON_PACKAGES)
    const pkg = getPackageIndex().get(filename)
    if (!pkg) throw new Error('Package not found')

    let downloadUrl = null
    let hubResourceId = pkg.hub_resource_id

    // Resolve download URL via Hub
    if (hubResourceId) {
      try {
        const detail = await getResourceDetail(hubResourceId)
        const file = (detail?.hubFiles || []).find((f) => {
          const fn = f.filename?.endsWith('.var') ? f.filename : f.filename + '.var'
          return fn === filename
        })
        downloadUrl = file?.downloadUrl || file?.urlHosted || null
        if (!downloadUrl && detail?.hubFiles?.[0]) {
          downloadUrl = detail.hubFiles[0].downloadUrl || detail.hubFiles[0].urlHosted || null
        }
      } catch {}
    }

    if (!downloadUrl) {
      try {
        const results = await findPackages([filename.replace(/\.var$/i, '')])
        const hubFile = Object.values(results)[0]
        if (hubFile) {
          downloadUrl = hubFile.downloadUrl || hubFile.urlHosted || null
          if (!hubResourceId && hubFile.resource_id) hubResourceId = String(hubFile.resource_id)
        }
      } catch {}
    }

    if (!downloadUrl) throw new Error('Could not resolve download URL from Hub')

    const tempPath = join(addonDir, filename + '.redownload.tmp')

    try {
      const hubSession = session.fromPartition('persist:hub')
      const cookies = await hubSession.cookies.get({ url: 'https://hub.virtamate.com' })
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

      const res = await fetch(downloadUrl, {
        headers: { 'User-Agent': HUB_HTTP_USER_AGENT, Cookie: cookieHeader },
        redirect: 'follow',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)

      const fileStream = createWriteStream(tempPath)
      const fileError = new Promise((_, reject) => fileStream.on('error', reject))
      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!fileStream.write(value)) {
          await new Promise((r) => fileStream.once('drain', r))
        }
      }
      await Promise.race([new Promise((resolve) => fileStream.end(() => resolve())), fileError])

      // Verify the newly downloaded file
      await verifyPackageFull(tempPath)

      // Replace the old file
      const isDisabled = !pkg.is_enabled
      const finalPath = join(addonDir, isDisabled ? filename + '.disabled' : filename)
      suppressPath(finalPath)
      // Remove both enabled and disabled variants before replacing
      try {
        await unlink(join(addonDir, filename))
      } catch {}
      try {
        await unlink(join(addonDir, filename + '.disabled'))
      } catch {}
      await rename(tempPath, finalPath)

      // Clear corrupted flag and re-scan the package
      setPackageCorrupted(filename, false)
      try {
        await scanAndUpsert(finalPath, { isDirect: pkg.is_direct ? 1 : 0, isEnabled: !isDisabled })
      } catch (err) {
        console.warn(`Post-redownload rescan failed for ${filename}:`, err.message)
      }

      buildFromDb()
      notify('packages:updated')
      notify('contents:updated')
      return { ok: true }
    } catch (err) {
      try {
        await unlink(tempPath)
      } catch {}
      throw err
    }
  })
}
