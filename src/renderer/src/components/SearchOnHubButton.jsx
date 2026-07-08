import { ArrowRight } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useHubStore } from '@/stores/useHubStore'

/**
 * Low-profile affordance placed next to an "Author" filter header: jump to a Hub
 * search scoped to the currently filtered author. Sets the hub author filter and
 * switches to hub gallery mode (see useHubStore.searchHubForAuthor); when rendered
 * from another view, `onNavigate` brings the user over to the hub view.
 * Renders nothing unless an author filter is active.
 */
export function SearchOnHubButton({ author, onNavigate }) {
  if (!author) return null
  const handleClick = () => {
    useHubStore.getState().searchHubForAuthor(author)
    onNavigate?.('hub')
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          aria-label={`Search Hub for ${author}`}
          className="shrink-0 -my-1 p-0.5 rounded text-text-tertiary hover:text-accent-blue transition-colors cursor-pointer"
        >
          <ArrowRight size={13} strokeWidth={2.5} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">Search Hub for “{author}”</TooltipContent>
    </Tooltip>
  )
}
