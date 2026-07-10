import { app } from 'electron'
import { execFile, spawnSync } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

const execFileP = promisify(execFile)

// Squirrel.Mac (Electron's native mac updater) validates the update's code
// signature against the running app's designated requirement, which our ad-hoc
// ('-') signature can never satisfy — ShipIt aborts with "code failed to satisfy
// specified code requirement(s)". So on mac we take the zip electron-updater has
// already downloaded and sha512-verified and do ShipIt's job ourselves, minus
// the signature check: extract, strip quarantine (defensive — Node downloads
// don't set it), swap the .app bundle in place, relaunch. Same mechanism used
// by Sparkle, Tauri, Velopack and Zed's updater; macOS keeps the running
// process's inodes alive so replacing the bundle underneath it is safe.

let stageDir = null
let stagedApp = null
let stagingPromise = null
let installed = false

export function getMacBundlePath() {
  const parts = app.getPath('exe').split(path.sep)
  const i = parts.findIndex((p) => p.endsWith('.app'))
  return i === -1 ? null : parts.slice(0, i + 1).join(path.sep)
}

function assertInstallable() {
  const bundle = getMacBundlePath()
  if (!bundle) throw new Error('Not running from an .app bundle; cannot self-update.')
  // Gatekeeper runs quarantined apps from a randomized read-only mount; the real
  // bundle path is unknowable from here, so a swap is impossible.
  if (bundle.includes('/AppTranslocation/')) {
    throw new Error(
      'App is running translocated by Gatekeeper. Move it to /Applications and run: xattr -dr com.apple.quarantine "/Applications/VaM Backstage.app"',
    )
  }
  return bundle
}

async function cleanupStage() {
  const dir = stageDir
  stageDir = null
  stagedApp = null
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

// Extract + de-quarantine as soon as the download lands, so the install step at
// quit/restart time is just two renames. Resolves to the staged .app path.
export function stageMacUpdate(zipPath) {
  stagingPromise = (async () => {
    await cleanupStage()
    installed = false
    assertInstallable()
    stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vam-backstage-update-'))
    // ditto preserves the framework symlinks and permissions a plain unzip can mangle.
    await execFileP('/usr/bin/ditto', ['-xk', zipPath, stageDir])
    const appName = (await fs.readdir(stageDir)).find((e) => e.endsWith('.app'))
    if (!appName) throw new Error('Update archive contains no .app bundle')
    const staged = path.join(stageDir, appName)
    await execFileP('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {})
    stagedApp = staged
    return staged
  })()
  return stagingPromise
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`)
}

// Synchronous so it can also run inside will-quit. /bin/mv instead of fs.rename
// because the staging dir may be on a different volume than /Applications.
function swapBundleSync() {
  if (stagedApp == null) throw new Error('No update staged')
  const bundle = assertInstallable()
  const old = `${bundle}.pre-update`
  spawnSync('/bin/rm', ['-rf', old])
  run('/bin/mv', [bundle, old])
  try {
    run('/bin/mv', [stagedApp, bundle])
  } catch (e) {
    spawnSync('/bin/mv', [old, bundle])
    throw e
  }
  spawnSync('/bin/rm', ['-rf', old])
  installed = true
  stagedApp = null
}

// "Restart" button path: wait for staging if it's still extracting, swap, relaunch.
export async function installMacUpdateAndRestart() {
  if (stagingPromise == null) return { ok: false, error: 'No update has been downloaded yet' }
  try {
    await stagingPromise
    swapBundleSync()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  app.relaunch()
  app.quit()
  return { ok: true }
}

// autoInstallOnAppQuit parity: user quits normally with an update staged → swap
// silently on the way out (no relaunch). Skipped if staging hasn't finished;
// never block quit on extraction.
export function installMacUpdateOnQuitSync() {
  if (installed || stagedApp == null) return
  try {
    swapBundleSync()
  } catch (e) {
    console.warn('[updater] install-on-quit failed:', e instanceof Error ? e.message : String(e))
  }
}
