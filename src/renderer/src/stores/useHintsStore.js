import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { persistViewState, asBool } from './persistViewState'

/**
 * One-shot UI tips persisted to localStorage. Low-stakes — if it resets, the tip
 * simply reappears until the user dismisses it or learns the gesture again.
 *
 * Shared across Library and Content so learning multi-select once is enough.
 */
export const useHintsStore = create(
  persist(
    (set) => ({
      multiSelectTipDone: false,
      dismissMultiSelectTip: () => set({ multiSelectTipDone: true }),
    }),
    persistViewState('selection-hints', {
      multiSelectTipDone: asBool,
    }),
  ),
)
