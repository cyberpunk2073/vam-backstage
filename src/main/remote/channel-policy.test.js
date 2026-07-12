import { describe, it, expect } from 'vitest'
import { CLIENT_LOCAL_EVENTS, isRemoteChannelDenied } from './channel-policy.js'

describe('isRemoteChannelDenied', () => {
  it('denies shell / remote / updater / dev prefixes', () => {
    expect(isRemoteChannelDenied('shell:openExternal')).toBe(true)
    expect(isRemoteChannelDenied('shell:showItemInFolder')).toBe(true)
    expect(isRemoteChannelDenied('remote:stop')).toBe(true)
    expect(isRemoteChannelDenied('remote:relaunch-connect')).toBe(true)
    expect(isRemoteChannelDenied('updater:install')).toBe(true)
    expect(isRemoteChannelDenied('updater:check')).toBe(true)
    expect(isRemoteChannelDenied('dev:nuke-database')).toBe(true)
    expect(isRemoteChannelDenied('dev:sync-browser-assist')).toBe(true)
  })

  it('denies exact machine-local channels', () => {
    expect(isRemoteChannelDenied('library-dirs:browse')).toBe(true)
    expect(isRemoteChannelDenied('wizard:browse-vam-dir')).toBe(true)
    expect(isRemoteChannelDenied('wizard:detect-vam-dir')).toBe(true)
    expect(isRemoteChannelDenied('settings:getDatabasePath')).toBe(true)
    expect(isRemoteChannelDenied('hub:isLoggedIn')).toBe(true)
    expect(isRemoteChannelDenied('hub:resourceUserState')).toBe(true)
    expect(isRemoteChannelDenied('hub:toggleFavorite')).toBe(true)
    expect(isRemoteChannelDenied('hub:toggleBookmark')).toBe(true)
    expect(isRemoteChannelDenied('hub:toggleRate')).toBe(true)
    expect(isRemoteChannelDenied('hub:toggleLike')).toBe(true)
  })

  it('allows shared library / hub / wishlist / settings data channels', () => {
    expect(isRemoteChannelDenied('packages:list')).toBe(false)
    expect(isRemoteChannelDenied('packages:install')).toBe(false)
    expect(isRemoteChannelDenied('contents:toggle-favorite')).toBe(false)
    expect(isRemoteChannelDenied('wishlist:add')).toBe(false)
    expect(isRemoteChannelDenied('wishlist:remove')).toBe(false)
    expect(isRemoteChannelDenied('wishlist:list')).toBe(false)
    expect(isRemoteChannelDenied('downloads:pause-all')).toBe(false)
    expect(isRemoteChannelDenied('hub:search')).toBe(false)
    expect(isRemoteChannelDenied('hub:detail')).toBe(false)
    expect(isRemoteChannelDenied('settings:get')).toBe(false)
    expect(isRemoteChannelDenied('settings:set')).toBe(false)
    expect(isRemoteChannelDenied('labels:list')).toBe(false)
    expect(isRemoteChannelDenied('scan:start')).toBe(false)
  })

  it('denies empty / non-string channels', () => {
    expect(isRemoteChannelDenied('')).toBe(true)
    expect(isRemoteChannelDenied(null)).toBe(true)
    expect(isRemoteChannelDenied(undefined)).toBe(true)
  })
})

describe('CLIENT_LOCAL_EVENTS', () => {
  it('keeps hub auth and updater status on the host machine', () => {
    expect(CLIENT_LOCAL_EVENTS.has('hub:auth-changed')).toBe(true)
    expect(CLIENT_LOCAL_EVENTS.has('updater:error')).toBe(true)
    expect(CLIENT_LOCAL_EVENTS.has('updater:update-available')).toBe(true)
    expect(CLIENT_LOCAL_EVENTS.has('updater:update-downloaded')).toBe(true)
    expect(CLIENT_LOCAL_EVENTS.has('wishlist:updated')).toBe(false)
    expect(CLIENT_LOCAL_EVENTS.has('packages:updated')).toBe(false)
    expect(CLIENT_LOCAL_EVENTS.has('downloads:updated')).toBe(false)
  })
})
