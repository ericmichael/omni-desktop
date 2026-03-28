import React from 'react'
import { StickToBottom } from 'use-stick-to-bottom'
import { cn } from '../lib/utils'

type StickToBottomProps = React.ComponentProps<typeof StickToBottom>
type StickToBottomContentProps = React.ComponentProps<typeof StickToBottom.Content>

type ChatContainerScrollAnchorProps = React.HTMLAttributes<HTMLDivElement>

export function ChatContainerRoot({ className, resize = 'smooth', initial = 'instant', role = 'log', children, ...rest }: StickToBottomProps) {
  return (
    <StickToBottom className={cn('flex w-full min-w-0 overflow-y-auto', className)} resize={resize} initial={initial} role={role} {...rest}>
      {children}
    </StickToBottom>
  )
}

export function ChatContainerContent({ className, children, ...rest }: StickToBottomContentProps) {
  return (
    <StickToBottom.Content className={cn('flex w-full min-w-0 flex-col', className)} {...rest}>
      {children}
    </StickToBottom.Content>
  )
}

export function ChatContainerScrollAnchor({ className, ...rest }: ChatContainerScrollAnchorProps) {
  return <div className={cn('h-px w-full shrink-0 scroll-mt-4', className)} aria-hidden="true" {...rest} />
}
