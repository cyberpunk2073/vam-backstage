import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Synthetic-dirent unit test for collectVarCandidates ───────────────────────
//
// The load-bearing Windows quirk: a directory symlink reports
// `isDirectory() === false` AND `isSymbolicLink() === true`. The walker must
// see the explicit `isSymbolicLink()` short-circuit BEFORE the `isDirectory()`
// branch — otherwise we miss directory symlinks on Windows and re-introduce
// the BrowserAssist 60k-FilePrefs hang once chokidar follows them later.
//
// We don't try to create a real symlink: Windows requires Developer Mode for
// `fs.symlink`, and on Linux symlinks behave correctly so the test wouldn't
// exercise the bug class anyway. Instead, we mock `fs/promises.readdir` to
// return synthetic dirents shaped to reproduce the Windows bug class.

function dirent({ name, isFile = false, isDir = false, isSymlink = false }) {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => isDir,
    isSymbolicLink: () => isSymlink,
  }
}

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises')
  return { ...actual, readdir: vi.fn() }
})

describe('collectVarCandidates — symlink skip', () => {
  let collectVarCandidates
  let readdir

  beforeEach(async () => {
    vi.resetModules()
    const fsPromises = await import('fs/promises')
    readdir = fsPromises.readdir
    readdir.mockReset()
    const mod = await import('./index.js')
    collectVarCandidates = mod.collectVarCandidates
  })

  it('skips a Windows directory symlink (isSymbolicLink=true, isDirectory=false)', async () => {
    // Top-level: one regular .var, one directory symlink to "elsewhere".
    readdir.mockImplementation(async (dir) => {
      if (dir === '/root') {
        return [
          dirent({ name: 'Author.Pkg.1.var', isFile: true }),
          // Windows-style directory symlink — isDirectory() returns false, isSymbolicLink() true.
          dirent({ name: 'symlink-to-elsewhere', isSymlink: true, isDir: false, isFile: false }),
        ]
      }
      // If anything tried to recurse into the symlink path, fail loud.
      throw new Error(`Unexpected readdir into ${dir}`)
    })

    const out = []
    const ok = await collectVarCandidates('/root', out, true)
    expect(ok).toBe(true)
    expect(out).toHaveLength(1)
    expect(out[0].canonical).toBe('Author.Pkg.1.var')
    // readdir must have been called exactly once — never recursed into the symlink.
    expect(readdir.mock.calls.length).toBe(1)
  })

  it('skips a symlink even when isSymbolicLink=true AND isDirectory=true', async () => {
    readdir.mockImplementation(async (dir) => {
      if (dir === '/root') {
        return [dirent({ name: 'X.Y.1.var', isFile: true }), dirent({ name: 'symdir', isSymlink: true, isDir: true })]
      }
      throw new Error(`Unexpected readdir into ${dir}`)
    })
    const out = []
    await collectVarCandidates('/root', out, true)
    expect(out.map((x) => x.canonical)).toEqual(['X.Y.1.var'])
  })

  it('recurses into a real subdirectory (not a symlink)', async () => {
    readdir.mockImplementation(async (dir) => {
      if (dir === '/root') {
        return [dirent({ name: 'sub', isDir: true, isFile: false, isSymlink: false })]
      }
      if (dir === '/root/sub') {
        return [dirent({ name: 'Nest.Author.1.var', isFile: true })]
      }
      throw new Error(`Unexpected ${dir}`)
    })
    const out = []
    const ok = await collectVarCandidates('/root', out, true)
    expect(ok).toBe(true)
    expect(out.some((x) => x.canonical === 'Nest.Author.1.var')).toBe(true)
  })

  it('returns false when the root directory itself is unreachable', async () => {
    readdir.mockImplementation(async () => {
      throw new Error('EACCES')
    })
    const out = []
    const ok = await collectVarCandidates('/root', out, true)
    expect(ok).toBe(false)
    expect(out).toHaveLength(0)
  })

  it('returns true when a sub-directory readdir fails (silent skip)', async () => {
    readdir.mockImplementation(async (dir) => {
      if (dir === '/root') {
        return [dirent({ name: 'bad', isDir: true })]
      }
      if (dir === '/root/bad') {
        throw new Error('ENOENT')
      }
      throw new Error(`Unexpected ${dir}`)
    })
    const out = []
    const ok = await collectVarCandidates('/root', out, true)
    expect(ok).toBe(true)
    expect(out).toHaveLength(0)
  })

  it('within one directory bare .var wins over .var.disabled for the same canonical', async () => {
    readdir.mockImplementation(async (dir) => {
      if (dir === '/root') {
        return [dirent({ name: 'A.B.1.var.disabled', isFile: true }), dirent({ name: 'A.B.1.var', isFile: true })]
      }
      throw new Error(`Unexpected ${dir}`)
    })
    const out = []
    await collectVarCandidates('/root', out, true)
    expect(out).toHaveLength(1)
    expect(out[0].canonical).toBe('A.B.1.var')
    expect(out[0].isDisabled).toBe(false)
  })

  it('does not dedup across different dirs — both canonical copies appear', async () => {
    readdir.mockImplementation(async (dir) => {
      if (dir === '/a') {
        return [dirent({ name: 'Same.Name.1.var', isFile: true })]
      }
      if (dir === '/b') {
        return [dirent({ name: 'Same.Name.1.var', isFile: true })]
      }
      throw new Error(`Unexpected ${dir}`)
    })
    const outA = [],
      outB = []
    await collectVarCandidates('/a', outA, true)
    await collectVarCandidates('/b', outB, true)
    expect(outA).toHaveLength(1)
    expect(outB).toHaveLength(1)
  })
})
