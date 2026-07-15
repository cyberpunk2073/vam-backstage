import { useState, useCallback, useEffect, useRef, Activity } from 'react'
import { Compass, Library, LayoutGrid, Download, Settings, Pause, Loader2, AlertTriangle, Network } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import ribbonAppIcon from '@resources/icon.png?url'
import StatusBar from '@/components/StatusBar'
import DownloadsPanel from '@/components/DownloadsPanel'
import FirstRun from '@/components/FirstRun'
import DropImport from '@/components/DropImport'
import ErrorBoundary from '@/components/ErrorBoundary'
import { ToastContainer, toast } from '@/components/Toast'
import { WhatsNewDialog } from '@/components/WhatsNewDialog'
import { ThumbnailLightbox } from '@/components/ThumbnailLightbox'
import { CHANGELOG } from '@/lib/changelog'
import { compareVersions, parseVersionCore, selectUnseen } from '@/lib/semver'
import { dismissTransientOverlays } from '@/lib/dismissOverlays'
import HubView from '@/views/HubView'
import LibraryView from '@/views/LibraryView'
import ContentView from '@/views/ContentView'
import DependencyGraphView from '@/views/DependencyGraphView'
import SettingsView from '@/views/SettingsView'

import { TooltipProvider } from '@/components/ui/tooltip'
import { useDownloadStore } from '@/stores/useDownloadStore'
import { useHubStore } from '@/stores/useHubStore'
import { useLibraryStore } from '@/stores/useLibraryStore'
import { useContentStore } from '@/stores/useContentStore'
import { useLabelsStore } from '@/stores/useLabelsStore'
import { useViewStore } from '@/stores/useViewStore'
import { useRemoteUiStore } from '@/stores/useRemoteUiStore'

