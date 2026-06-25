import { useState, useEffect, useMemo, useCallback } from 'react'
import { Loader2, Link2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { HubCard } from '@/components/PackageCard'
import { toast } from '@/components/Toast'
import { useLibraryStore } from '@/stores/useLibraryStore'

/**
 * Parse a Hub resource id from a pasted link or raw id. Accepts a bare numeric
 * id, or a hub URL like `…/resources/some-slug.40358/` or `…/resources/40358/`.
 * Returns null on anything else — no last-digit-group fallback (it returns garbage).
 */
export function parseHubResourceId(input) {
  const s = String(input ?? '').trim()
  if (/^\d+$/.test(s)) return s
  const m = s.match(/\/resources\/(?:.*\.)?(\d+)/)
  return m ? m[1] : null
}

const NO_RESOURCE_MSG = 'No resource found for that link or ID.'

/** Turn a raw IPC/Hub error into a short, user-readable message. */
function cleanHubError(err) {
  const raw = (err?.message || '')
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  if (/resource not found/i.test(raw)) return NO_RESOURCE_MSG
  return raw || 'Failed to look up that resource.'
}

export default function LinkHubDialog({ pkg, open, onOpenChange }) {
  const [input, setInput] = useState('')
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState(null)

  const rid = useMemo(() => parseHubResourceId(input), [input])

  useEffect(() => {
    if (!open) return
    setInput('')
    setDetail(null)
    setLoading(false)
    setLinking(false)
    setError(null)
  }, [open])

  // Auto-fetch a preview when the parsed id changes (debounced).
  useEffect(() => {
    if (!rid) {
      setDetail(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setDetail(null)
    const t = setTimeout(async () => {
      try {
        const result = await window.api.hub.detail(rid)
        if (cancelled) return
        if (!result?.resource_id || !result?.title) setError(NO_RESOURCE_MSG)
        else setDetail(result)
      } catch (err) {
        if (!cancelled) setError(cleanHubError(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [rid])

  const handleLink = useCallback(async () => {
    if (!rid || linking) return
    setLinking(true)
    try {
      await window.api.packages.setHubResource(pkg.filename, rid)
      await useLibraryStore.getState().fetchPackages()
      await useLibraryStore.getState().refreshDetail()
      toast('Linked to Hub', 'success', 2500)
      onOpenChange(false)
    } catch (err) {
      toast(`Failed to link: ${cleanHubError(err)}`)
      setLinking(false)
    }
  }, [rid, linking, pkg.filename, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle className="text-sm">Link to Hub</DialogTitle>
          <DialogDescription className="text-[12px]">
            Paste a Hub resource link or ID to manually match this package. Use this when the automatic match is missing
            or wrong.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="https://hub.virtamate.com/resources/… or ID"
            className="text-[12px] pr-8"
          />
          {loading && (
            <Loader2
              size={14}
              className="animate-spin absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
            />
          )}
        </div>

        {input.trim() !== '' && !rid ? (
          <p className="text-[11px] text-text-tertiary px-0.5">Paste a full Hub resource link or a numeric ID.</p>
        ) : error ? (
          <p className="text-[11px] text-error px-0.5">{error}</p>
        ) : null}

        {detail && (
          <HubCard
            resource={detail}
            linkAction={
              <Button
                variant="gradient"
                onClick={() => void handleLink()}
                disabled={linking}
                className="w-full text-[11px]"
              >
                {linking ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
                {linking ? 'Linking…' : 'Link this package'}
              </Button>
            }
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
