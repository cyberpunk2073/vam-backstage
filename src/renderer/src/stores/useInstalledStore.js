import { create } from 'zustand'

export const useInstalledStore = create((set, get) => ({
  byHubResourceId: new Map(),

  applyBatch: (entries) => {
    const prev = get().byHubResourceId
    let next
    for (const e of entries) {
      const key = String(e.hubResourceId)
      const installed = !!e.installed
      const isDirect = !!e.isDirect
      const filename = e.filename || null
      const old = prev.get(key)
      if (old && old.installed === installed && old.isDirect === isDirect && old.filename === filename) continue
      if (!next) next = new Map(prev)
      next.set(key, { installed, isDirect, filename })
    }
    if (next) set({ byHubResourceId: next })
  },

  update: (hubResourceId, installed, isDirect, filename) => {
    const prev = get().byHubResourceId
    const key = String(hubResourceId)
    const inst = !!installed
    const dir = !!isDirect
    const fn = filename || null
    const old = prev.get(key)
    if (old && old.installed === inst && old.isDirect === dir && old.filename === fn) return
    const next = new Map(prev)
    next.set(key, { installed: inst, isDirect: dir, filename: fn })
    set({ byHubResourceId: next })
  },
}))
