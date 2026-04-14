import React from 'react'

import { cn } from '@/renderer/omniagents-ui/lib/utils'

import { Conversation, ConversationContent, ConversationScrollButton } from './ai/conversation'

type ConversationProps = React.ComponentProps<typeof Conversation>
type ConversationContentProps = React.ComponentProps<typeof ConversationContent>
type ChatContainerScrollAnchorProps = React.HTMLAttributes<HTMLDivElement>

export function ChatContainerRoot({ className, children, ...rest }: ConversationProps) {
  return (
    <Conversation className={cn('flex w-full min-w-0', className)} {...rest}>
      {children as React.ReactNode}
      <ConversationScrollButton />
    </Conversation>
  )
}

export function ChatContainerContent({ className, children, ...rest }: ConversationContentProps) {
  return (
    <ConversationContent className={cn('flex w-full min-w-0 flex-col', className)} {...rest}>
      {children}
    </ConversationContent>
  )
}

export function ChatContainerScrollAnchor({ className, ...rest }: ChatContainerScrollAnchorProps) {
  return <div className={cn('h-px w-full shrink-0 scroll-mt-4', className)} aria-hidden="true" {...rest} />
}
