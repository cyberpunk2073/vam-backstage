import { Archive, EyeOff } from 'lucide-react'
import { cn, THUMB_OVERLAY_CHIP } from '@/lib/utils'

export function StorageStateChip({ storageState, className }) {
  if (!storageState || storageState === 'enabled') return null
  const isOffloaded = storageState === 'offloaded'
  return (
    <span className={cn(THUMB_OVERLAY_CHIP, 'bg-warning/20 text-warning flex items-center gap-1', className)}>
      {isOffloaded ? <Archive size={10} /> : <EyeOff size={10} />}
      {isOffloaded ? 'OFFLOADED' : 'DISABLED'}
    </span>
  )
}