const NAV_ITEMS = [
  { id: 'hub', icon: Compass, label: 'Hub' },
  { id: 'library', icon: Library, label: 'Library' },
  { id: 'content', icon: LayoutGrid, label: 'Content' },
  { id: 'graph', icon: Network, label: 'Graph' },
]
export default function App() {
  const view = useViewStore((s) => s.view)
  const setView = useViewStore((s) => s.setView)
  const blurThumbnails = useRemoteUiStore((s) => s.blurThumbnails)
  const [dlPanelOpen, setDlPanelOpen] = useState(false)
  const [showWizard, setShowWizard] = useState(null) // null=checking, true/false
  const [whatsNew, setWhatsNew] = useState(null) // { entries, current } | null
  const dlItems = useDownloadStore((s) => s.items)
  const dlPaused = useDownloadStore((s) => s.paused)
  const dlBadge = dlItems.filter((d) => d.status === 'active' || d.status === 'queued').length
  const dlErrorBadge = dlItems.filter((d) => d.status === 'failed').length

  useEffect(() => {
    useDownloadStore.getState().init()
    // View filters/sort/layout are restored synchronously by each store's persist
    // middleware; only the Settings-tab behavior prefs still load from SQLite here.
    useLibraryStore.getState().hydrateLibraryVisualPreferences()
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
        if (ids.some((item) => !valid.has(typeof item === 'object' ? item.value : item))) {
          store.setState({
            selectedLabelIds: ids.filter((item) => valid.has(typeof item === 'object' ? item.value : item)),
          })
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
    const cleanupToast = window.api.onToast(({ message, type }) => {
      toast(message, type)
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
      cleanupLabels()
      cleanupPackagesUpdated()
      cleanupContentsUpdated()
      cleanupUnreadable()
      cleanupToast()
    }
  }, [])

  useEffect(() => {
    window.api.settings.get('initial_scan_done').then((val) => {
      setShowWizard(!val)
    })
  }, [])

  useEffect(() => {
    document.documentElement.toggleAttribute('data-blur-thumbs', blurThumbnails)
  }, [blurThumbnails])

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

  // Lazy activation: a hidden <Activity> still mounts (and fetches), so only start
  // keeping a view alive once visited — otherwise launching into Library would
  // eagerly mount Hub/Content and fire a hub search on startup. Once seen, stays alive.
  const seenViews = useRef(new Set([view]))
  seenViews.current.add(view)
  const onWhatsNewDismiss = useCallback(async () => {
    if (!whatsNew) return
    const v = whatsNew.current
    setWhatsNew(null)
    await window.api.settings.set('whats_new_last_seen_version', v)
  }, [whatsNew])

  const navigateTo = useCallback(
    (targetView, context) => {
      // The outgoing view is about to be frozen by <Activity>; unmount any open overlay now,
      // while its effects are still connected, or its portal would be orphaned at the top-left.
      dismissTransientOverlays()
      if (targetView === 'hub') {
        const hub = useHubStore.getState()
        if (context?.openResource) {
          // Arriving from another view to a specific hub resource is a hub-search
          // action — snap to hub mode so the gallery behind the detail (and
          // prev/next stepping) is the hub, not the wishlist the user last viewed.
          hub.setGalleryMode('hub')
          hub.openDetail(context.openResource)
        } else if (useViewStore.getState().view === 'hub' && hub.detailResource) {
          // Re-clicking Hub while details are open is an escape hatch back to the gallery
          // (especially useful after drilling into dependency packages).
          hub.closeDetail()
        }
        // Else leave any open detail intact — returning to Hub from another view restores it.
        navContextRef.current = null
      } else {
        navContextRef.current = context || null
      }
      setView(targetView)
      setDlPanelOpen(false)
    },
    [setView],
  )

  // On a client head every `window.api` call (incl. the `initial_scan_done`
  // lookup that resolves `showWizard`) is a remote invoke queued until the
  // socket connects — so this loading phase can last the whole first-connect.
  // RemoteGate must render here too, otherwise the user stares at a black
  // screen instead of the "Connecting…" modal.
  if (showWizard === null) {
    return (
      <div className="h-full bg-base">
        <RemoteGate />
      </div>
    )
  }

  return (
    <TooltipProvider>
      <div className="flex h-full bg-base">
        <RemoteGate />
        {showWizard && <FirstRun onDone={() => setShowWizard(false)} />}
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
                onClick={() => navigateTo(item.id)}
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
              onClick={() => navigateTo('settings')}
            />
          </div>
        </nav>

        {/* Downloads panel */}
        {dlPanelOpen && <DownloadsPanel onClose={() => setDlPanelOpen(false)} />}

        {/* Main content */}
        <div className="flex-1 flex flex-col min-w-0">
          <main className="flex-1 overflow-hidden">
            <ErrorBoundary>
              {seenViews.current.has('hub') && (
                <Activity mode={view === 'hub' ? 'visible' : 'hidden'}>
                  <HubView onNavigate={navigateTo} />
                </Activity>
              )}
              {seenViews.current.has('library') && (
                <Activity mode={view === 'library' ? 'visible' : 'hidden'}>
                  <LibraryView onNavigate={navigateTo} navContext={navContextRef} />
                </Activity>
              )}
              {seenViews.current.has('content') && (
                <Activity mode={view === 'content' ? 'visible' : 'hidden'}>
                  <ContentView onNavigate={navigateTo} navContext={navContextRef} />
                </Activity>
              )}
              {seenViews.current.has('graph') && (
                <Activity mode={view === 'graph' ? 'visible' : 'hidden'}>
                  <DependencyGraphView />
                </Activity>
              )}
              {view === 'settings' && <SettingsView />}
            </ErrorBoundary>
          </main>
          <StatusBar />
        </div>
        {!showWizard && <DropImport />}
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

/**
 * Full-window blocking gate for client (remote) mode. While the socket is not
 * connected it covers the UI and swallows pointer/keyboard input, so the user
 * can't fire mutations that would queue against a dead connection (and would be
 * discarded by the reload-on-reconnect anyway).
 *
 * Client mode has no local DB, so there's no persisted "auto-connect" flag to
 * disable — but a client whose server is offline would otherwise be stuck on
 * this screen forever. So we always provide an escape: a fatal version mismatch
 * offers it immediately, and a plain connect/reconnect that hasn't succeeded
 * within a few seconds reveals it too. Either way one click relaunches the app
 * back into a normal local instance.
 */
const SLOW_CONNECT_MS = 6000

function RemoteGate() {
  const [status, setStatus] = useState(null)
  const [slowConnect, setSlowConnect] = useState(false)
  useEffect(() => {
    if (!window.api.remote?.isRemote) return
    return window.api.remote.onStatus(setStatus)
  }, [])
  const connected = status?.connected && !status?.error
  useEffect(() => {
    if (!window.api.remote?.isRemote || connected) {
      setSlowConnect(false)
      return
    }
    const t = setTimeout(() => setSlowConnect(true), SLOW_CONNECT_MS)
    return () => clearTimeout(t)
  }, [connected])
  if (!window.api.remote?.isRemote) return null
  if (connected) return null
  const isError = !!status?.error
  const showEscape = isError || slowConnect
  return (
    <AlertDialog open>
      <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogMedia className="self-center bg-transparent">
            {isError ? <AlertTriangle className="text-error" /> : <Loader2 className="animate-spin text-accent-blue" />}
          </AlertDialogMedia>
          <AlertDialogTitle>{isError ? 'Connection error' : status ? 'Reconnecting…' : 'Connecting…'}</AlertDialogTitle>
          <AlertDialogDescription className="select-text cursor-text break-all">
            {isError ? status.error : status?.url || window.api.remote.url}
          </AlertDialogDescription>
          {!isError && slowConnect && (
            <p className="col-start-2 text-[12px] text-text-tertiary">
              This is taking longer than usual — the server may be offline. You can start locally instead.
            </p>
          )}
        </AlertDialogHeader>
        {showEscape && (
          <AlertDialogFooter>
            <AlertDialogAction variant="outline" onClick={() => window.api.remote.disconnect()}>
              Switch to local mode
            </AlertDialogAction>
          </AlertDialogFooter>
        )}
      </AlertDialogContent>
    </AlertDialog>
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
