import { createBlobCacheHook } from './createBlobCacheHook'

export const useThumbnail = createBlobCacheHook((keys) => window.api.thumbnails.get(keys), 'thumbnails:updated')
