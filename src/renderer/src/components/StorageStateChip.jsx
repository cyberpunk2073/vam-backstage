import { Archive, Boxes, Power } from 'lucide-react'
import { cn, THUMB_OVERLAY_CHIP } from '@/lib/utils'

const CHIP_CONFIG = {
  offloaded: { icon: Archive, label: 'OFFLOADED', title: null },
  archived: {
    icon: Boxes,
    label: 'ARCHIVED',
    title:
      'Stored in an archive directory: dormant, kept out of your library views, and never prompts for missing dependencies.',
  },
  disabled: { icon: Power, label: 'DISABLED', title: null },
}

export function StorageStateChip({ storageState, className }) {
  if (!storageState || storageState === 'enabled') return null
  const config = CHIP_CONFIG[storageState] ?? CHIP_CONFIG.disabled
  const Icon = config.icon
  return (
    <span
      title={config.title ?? undefined}
      className={cn(THUMB_OVERLAY_CHIP, 'bg-warning/20 text-warning flex items-center gap-1', className)}
    >
      <Icon size={10} />
      {config.label}
    </span>
  )
}
