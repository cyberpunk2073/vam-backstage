import { Worker } from 'worker_threads'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

/**
 * Warm @parcel/watcher's native backend on a worker thread, off the main thread.
 *
 * The problem this works around (Windows, hard-won):
 *   The first `parcelWatcher.subscribe()` in the process lazily creates parcel's
 *   process-global backend, which spawns a native watcher thread and *synchronously blocks
 *   the calling thread* until that thread starts (`Backend::run` → `mStartedSignal.wait`).
 *   When the app is launched detached from a console (Explorer / installed shortcut) AND
 *   this runs after our heavy startup I/O (the ~80k-file prefs walk + library scan), that
 *   thread bring-up stalls ~5s at *zero CPU* on the calling thread — and since the first
 *   subscribe happens on the main process thread, the whole UI freezes for ~5s.
 *
 *   Measured facts behind the fix:
 *     - Same init costs ~15ms when the app is launched from a console (always fast).
 *     - On the main thread it's fast if done *before* the scan/prefs + window creation, ~5s if *after*.
 *     - On a worker thread it's ~300ms *regardless* of timing — the stall never happens.
 *     - During the stall the calling thread burns ~0 CPU: it's a pure wait for the new
 *       backend thread to even start running.
 *     - Not Defender, not the network; process priority class has no effect. The set of
 *       loaded DLLs is byte-for-byte identical between a fast (console) and slow (Explorer)
 *       launch, so it is NOT an injected / GUI-only module.
 *   Leading (unproven) theory: the new backend thread's bring-up (`ntdll!LdrpInitializeThread`
 *   → a `DLL_THREAD_ATTACH` of a window-creation DLL) makes a synchronous cross-thread call
 *   that needs the main thread — an STA after the window exists — to pump messages. When the
 *   subscribe runs *on the main thread*, the main thread is blocked inside subscribe() and
 *   can't pump, so the call waits out a ~5s timeout. Creating the thread from a worker leaves
 *   the main thread free to pump, so it returns immediately. The decisive evidence is that a
 *   worker warm-up is fast even *late* (after the I/O + window) — ruling out the loader lock
 *   and module presence, and leaving "is the main thread free to pump" as the deciding factor.
 *   The warm-up is robust whether or not that exact theory holds.
 *
 * How it works:
 *   parcel's backend is a process-global C++ singleton shared across worker_threads, so
 *   creating it from a worker means the real watchers (which stay on the main thread) reuse
 *   it and subscribe in ~1ms with no main-thread stall. We keep the worker — and its
 *   throwaway empty-dir subscription — alive for the process lifetime so the backend's
 *   subscription count never drops to zero. If it did (e.g. a full `stopWatcher()` →
 *   `startWatcher()` cycle), the next main-thread subscribe would re-trigger the stall.
 *   The worker is `unref`'d so it never blocks app quit, and watches an empty temp dir so it
 *   carries no event-handling overhead — the real (potentially noisy) watchers stay on main.
 */
let warmPromise = null

/** Idempotent: the first call spawns the warm-up worker; later calls return the same
 *  promise. Call it bare to kick the warm-up off early (fire-and-forget); `await` it before
 *  the first real subscribe to gate on it. Resolves (never rejects) even if warming failed —
 *  callers then just hit the unwarmed path. */
export function warmFileWatcherBackend() {
  if (warmPromise) return warmPromise
  const watcherEntry = (() => {
    try {
      return require.resolve('@parcel/watcher')
    } catch {
      return '@parcel/watcher'
    }
  })()

  const code = `
    const { parentPort, workerData } = require('worker_threads')
    const { mkdtempSync } = require('fs')
    const { join } = require('path')
    const { tmpdir } = require('os')
    try {
      const watcher = require(workerData.watcherEntry)
      const dir = mkdtempSync(join(tmpdir(), 'vam-fswarm-'))
      // Hold this subscription open forever: it pins parcel's shared backend alive so the
      // main thread's real watchers never have to (re)create it. Never resolves to 'done'
      // until the subscribe call settles; we keep the worker running afterwards.
      watcher.subscribe(dir, () => {}, {})
        .then(() => parentPort.postMessage('ok'))
        .catch((e) => parentPort.postMessage('err:' + (e && e.message)))
    } catch (e) {
      parentPort.postMessage('err:' + (e && e.message))
    }
  `

  warmPromise = new Promise((resolve) => {
    let worker
    try {
      worker = new Worker(code, { eval: true, workerData: { watcherEntry } })
    } catch (err) {
      // If we can't even spawn the worker, fall back silently: the real watchers will just
      // pay the unwarmed cost (i.e. current behavior). Don't block startup on the warm-up.
      console.warn('[watcher-warm] could not spawn warm-up worker:', err.message)
      resolve()
      return
    }
    worker.unref() // never keep the process alive / block quit on the warm worker
    worker.once('message', (m) => {
      if (typeof m === 'string' && m.startsWith('err:')) console.warn('[watcher-warm] warm-up failed:', m.slice(4))
      resolve()
    })
    worker.once('error', (err) => {
      console.warn('[watcher-warm] warm-up worker error:', err.message)
      resolve()
    })
  })
  return warmPromise
}
