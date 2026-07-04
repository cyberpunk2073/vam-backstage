import { ipcMain } from 'electron'
import {
  getFilters,
  searchResources,
  getResourceDetail,
  invalidateHubCachesForRefresh,
  findPackages,
} from '../hub/client.js'
import {
  findLocalByHubResourceId,
  findLocalByFilename,
  getCreatorsNeedingUserId,
  getPackageIndex,
  getGroupIndex,
  buildFromDb,
} from '../store.js'
import { resolveRef } from '../scanner/graph.js'
import { setHubResourceId, setHubUserId, setHubDisplayName, upsertHubUser, setPackageHubMeta, transact } from '../db.js'
import { cacheAvatarsFromResources } from '../avatar-cache.js'
import { notify } from '../notify.js'
import { scanHubDetails } from '../hub/scanner.js'

export function registerHubHandlers() {
  ipcMain.handle('hub:filters', async () => {
    return await getFilters()
  })

  ipcMain.handle('hub:invalidateCaches', async () => {
    invalidateHubCachesForRefresh()
  })

  ipcMain.handle('hub:scan-packages', async () => {
    return await scanHubDetails((data) => notify('hub-scan:progress', data))
  })

  ipcMain.handle('hub:search', async (_, params) => {
    const result = await searchResources(params)

    // Annotate resources with local install status (for renderer)
    const locals = []
    for (const resource of result.resources) {
      const local = findLocalByHubResourceId(resource.resource_id)
      if (local) {
        resource._installed = true
        resource._isDirect = !!local.is_direct
        resource._localFilename = local.filename
      } else {
        resource._installed = false
        resource._isDirect = false
      }
      locals.push(local)
    }

    // Batch all DB writes in a single transaction (search_json auto-persisted by searchResources)
    let searchBackfilled = false
    try {
      transact(() => {
        for (let i = 0; i < result.resources.length; i++) {
          const resource = result.resources[i]
          const local = locals[i]
          if (resource.user_id) {
            upsertHubUser(String(resource.user_id), resource.username, {
              user_id: resource.user_id,
              username: resource.username,
              avatar_date: resource.avatar_date,
            })
          }
          if (local) {
            if (resource.user_id && !local.hub_user_id) setHubUserId(local.filename, String(resource.user_id))
            if (resource.title && !local.hub_display_name) {
              setHubDisplayName(local.filename, resource.title)
              searchBackfilled = true
            }
            setPackageHubMeta(local.filename, { tags: resource.tags, promotionalLink: resource.promotional_link })
          }
        }
      })
    } catch (e) {
      console.warn('hub:search batch upsert failed:', e.message)
    }

    cacheAvatarsFromResources(result.resources)
      .then(() => {
        let needsRebuild = searchBackfilled
        const needed = getCreatorsNeedingUserId()
        if (needed.size > 0) {
          for (const r of result.resources) {
            if (!r.user_id || !r.username) continue
            const norm = r.username.replace(/\s/g, '').toLowerCase()
            const filenames = needed.get(norm)
            if (!filenames) continue
            for (const fn of filenames) setHubUserId(fn, String(r.user_id))
            needsRebuild = true
          }
        }
        if (needsRebuild) {
          buildFromDb({ skipGraph: true })
          notify('packages:updated')
        }
        notify('avatars:updated')
      })
      .catch(() => {})

    return result
  })

  /** Reconcile hub list rows with local DB after promote/uninstall/etc. (renderer cache is otherwise stale). */
  ipcMain.handle('hub:localSnapshot', async (_, resourceIds) => {
    const out = {}
    for (const id of resourceIds || []) {
      const local = findLocalByHubResourceId(id)
      if (local) {
        out[String(id)] = { filename: local.filename, is_direct: !!local.is_direct }
      }
    }
    return out
  })

  ipcMain.handle('hub:check-availability', async (_, refs) => {
    if (!refs?.length) return {}
    const hubResults = await findPackages(refs)
    const out = {}
    const isReal = (v) => v && v !== 'null'
    for (const [ref, hubFile] of Object.entries(hubResults)) {
      const url = isReal(hubFile.downloadUrl)
        ? hubFile.downloadUrl
        : isReal(hubFile.urlHosted)
          ? hubFile.urlHosted
          : null
      const available = !!(isReal(hubFile.filename) && url)
      out[ref] = {
        available,
        resourceId: isReal(hubFile.resource_id) ? String(hubFile.resource_id) : null,
        filename: isReal(hubFile.filename) ? hubFile.filename : null,
        downloadUrl: url,
        fileSize: isReal(hubFile.file_size) ? parseInt(hubFile.file_size, 10) || null : null,
      }
    }
    for (const ref of refs) {
      if (!out[ref]) out[ref] = { available: false }
    }
    return out
  })

  ipcMain.handle('hub:detail', async (_, resourceId) => {
    const detail = await getResourceDetail(resourceId)

    // Detail payloads are cached in memory and re-enriched each call; clear injected
    // fields so local DB changes (e.g. promote → is_direct) are not stuck stale.
    delete detail._installed
    delete detail._isDirect
    delete detail._localFilename

    // hub_json auto-persisted by getResourceDetail; cache user separately
    try {
      if (detail.user_id) {
        upsertHubUser(String(detail.user_id), detail.username, {
          user_id: detail.user_id,
          username: detail.username,
          avatar_date: detail.avatar_date,
        })
      }
    } catch {}

    // Check installed status from hubFiles filenames
    let displayNameBackfilled = false
    if (detail.hubFiles?.length) {
      for (const file of detail.hubFiles) {
        const local = findLocalByFilename(file.filename)
        file._installed = !!local
        if (local) {
          if (!detail._installed) {
            detail._installed = true
            detail._isDirect = !!local.is_direct
            detail._localFilename = local.filename
          }
          if (!local.hub_resource_id && detail.resource_id) {
            try {
              setHubResourceId(local.filename, String(detail.resource_id))
            } catch {}
          }
          if (detail.user_id && !local.hub_user_id) {
            try {
              setHubUserId(local.filename, String(detail.user_id))
            } catch {}
          }
          if (detail.title && !local.hub_display_name) {
            try {
              setHubDisplayName(local.filename, detail.title)
              displayNameBackfilled = true
            } catch {}
          }
          try {
            setPackageHubMeta(local.filename, { tags: detail.tags, promotionalLink: detail.promotional_link })
          } catch {}
        }
      }
    }

    // Fallback: user may have an older version installed that's linked by hub_resource_id
    // but whose filename doesn't match any current hubFile.
    if (!detail._installed && detail.resource_id) {
      const local = findLocalByHubResourceId(detail.resource_id)
      if (local) {
        detail._installed = true
        detail._isDirect = !!local.is_direct
        detail._localFilename = local.filename
        if (detail.title && !local.hub_display_name) {
          try {
            setHubDisplayName(local.filename, detail.title)
            displayNameBackfilled = true
          } catch {}
        }
        try {
          setPackageHubMeta(local.filename, { tags: detail.tags, promotionalLink: detail.promotional_link })
        } catch {}
      }
    }

    // Annotate dependency files with graph-resolved install status
    if (detail.dependencies) {
      const pkgIndex = getPackageIndex()
      const grpIndex = getGroupIndex()
      for (const files of Object.values(detail.dependencies)) {
        for (const file of files) {
          const ref = file.filename?.replace(/\.var$/i, '') || ''
          const { resolved, resolution } = resolveRef(ref, pkgIndex, grpIndex)
          file._installed = !!resolved
          file._resolved = resolved
          file._resolution = resolution
        }
      }
    }

    cacheAvatarsFromResources([detail])
      .then(() => {
        let needsRebuild = displayNameBackfilled
        if (detail.user_id && detail.username) {
          const norm = detail.username.replace(/\s/g, '').toLowerCase()
          const filenames = getCreatorsNeedingUserId().get(norm)
          if (filenames) {
            for (const fn of filenames) setHubUserId(fn, String(detail.user_id))
            needsRebuild = true
          }
        }
        if (needsRebuild) {
          buildFromDb({ skipGraph: true })
          notify('packages:updated')
        }
        notify('avatars:updated')
      })
      .catch(() => {})

    return detail
  })
}
