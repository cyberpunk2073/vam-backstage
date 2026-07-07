import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { persistViewState, asBool } from './persistViewState'

/**
 * Ephemeral renderer-only UI state for client-server mode, persisted to
 * localStorage. Just the dismissal of the "no auth / trusted network" warning —
 * low-stakes, and if it resets the user simply sees the caution again.
 *
 * The durable settings (whether the section is enabled, the serve port, and
 * start-on-launch) stay in SQLite.
 */
export const useRemoteUiStore = create(
  persist(
    (set) => ({
      warningDismissed: false,
      dismissWarning: () => set({ warningDismissed: true }),
    }),
    persistViewState('remote-ui', { warningDismissed: asBool }),
  ),
)
