import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { persistViewState, asBool } from './persistViewState'

/**
 * Ephemeral renderer-only UI state persisted to localStorage. Low-stakes —
 * if it resets, the user simply sees the caution again / blur off.
 *
 * - `warningDismissed` — "no auth / trusted network" banner
 * - `blurThumbnails` — privacy blur for thumbnails (per-machine, incl. remote clients)
 *
 * Durable settings (remote section enabled, serve port, start-on-launch) stay
 * in SQLite.
 */
export const useRemoteUiStore = create(
  persist(
    (set) => ({
      warningDismissed: false,
      dismissWarning: () => set({ warningDismissed: true }),
      blurThumbnails: false,
      setBlurThumbnails: (blurThumbnails) => set({ blurThumbnails }),
    }),
    persistViewState('remote-ui', {
      warningDismissed: asBool,
      blurThumbnails: asBool,
    }),
  ),
)
