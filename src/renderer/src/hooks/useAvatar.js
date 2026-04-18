import { createBlobCacheHook } from './createBlobCacheHook'

/** Fetch a cached avatar by Hub user_id (string). Returns a blob URL or null. */
export const useAvatar = createBlobCacheHook((keys) => window.api.avatars.get(keys), 'avatars:updated')
