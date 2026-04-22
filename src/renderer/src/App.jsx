import { useState, useCallback, useEffect, useRef } from 'react'
import { Compass, Library, LayoutGrid, Download, Settings, Pause } from 'lucide-react'
import ribbonAppIcon from '@resources/icon.png?url'
import StatusBar from './components/StatusBar'
import DownloadsPanel from './components/DownloadsPanel'
import FirstRun from './components/FirstRun'
import ErrorBoundary from './components/ErrorBoundary'
import { ToastContainer, toast } from './components/Toast'
import { WhatsNewDialog } from './components/WhatsNewDialog'
import { ThumbnailLightbox } from './components/ThumbnailLightbox'
import { CHANGELOG } from './lib/changelog'
import { compareVersions, parseVersionCore, selectUnseen } from './lib/semver'
import HubView from './views/HubView'
import LibraryView from './views/LibraryView'
import ContentView from './views/ContentView'
import SettingsView from './views/SettingsView'

import { TooltipProvider } from './components/ui/tooltip'
import { useDownloadStore } from './stores/useDownloadStore'
import { useHubStore } from './stores/useHubStore'
import { useLibraryStore } from './stores/useLibraryStore'
import { useContentStore } from './stores/useContentStore'

const NAV_ITEMS = [
  { id: 'hub', icon: Compass, label: 'Hub' },
  { id: 'library', icon: Library, label: 'Library' },
  { id: 'content', icon: LayoutGrid, label: 'Content' },
]

export default function App() {
  const [view, setView] = useState('library')
  const [dlPanelOpen, setDlPanelOpen] = useState(false)
  const [showWizard, setShowWizard] = useState(null) // null=checking, true/false
  const [whatsNew, setWhatsNew] = useState(null) // { entries, current } | null
  const dlItems = useDownloadStore((s) => s.items)
  const dlPaused = useDownloadStore((s) => s.paused)
  const dlBadge = dlItems.filter((d) => d.status === 'active' || d.status === 'queued').length
  const dlErrorBadge = dlItems.filter((d) => d.status === 'failed').length

  useEffect(() => {
    useDownloadStore.getState().init()
    useHubStore.getState().hydrateHubFilterPreferences()
    useLibraryStore.getState().hydrateLibraryVisualPreferences()
    useContentStore.getState().hydrateContentVisualPreferences()
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
    return cleanupUnreadable
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
  const onWhatsNewDismiss = useCallback(async () => {
    if (!whatsNew) return
    const v = whatsNew.current
    setWhatsNew(null)
    await window.api.settings.set('whats_new_last_seen_version', v)
  }, [whatsNew])

  const navigateTo = useCallback((targetView, context) => {
    if (targetView === 'hub') {
      if (context?.openResource) {
        useHubStore.getState().openDetail(context.openResource)
      } else {
        useHubStore.getState().closeDetail()
      }
      navContextRef.current = null
    } else {
      navContextRef.current = context || null
    }
    setView(targetView)
    setDlPanelOpen(false)
  }, [])

  if (showWizard === null) {
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
                  if (item.id === 'hub') useHubStore.getState().closeDetail()
                  setView(item.id)
                  setDlPanelOpen(false)
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
                setView('settings')
                setDlPanelOpen(false)
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
              {view === 'hub' && <HubView onNavigate={navigateTo} />}
              {view === 'library' && <LibraryView onNavigate={navigateTo} navContext={navContextRef} />}
              {view === 'content' && <ContentView onNavigate={navigateTo} navContext={navContextRef} />}
              {view === 'settings' && <SettingsView />}
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
