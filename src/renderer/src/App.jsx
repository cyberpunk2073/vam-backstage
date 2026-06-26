import { useState, useCallback, useEffect, useRef } from 'react'
import { Compass, Library, LayoutGrid, Download, Settings, Pause } from 'lucide-react'
import ribbonAppIcon from '@resources/icon.png?url'
import StatusBar from '@/components/StatusBar'
import DownloadsPanel from '@/components/DownloadsPanel'
import FirstRun from '@/components/FirstRun'
import ErrorBoundary from '@/components/ErrorBoundary'
import { ToastContainer, toast } from '@/components/Toast'
import { WhatsNewDialog } from '@/components/WhatsNewDialog'
import { ThumbnailLightbox } from '@/components/ThumbnailLightbox'
import { CHANGELOG } from '@/lib/changelog'
import { compareVersions, parseVersionCore, selectUnseen } from '@/lib/semver'
import {
  CONTENT_STATE_KEY,
  HUB_STATE_KEY,
  LAST_VIEW_KEY,
  LIBRARY_STATE_KEY,
  debounce,
  readSettingJson,
  sanitizeLastView,
  writeSettingJson,
} from '@/lib/view-state'
import HubView from '@/views/HubView'
import LibraryView from '@/views/LibraryView'
import ContentView from '@/views/ContentView'
import SettingsView from '@/views/SettingsView'

import { TooltipProvider } from '@/components/ui/tooltip'
import { useDownloadStore } from '@/stores/useDownloadStore'
import { useHubStore } from '@/stores/useHubStore'
import { useLibraryStore } from '@/stores/useLibraryStore'
import { useContentStore } from '@/stores/useContentStore'
import { useLabelsStore } from '@/stores/useLabelsStore'

const NAV_ITEMS = [
  { id: 'hub', icon: Compass, label: 'Hub' },
  { id: 'library', icon: Library, label: 'Library' },
  { id: 'content', icon: LayoutGrid, label: 'Content' },
]

