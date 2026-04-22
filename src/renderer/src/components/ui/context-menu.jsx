import { ContextMenu as ContextMenuPrimitive } from 'radix-ui'
import { ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

function ContextMenu({ ...props }) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({ className, ...props }) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" className={cn(className)} {...props} />
}

function ContextMenuContent({ className, ...props }) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          'z-50 min-w-40 origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-md border border-border-bright bg-elevated p-1 text-xs text-text-secondary shadow-lg',
          'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({ className, inset, variant = 'default', ...props }) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset ? '' : undefined}
      data-variant={variant}
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none',
        'data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        'data-[variant=destructive]:text-error data-[variant=destructive]:data-[highlighted]:bg-error/15',
        inset && 'pl-8',
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  )
}

function ContextMenuLabel({ className, inset, ...props }) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      data-inset={inset ? '' : undefined}
      className={cn('px-2 py-1.5 text-[10px] font-medium text-text-tertiary', inset && 'pl-8', className)}
      {...props}
    />
  )
}

function ContextMenuSub({ ...props }) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuSubTrigger({ className, inset, children, ...props }) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset ? '' : undefined}
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none',
        'data-[highlighted]:bg-hover data-[state=open]:bg-hover',
        inset && 'pl-8',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight size={12} className="ml-auto shrink-0 text-text-tertiary" />
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({ className, ...props }) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        data-slot="context-menu-sub-content"
        className={cn(
          'z-50 min-w-40 origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-md border border-border-bright bg-elevated p-1 text-xs text-text-secondary shadow-lg',
          'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
}
