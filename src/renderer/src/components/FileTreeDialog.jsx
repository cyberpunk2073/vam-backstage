import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  ChevronRight,
  Folder,
  FolderOpen,
  File,
  Loader2,
  UnfoldVertical,
  FoldVertical,
  ExternalLink,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/utils'

function varPackageBasename(filename) {
  if (!filename) return ''
  const parts = filename.split(/[/\\]/)
  return parts[parts.length - 1] || filename
}

/** Wraps zip contents in a single root folder labeled with the .var filename. */
function buildTreeWithPackageRoot(fileList, filename) {
  const inner = buildTree(fileList)
  const label = varPackageBasename(filename)
  const pkgNode = { name: label, children: inner.children, files: inner.files }
  return { name: '', children: new Map([[label, pkgNode]]), files: [] }
}

function buildTree(fileList) {
  const root = { name: '', children: new Map(), files: [] }
  for (const entry of fileList) {
    const parts = entry.path.split('/')
    const fileName = parts.pop()
    let node = root
    for (const dir of parts) {
      if (!node.children.has(dir)) {
        node.children.set(dir, { name: dir, children: new Map(), files: [] })
      }
      node = node.children.get(dir)
    }
    node.files.push({ name: fileName, size: entry.size })
  }
  return root
}

function collectFolderPaths(node, prefix = '') {
  const paths = []
  for (const [name, child] of node.children) {
    const p = prefix ? `${prefix}/${name}` : name
    paths.push(p)
    paths.push(...collectFolderPaths(child, p))
  }
  return paths
}

function folderSize(node) {
  let total = 0
  for (const f of node.files) total += f.size
  for (const [, child] of node.children) total += folderSize(child)
  return total
}

function folderFileCount(node) {
  let count = node.files.length
  for (const [, child] of node.children) count += folderFileCount(child)
  return count
}

function TreeFolder({ name, node, depth, expanded, onToggle, pathPrefix }) {
  const path = pathPrefix ? `${pathPrefix}/${name}` : name
  const isOpen = expanded.has(path)
  const size = useMemo(() => folderSize(node), [node])
  const count = useMemo(() => folderFileCount(node), [node])

  const sortedDirs = useMemo(() => [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b)), [node.children])
  const sortedFiles = useMemo(() => [...node.files].sort((a, b) => a.name.localeCompare(b.name)), [node.files])

  return (
    <>
      <button
        type="button"
        onClick={() => onToggle(path)}
        className="flex items-center gap-1 w-full hover:bg-elevated rounded px-1 py-0.5 cursor-pointer text-left transition-colors"
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-text-tertiary transition-transform duration-100 ${isOpen ? 'rotate-90' : ''}`}
        />
        {isOpen ? (
          <FolderOpen size={14} className="shrink-0 text-accent-blue" />
        ) : (
          <Folder size={14} className="shrink-0 text-accent-blue" />
        )}
        <span className="text-[11px] text-text-primary truncate">{name}</span>
        <span className="text-[10px] text-text-tertiary ml-auto shrink-0 pl-2 tabular-nums">
          {count} &middot; {formatBytes(size)}
        </span>
      </button>
      {isOpen && (
        <>
          {sortedDirs.map(([childName, childNode]) => (
            <TreeFolder
              key={childName}
              name={childName}
              node={childNode}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              pathPrefix={path}
            />
          ))}
          {sortedFiles.map((file) => (
            <TreeFile key={file.name} file={file} depth={depth + 1} />
          ))}
        </>
      )}
    </>
  )
}

function TreeFile({ file, depth }) {
  return (
    <div className="flex items-center gap-1 px-1 py-0.5" style={{ paddingLeft: depth * 16 + 20 }}>
      <File size={13} className="shrink-0 text-text-tertiary" />
      <span className="text-[11px] text-text-secondary truncate select-text cursor-text">{file.name}</span>
      <span className="text-[10px] text-text-tertiary ml-auto shrink-0 pl-2 tabular-nums">
        {formatBytes(file.size)}
      </span>
    </div>
  )
}

export default function FileTreeDialog({ open, onOpenChange, filename }) {
  const [fileList, setFileList] = useState(null)
  const [varPath, setVarPath] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [expanded, setExpanded] = useState(new Set())

  useEffect(() => {
    if (!open || !filename) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setFileList(null)
    setVarPath(null)
    window.api.packages.fileList(filename).then(
      (result) => {
        if (cancelled) return
        setFileList(result.fileList)
        setVarPath(result.varPath)
        setLoading(false)
      },
      (err) => {
        if (cancelled) return
        setError(err.message || 'Failed to read package')
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [open, filename])

  const tree = useMemo(() => {
    if (!fileList) return null
    const label = varPackageBasename(filename)
    if (!label) return buildTree(fileList)
    return buildTreeWithPackageRoot(fileList, filename)
  }, [fileList, filename])

  // Expand all folders on load
  useEffect(() => {
    if (!tree) return
    setExpanded(new Set(collectFolderPaths(tree)))
  }, [tree])

  const allPaths = useMemo(() => (tree ? collectFolderPaths(tree) : []), [tree])
  const allExpanded = expanded.size === allPaths.length && allPaths.length > 0

  const toggleFolder = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const expandAll = useCallback(() => setExpanded(new Set(allPaths)), [allPaths])
  const collapseAll = useCallback(() => setExpanded(new Set()), [])

  const totalSize = useMemo(() => (fileList ? fileList.reduce((s, f) => s + f.size, 0) : 0), [fileList])

  const sortedRootDirs = useMemo(
    () => (tree ? [...tree.children.entries()].sort(([a], [b]) => a.localeCompare(b)) : []),
    [tree],
  )
  const sortedRootFiles = useMemo(
    () => (tree ? [...tree.files].sort((a, b) => a.name.localeCompare(b.name)) : []),
    [tree],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg h-[85vh] flex flex-col gap-3">
        <DialogHeader className="flex-row items-center gap-2 pr-8">
          <DialogTitle className="text-sm truncate">Package files</DialogTitle>
          {tree && allPaths.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={allExpanded ? collapseAll : expandAll}
              title={allExpanded ? 'Collapse all' : 'Expand all'}
            >
              {allExpanded ? <FoldVertical size={14} /> : <UnfoldVertical size={14} />}
            </Button>
          )}
          {varPath && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => window.api.shell.showItemInFolder(varPath)}
              title="Reveal in explorer"
            >
              <ExternalLink size={14} />
            </Button>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 -mx-1">
          {loading && (
            <div className="flex items-center justify-center py-8 text-text-tertiary gap-2">
              <Loader2 size={16} className="animate-spin" /> Reading package…
            </div>
          )}
          {error && <div className="py-8 text-center text-[11px] text-error">{error}</div>}
          {tree && (
            <div className="px-1">
              {sortedRootDirs.map(([name, node]) => (
                <TreeFolder
                  key={name}
                  name={name}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggleFolder}
                  pathPrefix=""
                />
              ))}
              {sortedRootFiles.map((file) => (
                <TreeFile key={file.name} file={file} depth={0} />
              ))}
            </div>
          )}
        </div>

        {fileList && (
          <div className="text-[10px] text-text-tertiary border-t border-border pt-2 -mx-4 px-4 -mb-1 tabular-nums">
            {fileList.length} file{fileList.length !== 1 ? 's' : ''} &middot; {formatBytes(totalSize)}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
