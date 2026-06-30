import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { persistViewState, oneOf } from './persistViewState'

// Primary views eligible to be restored on launch. Secondary surfaces (Settings,
// the Downloads overlay) are dropped by the load validator so they never become
// the reopened view.
const MAIN_VIEWS = ['hub', 'library', 'content']

export const useViewStore = create(
  persist(
    (set) => ({
      view: 'library',
      setView: (view) => set({ view }),
    }),
    persistViewState('active-view', { view: oneOf(MAIN_VIEWS) }),
  ),
)