export default function App() {
  const [view, setView] = useState('library')
  const [visitedViews, setVisitedViews] = useState(() => new Set(['library']))
  const [uiHydrated, setUiHydrated] = useState(false)
  const [dlPanelOpen, setDlPanelOpen] = useState(false)
  const [showWizard, setShowWizard] = useState(null) // null=checking, true/false
  const [whatsNew, setWhatsNew] = useState(null) // { entries, current } | null
  const dlItems = useDownloadStore((s) => s.items)
  const dlPaused = useDownloadStore((s) => s.paused)
  const dlBadge = dlItems.filter((d) => d.status === 'active' || d.status === 'queued').length
  const dlErrorBadge = dlItems.filter((d) => d.status === 'failed').length

  useEffect(() => {
    let cancelled = false
    useDownloadStore.getState().init()

    const saveHubState = debounce((state) => writeSettingJson(HUB_STATE_KEY, state), 300)
    const saveLibraryState = debounce((state) => writeSettingJson(LIBRARY_STATE_KEY, state), 300)
    const saveContentState = debounce((state) => writeSettingJson(CONTENT_STATE_KEY, state), 300)
    const cleanupHubPersistence = useHubStore.subscribe((state) => saveHubState(state.getPersistedState()))
    const cleanupLibraryPersistence = useLibraryStore.subscribe((state) => saveLibraryState(state.getPersistedState()))
    const cleanupContentPersistence = useContentStore.subscribe((state) => saveContentState(state.getPersistedState()))

    const hydrateUiState = async () => {
      try {
        const [lastView, hubState, libraryState, contentState] = await Promise.all([
          readSettingJson(LAST_VIEW_KEY, 'library'),
          readSettingJson(HUB_STATE_KEY, null),
          readSettingJson(LIBRARY_STATE_KEY, null),
          readSettingJson(CONTENT_STATE_KEY, null),
        ])

        await Promise.all([
          useHubStore.getState().hydrateHubFilterPreferences(),
          useLibraryStore.getState().hydrateLibraryVisualPreferences(),
          useContentStore.getState().hydrateContentVisualPreferences(),
        ])

        useHubStore.getState().applyPersistedState(hubState)
        useLibraryStore.getState().applyPersistedState(libraryState)
        useContentStore.getState().applyPersistedState(contentState)

        const safeView = sanitizeLastView(lastView)
        if (!cancelled) {
          setView(safeView)
          setVisitedViews(new Set([safeView]))
          setUiHydrated(true)
        }
      } catch (err) {
        console.warn('Failed to hydrate view state:', err.message)
        if (!cancelled) setUiHydrated(true)
      }
    }
    void hydrateUiState()

    // Labels are app-wide reference data; load once here (not per-view) and
    // refresh on the broadcast event. Each view used to own a copy + listener,
    // which meant whichever view was unmounted at mutation time stayed stale.
    void useLabelsStore.getState().fetchLabels()
    const cleanupLabels = window.api.onLabelsUpdated(async () => {
      await useLabelsStore.getState().fetchLabels()
      // GC dead ids from view-scoped filter selections so a deleted label
      // doesn't silently zero-match a list. Lives here (not in the labels
      // store) to keep that store free of view-coupling.
      const valid = new Set(useLabelsStore.getState().labels.map((l) => l.id))
      for (const store of [useLibraryStore, useContentStore]) {
        const ids = store.getState().selectedLabelIds
        if (ids.some((id) => !valid.has(id))) {
          store.setState({ selectedLabelIds: ids.filter((id) => valid.has(id)) })
        }
      }
    })
    // Packages are also app-wide: ContentView reads package fields off
    // `c.package` (joined from `useLibraryStore.packageByFilename` after every
    // refetch via `useContentStore.relink()`), so we need the package map
    // populated even when LibraryView isn't mounted. Load + listen here so
    // every view sees fresh package data after any `packages:updated` event.
    //
    // Selection-refresh (`refreshDetail` etc.) also lives here, not per-view,
    // because selection state has store-scope lifetime but views have mount
    // lifetime: if a mutation fires while the owning view is unmounted, its
    // listener can't catch it and the stored selection silently goes stale
    // until the user triggers another mutation *with the view mounted*.
    // App-level subscriptions catch every event regardless of active view.
    void useLibraryStore.getState().fetchPackages()
    const cleanupPackagesUpdated = window.api.onPackagesUpdated(() => {
      useLibraryStore.getState().fetchPackages()
      void useLibraryStore.getState().refreshDetail()
      void useContentStore.getState().refreshSelectedPackageDetail()
      void useHubStore.getState().refreshDetail()
    })
    const cleanupContentsUpdated = window.api.onContentsUpdated(() => {
      void useLibraryStore.getState().refreshDetail()
      void useContentStore.getState().refreshSelection()
    })
    const cleanupUnreadable = window.api.onScanUnreadable(({ filename }) => {
      toast(`Corrupted package skipped: ${filename}`)
    })
    window.api.startup.consumeUnreadable().then((filenames) => {
      if (!filenames?.length) return
      const head = filenames.slice(0, 3)
      const more = filenames.length - head.length
      const listed = head.join(', ')
      const tail = more > 0 ? ` (+${more} more)` : ''
      toast(`Startup scan: ${listed}${tail} could not be read (corrupted or invalid).`, 'error')
    })
    return () => {
      cancelled = true
      cleanupHubPersistence()
      cleanupLibraryPersistence()
      cleanupContentPersistence()
      cleanupLabels()
      cleanupPackagesUpdated()
      cleanupContentsUpdated()
      cleanupUnreadable()
    }
  }, [])

  useEffect(() => {
    window.api.settings.get('initial_scan_done').then((val) => {
      setShowWizard(!val)
    })
    window.api.settings.get('blur_thumbnails').then((val) => {
      document.documentElement.toggleAttribute('data-blur-thumbs', val === '1')
    })
  }, [])

  useEffect(() => {
    if (showWizard === null) return
    const run = async () => {
      const current = await window.api.app.getVersion()
      const lastSeen = await window.api.settings.get('whats_new_last_seen_version')
      if (!lastSeen) {
        await window.api.settings.set('whats_new_last_seen_version', current)
        return
      }
      if (!parseVersionCore(lastSeen) || !parseVersionCore(current)) {
        await window.api.settings.set('whats_new_last_seen_version', current)
        return
      }
      const cmp = compareVersions(current, lastSeen)
      if (Number.isNaN(cmp) || cmp <= 0) return
      const entries = selectUnseen(CHANGELOG, lastSeen, current)
      if (entries.length === 0) {
        await window.api.settings.set('whats_new_last_seen_version', current)
        return
      }
      setWhatsNew({ entries, current })
    }
    void run()
  }, [showWizard])

  const navContextRef = useRef(null)
  const activateView = useCallback((targetView) => {
    const safeView = sanitizeLastView(targetView)
    setVisitedViews((prev) => {
      if (prev.has(safeView)) return prev
      const next = new Set(prev)
      next.add(safeView)
      return next
    })
    setView(safeView)
    setDlPanelOpen(false)
    void writeSettingJson(LAST_VIEW_KEY, safeView)
  }, [])

  const onWhatsNewDismiss = useCallback(async () => {
    if (!whatsNew) return
    const v = whatsNew.current
    setWhatsNew(null)
    await window.api.settings.set('whats_new_last_seen_version', v)
  }, [whatsNew])

  const navigateTo = useCallback(
    (targetView, context) => {
      if (targetView === 'hub') {
        if (context?.openResource) {
          void useHubStore.getState().openDetail(context.openResource)
        }
        navContextRef.current = null
      } else {
        navContextRef.current = context || null
      }
      activateView(targetView)
    },
    [activateView],
  )

  if (showWizard === null || !uiHydrated) {
    return <div className="h-full bg-base" />
  }

  return (
    <TooltipProvider>
      <div className="flex h-full bg-base">
        {showWizard && <FirstRun onDone={() => setShowWizard(false)} />}
        {/* Ribbon */}
        <nav className="w-[56px] bg-surface flex flex-col items-center border-r border-border shrink-0">
          <div className="w-full flex flex-col items-center shrink-0 mb-1.5" title="VaM Backstage">
            <div className="w-full flex items-center justify-center h-[52px]">
              <img
                src={ribbonAppIcon}
                alt=""
                className="w-8 h-8 object-contain shrink-0 rounded-md"
                draggable={false}
              />
            </div>
            <div className="w-7 h-[2px] rounded-full bg-border-bright/60" aria-hidden />
          </div>

          <div className="flex flex-col items-center gap-1 flex-1">
            {NAV_ITEMS.map((item) => (
              <NavButton
                key={item.id}
                item={item}
                active={view === item.id && !dlPanelOpen}
                onClick={() => {
                  activateView(item.id)
                }}
              />
            ))}
          </div>

          <div className="flex flex-col items-center gap-1 pb-3">
            <NavButton
              item={{ id: 'downloads', icon: Download, label: 'Downloads' }}
              active={dlPanelOpen}
              badge={dlBadge}
              badgePaused={dlPaused && dlBadge > 0}
              errorBadge={dlErrorBadge}
              onClick={() => setDlPanelOpen(!dlPanelOpen)}
            />
            <NavButton
              item={{ id: 'settings', icon: Settings, label: 'Settings' }}
              active={view === 'settings' && !dlPanelOpen}
              onClick={() => {
                activateView('settings')
              }}
            />
          </div>
        </nav>

        {/* Downloads panel */}
        {dlPanelOpen && <DownloadsPanel onClose={() => setDlPanelOpen(false)} />}

        {/* Main content */}
        <div className="flex-1 flex flex-col min-w-0">
          <main className="flex-1 overflow-hidden">
            <ErrorBoundary>
              {visitedViews.has('hub') && (
                <div hidden={view !== 'hub'} className="h-full min-h-0">
                  <HubView onNavigate={navigateTo} active={view === 'hub'} />
                </div>
              )}
              {visitedViews.has('library') && (
                <div hidden={view !== 'library'} className="h-full min-h-0">
                  <LibraryView onNavigate={navigateTo} navContext={navContextRef} active={view === 'library'} />
                </div>
              )}
              {visitedViews.has('content') && (
                <div hidden={view !== 'content'} className="h-full min-h-0">
                  <ContentView onNavigate={navigateTo} navContext={navContextRef} active={view === 'content'} />
                </div>
              )}
              {visitedViews.has('settings') && (
                <div hidden={view !== 'settings'} className="h-full min-h-0">
                  <SettingsView />
                </div>
              )}
            </ErrorBoundary>
          </main>
          <StatusBar />
        </div>
        <ToastContainer />
        <WhatsNewDialog
          open={!!whatsNew}
          entries={whatsNew?.entries ?? []}
          version={whatsNew?.current ?? ''}
          onDismiss={onWhatsNewDismiss}
        />
        <ThumbnailLightbox />
      </div>
    </TooltipProvider>
  )
}

function NavButton({ item, active, onClick, badge, badgePaused, errorBadge }) {
  const Icon = item.icon
  return (
    <button
      onClick={onClick}
      title={item.label}
      className={`relative w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-150 cursor-pointer ${active ? 'bg-hover text-accent-blue' : 'text-text-tertiary hover:text-text-secondary hover:bg-elevated'}`}
    >
      {active && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[7px] w-[3px] h-5 rounded-r-full bg-linear-to-b from-accent-blue to-accent-pink" />
      )}
      <Icon size={20} />
      {badge > 0 && (
        <div
          className={`absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full text-white text-[9px] font-bold flex items-center justify-center ${badgePaused ? 'bg-amber-500' : 'bg-accent-blue'}`}
        >
          {badgePaused ? <Pause size={9} /> : badge}
        </div>
      )}
      {errorBadge > 0 && (
        <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-error text-white text-[9px] font-bold flex items-center justify-center">
          {errorBadge}
        </div>
      )}
    </button>
  )
}
