import React from 'react';

import { cn } from '@/renderer/ds/cn';

import { Conversation, ConversationContent, ConversationScrollButton } from './ai/conversation';

type ConversationProps = React.ComponentProps<typeof Conversation>;
type ConversationContentProps = React.ComponentProps<typeof ConversationContent>;
type ChatContainerScrollAnchorProps = React.HTMLAttributes<HTMLDivElement>;

export function ChatContainerRoot({ className, children, ...rest }: ConversationProps) {
  return (
    <Conversation className={cn('flex w-full min-w-0 overflow-x-hidden', className)} {...rest}>
      {children as React.ReactNode}
      <ConversationScrollButton />
    </Conversation>
  );
}

export function ChatContainerContent({ className, children, ...rest }: ConversationContentProps) {
  return (
    <ConversationContent
      // `gap-0 p-0` neutralize the vendored ConversationContent defaults
      // (`gap-8 p-4`): the flex gap would otherwise STACK with the
      // transcript's own `space-y-*` margins (two spacing systems, ~44px
      // between every item), and the padding would fight the caller's by
      // stylesheet order. Callers own both via className.
      className={cn('flex w-full min-w-0 max-w-full flex-col gap-0 overflow-x-hidden p-0', className)}
      {...rest}
    >
      {children}
    </ConversationContent>
  );
}

export function ChatContainerScrollAnchor({ className, ...rest }: ChatContainerScrollAnchorProps) {
  return <div className={cn('h-px w-full shrink-0 scroll-mt-4', className)} aria-hidden="true" {...rest} />;
}
