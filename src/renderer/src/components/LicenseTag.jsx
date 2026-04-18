import { canonicalizeLicense, isCommercialUseAllowed, getLicenseDescription } from '../lib/licenses'
import { cn, THUMB_CHIP_BOX } from '../lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip'

export function LicenseTag({ license, className = '' }) {
  if (license == null || String(license).trim() === '') return null
  const label = canonicalizeLicense(license) || String(license).trim()
  const commercial = isCommercialUseAllowed(license)
  const tone =
    commercial === true
      ? 'border-success/35 bg-success/12 text-success'
      : commercial === false
        ? 'border-error/35 bg-error/12 text-error'
        : 'border-border bg-elevated/80 text-text-tertiary'
  const description =
    getLicenseDescription(license) ||
    (commercial === true
      ? 'Commercial use allowed'
      : commercial === false
        ? 'Commercial use not allowed'
        : 'License type could not be classified')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn(THUMB_CHIP_BOX, 'normal-case tracking-normal border cursor-default', tone, className)}>
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="block max-w-60 text-left">
        {description}
      </TooltipContent>
    </Tooltip>
  )
}
