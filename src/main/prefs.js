import { join, dirname } from 'path'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { DEFAULT_REMOTE_PORT } from '@shared/remote-config.js'

/**
 * Machine-scoped preferences, deliberately outside the SQLite `settings` table.
 *
 * The `settings` table is *workspace* scope: it travels with `backstage.db`, and
 * a client head reads/writes it on the server (`settings:*` is not a
 * client-local channel), which is right for library data — setting the VaM dir
 * from a client must change it on the host. The keys here are the other scope:
 * they describe this machine's installation, so
 *
 *   - a client head must keep its own copy even though it has no database, and
 *   - the value must not be shared with another head over the WS bridge, and
 *   - it survives `dev:nuke-database`, because it isn't library data.
 *
 * "This machine" splits once more, hence two stores:
 *
 *   install  — bound to the BASE userData dir, before the `-client` swap in
 *              index.js, so a host and a client head on the same machine agree.
 *              Same binary → same update channel; and the host's escape hatch
 *              must be able to disarm the client's auto-connect.
 *   instance — bound to the post-swap userData dir: state that must NOT be
 *              shared, because host and client each own a window.
 *
 * Admission rules — keep these lists short, this is not a second settings
 * table. A key belongs here only when (1) main needs it before a window or the
 * DB exists, and (2) sharing it with another head would be wrong. Everything
 * else is library data (`settings` table) or view state (renderer
 * `localStorage`).
 *
 * Keys are declared below with a default and a parser, which is what keeps the
 * files migration-free: unknown keys are ignored on read (and preserved on
 * write, so an older build can't destroy a newer one's value), and a corrupt
 * value falls back to its default.
 */

const asBool = (v) => v === true
const asTrimmedString = (v) => (typeof v === 'string' ? v.trim() : '')

const INSTALL_KEYS = {
  /** `'stable' | 'dev'` — which feed this installed binary updates from (§23). */
  updateChannel: { default: 'stable', parse: (v) => (v === 'dev' ? 'dev' : 'stable') },
  /** The 7-tap unlock for developer options / DevTools hotkeys. */
  devUnlocked: { default: false, parse: asBool },
  /** Last server address entered in Settings → Remote, as typed (not normalized). */
  connectUrl: { default: '', parse: asTrimmedString },
  /** Armed: launch as a client head pointed at `connectUrl` (see remote/autostart.js). */
  autoconnect: { default: false, parse: asBool },
  /** Settings → Remote section revealed (server UI + auto-start). */
  remoteEnabled: { default: false, parse: asBool },
  /** Start the LAN server on launch, on `servePort`. */
  serveOnLaunch: { default: false, parse: asBool },
  servePort: {
    default: DEFAULT_REMOTE_PORT,
    parse: (v) => {
      const n = parseInt(v, 10)
      return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_REMOTE_PORT
    },
  },
}

const INSTANCE_KEYS = {
  /** `{ x, y, width, height, isMaximized }`; re-validated against live displays on read. */
  windowState: { default: null, parse: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null) },
}

/**
 * One JSON file's worth of declared keys. Values are read straight off disk on
 * every access rather than cached: the install file is shared by two processes
 * (a host and a client head on the same machine), the files are a few hundred
 * bytes, and reads happen at startup and on Settings mount — so a cache would
 * only buy staleness.
 *
 * Concurrency contract for that shared file, with two OS processes and no lock:
 *
 *   - A reader never sees a partial file. Writes go to a per-pid scratch file and
 *     are published with `rename`, so the target is always one complete version.
 *   - A writer never drops keys it didn't touch: `patch` re-reads immediately
 *     before writing, so anything the other process published first survives.
 *   - Not prevented: a true interleave (both read, both write) loses the key of
 *     whichever wrote first. The window is microseconds and every key here is
 *     changed by a human in one window at a time, so this is accepted rather
 *     than paid for with a lock file — a stale lock would be the worse failure.
 *
 * Per-instance files have a single writer and none of this applies to them.
 */
function createPrefsStore(filename, keys) {
  let filePath = null

  function spec(key) {
    const s = keys[key]
    if (!s) throw new Error(`unknown pref key: ${key}`)
    return s
  }

  function readRaw() {
    if (!filePath || !existsSync(filePath)) return {}
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeRaw(data) {
    // Per-pid scratch file. A shared name would be a real corruption path rather
    // than a lost update: the host and a client head would truncate and fill the
    // same scratch file concurrently, then publish whatever bytes it happened to
    // hold. Within one process all writes here are synchronous, so a single name
    // per pid is enough, and a crash leaves at most one stray file behind.
    const tmpPath = `${filePath}.${process.pid}.tmp`
    let fd = null
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      fd = openSync(tmpPath, 'w')
      writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8')
      // Flush before publishing: without it the rename can be durable while the
      // contents are not, and a reader would then fall back to defaults —
      // silently resetting e.g. the update channel.
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      // Atomic replace on both POSIX and Windows (MoveFileEx), so a crash or a
      // concurrent reader never observes a half-written file.
      renameSync(tmpPath, filePath)
      return true
    } catch (err) {
      console.warn(`[prefs] failed to write ${filename}:`, err.message)
      try {
        if (fd != null) closeSync(fd)
        rmSync(tmpPath, { force: true })
      } catch {}
      return false
    }
  }

  function resolve(raw, key) {
    const s = spec(key)
    return Object.hasOwn(raw, key) ? s.parse(raw[key]) : s.default
  }

  return {
    /** Bind this store's directory. Must run before any read or write. */
    init(dir) {
      filePath = join(dir, filename)
    },
    path() {
      return filePath
    },
    /** True when the key is present on disk, i.e. explicitly set rather than defaulted. */
    has(key) {
      spec(key)
      return Object.hasOwn(readRaw(), key)
    },
    get(key) {
      return resolve(readRaw(), key)
    },
    /** Read several keys with a single file read. */
    pick(keyList) {
      const raw = readRaw()
      const out = {}
      for (const key of keyList) out[key] = resolve(raw, key)
      return out
    },
    /**
     * Merge `values` in. Re-reads the file first, so a concurrent write from the
     * other instance on this machine can at worst lose the one key it was
     * writing, never the rest of the file.
     */
    patch(values) {
      if (!filePath) return false
      const next = readRaw()
      for (const [key, value] of Object.entries(values)) next[key] = spec(key).parse(value)
      return writeRaw(next)
    },
    set(key, value) {
      return this.patch({ [key]: value })
    },
  }
}

export const installPrefs = createPrefsStore('install-prefs.json', INSTALL_KEYS)
export const instancePrefs = createPrefsStore('instance-prefs.json', INSTANCE_KEYS)
