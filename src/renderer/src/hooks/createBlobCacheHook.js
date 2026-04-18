import { useState, useEffect, useRef } from 'react'

/**
 * Factory for batched blob-URL cache hooks (thumbnails, avatars, etc.).
 * Each call creates an independent cache + pending queue + invalidation channel.
 */
export function createBlobCacheHook(apiGetter, eventName) {
  const urlCache = new Map()
  let pendingKeys = new Set()
  let pendingCallbacks = new Map()
  let flushTimer = null

  const invalidationCallbacks = new Set()

  function handleInvalidation(payload) {
    const explicitKeys = payload?.keys
    let cleared = false
    if (explicitKeys?.length) {
      // Targeted invalidation (e.g. thumb-resolver just wrote a fresh Hub thumb
      // for these packages): drop whatever's cached, null or not, so the next
      // render re-fetches and the UI picks up the new buffer.
      for (const key of explicitKeys) {
        if (urlCache.delete(key)) cleared = true
      }
    } else {
      for (const [key, val] of urlCache) {
        if (val === null) {
          urlCache.delete(key)
          cleared = true
        }
      }
    }
    if (cleared) {
      for (const cb of invalidationCallbacks) cb()
    }
  }

  if (typeof window !== 'undefined' && window.api?.on) {
    window.api.on(eventName, handleInvalidation)
  }

  async function flush() {
    flushTimer = null
    const keys = [...pendingKeys]
    pendingKeys = new Set()
    const callbacks = new Map(pendingCallbacks)
    pendingCallbacks = new Map()

    try {
      const results = await apiGetter(keys)
      for (const key of keys) {
        const buf = results[key]
        let url = null
        if (buf) {
          const blob = new Blob([buf], { type: 'image/jpeg' })
          url = URL.createObjectURL(blob)
        }
        urlCache.set(key, url)
        for (const cb of callbacks.get(key) || []) cb(url)
      }
    } catch {
      for (const key of keys) {
        urlCache.set(key, null)
        for (const cb of callbacks.get(key) || []) cb(null)
      }
    }
  }

  function request(key, callback) {
    const cached = urlCache.get(key)
    if (cached !== undefined) {
      callback(cached)
      return
    }
    pendingKeys.add(key)
    if (!pendingCallbacks.has(key)) pendingCallbacks.set(key, [])
    pendingCallbacks.get(key).push(callback)
    if (!flushTimer) flushTimer = setTimeout(flush, 32)
  }

  return function useBlobUrl(key) {
    const [url, setUrl] = useState(() => (key ? (urlCache.get(key) ?? null) : null))
    const activeRef = useRef(true)

    useEffect(() => {
      activeRef.current = true
      if (!key) {
        setUrl(null)
        return
      }
      request(key, (u) => {
        if (activeRef.current) setUrl(u)
      })
      return () => {
        activeRef.current = false
      }
    }, [key])

    useEffect(() => {
      if (!key) return
      const handler = () => {
        if (!urlCache.has(key)) {
          request(key, (u) => {
            if (activeRef.current) setUrl(u)
          })
        }
      }
      invalidationCallbacks.add(handler)
      return () => invalidationCallbacks.delete(handler)
    }, [key])

    return url
  }
}
