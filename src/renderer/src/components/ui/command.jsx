import * as React from 'react'
import { Command as CmdkCommand } from 'cmdk'

import { cn } from '@/lib/utils'

const Command = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <CmdkCommand
      ref={ref}
      data-slot="command"
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-md bg-transparent text-text-secondary',
        className,
      )}
      {...props}
    />
  )
})
Command.displayName = 'Command'

const CommandInput = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <div className="flex items-center border-b border-border px-2" data-slot="command-input-wrapper">
      <CmdkCommand.Input
        ref={ref}
        className={cn(
          'flex h-8 w-full rounded-md bg-transparent py-2 text-xs outline-none placeholder:text-text-tertiary disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  )
})
CommandInput.displayName = 'CommandInput'

const CommandList = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <CmdkCommand.List
      ref={ref}
      data-slot="command-list"
      className={cn('max-h-64 overflow-y-auto overflow-x-hidden p-1', className)}
      {...props}
    />
  )
})
CommandList.displayName = 'CommandList'

const CommandEmpty = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <CmdkCommand.Empty
      ref={ref}
      className={cn('py-2 text-center text-[11px] text-text-tertiary', className)}
      {...props}
    />
  )
})
CommandEmpty.displayName = 'CommandEmpty'

const CommandGroup = React.forwardRef(({ className, ...props }, ref) => {
  return <CmdkCommand.Group ref={ref} className={cn('overflow-hidden text-text-secondary', className)} {...props} />
})
CommandGroup.displayName = 'CommandGroup'

const CommandSeparator = React.forwardRef(({ className, ...props }, ref) => {
  return <CmdkCommand.Separator ref={ref} className={cn('-mx-1 h-px bg-border', className)} {...props} />
})
CommandSeparator.displayName = 'CommandSeparator'

const CommandItem = React.forwardRef(({ className, ...props }, ref) => {
  return (
    <CmdkCommand.Item
      ref={ref}
      data-slot="command-item"
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none',
        'data-[selected=true]:bg-hover aria-selected:bg-hover',
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40',
        className,
      )}
      {...props}
    />
  )
})
CommandItem.displayName = 'CommandItem'

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandSeparator, CommandItem }
