import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir, unlink } from 'fs/promises'

function getCacheDir() {
  return join(app.getPath('userData'), 'avatar-cache')
}

function avatarFile(userId, avatarDate) {
  return `${userId}_${avatarDate}.jpg`
}

// In-memory index: userId (string) → { avatarDate }
// Persisted to index.json alongside the image files.
let index = null
let dirReady = false

async function ensureDir() {
  if (dirReady) return
  await mkdir(getCacheDir(), { recursive: true })
  dirReady = true
}

async function loadIndex() {
  if (index) return index
  try {
    const raw = JSON.parse(await readFile(join(getCacheDir(), 'index.json'), 'utf8'))
    // Migrate old format (keyed by username with { userId, avatarDate }) to new (keyed by userId with { avatarDate })
    const first = Object.values(raw)[0]
    if (first && 'userId' in first) {
      index = {}
      for (const entry of Object.values(raw)) {
        index[entry.userId] = { avatarDate: entry.avatarDate }
      }
      await saveIndex()
    } else {
      index = raw
    }
  } catch {
    index = {}
  }
  return index
}

async function saveIndex() {
  await writeFile(join(getCacheDir(), 'index.json'), JSON.stringify(index))
}

/**
 * Cache avatars from Hub API resource objects.
 * Each must have { user_id, avatar_date, icon_url }.
 * Skips already-cached entries; re-downloads if avatar_date changed.
 * Returns count of newly written files.
 */
export async function cacheAvatarsFromResources(resources) {
  const seen = new Set()
  const items = []
  for (const r of resources) {
    if (r.icon_url && r.user_id && r.avatar_date && !seen.has(r.user_id)) {
      seen.add(r.user_id)
      items.push(r)
    }
  }
  if (items.length === 0) return 0

  await ensureDir()
  const idx = await loadIndex()
  const dir = getCacheDir()
  let written = 0

  for (const r of items) {
    const uid = String(r.user_id)
    const existing = idx[uid]
    if (existing?.avatarDate === r.avatar_date) continue

    try {
      const res = await fetch(r.icon_url)
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())

      if (existing && existing.avatarDate !== r.avatar_date) {
        try {
          await unlink(join(dir, avatarFile(uid, existing.avatarDate)))
        } catch {}
      }

      await writeFile(join(dir, avatarFile(uid, r.avatar_date)), buf)
      idx[uid] = { avatarDate: r.avatar_date }
      written++
    } catch {}
  }

  if (written > 0) await saveIndex()
  return written
}

/**
 * Read cached avatar buffers for a list of user IDs.
 * Returns { userId: Buffer | null }.
 */
export async function getAvatarBuffers(userIds) {
  const idx = await loadIndex()
  const dir = getCacheDir()
  const results = {}
  for (const uid of userIds) {
    const entry = idx[uid]
    if (!entry) {
      results[uid] = null
      continue
    }
    try {
      results[uid] = await readFile(join(dir, avatarFile(uid, entry.avatarDate)))
    } catch {
      results[uid] = null
    }
  }
  return results
}
