import { CheckCircleIcon, ChevronDownIcon, CircleIcon, ClockIcon, WrenchIcon, XCircleIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { isValidElement } from 'react'

import type { DynamicToolUIPart, ToolUIPart } from '@/renderer/omniagents-ui/ai-types'
import { Badge } from '@/renderer/omniagents-ui/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/omniagents-ui/components/ui/collapsible'
import { cn } from '@/renderer/omniagents-ui/lib/utils'

import { CodeBlock } from './code-block'

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn('group not-prose mb-4 w-full rounded-md border bg-muted', className)} {...props} />
)

export type ToolPart = ToolUIPart | DynamicToolUIPart

export type ToolHeaderProps = {
  title?: string
  preview?: string
  className?: string
} & (
  | { type: ToolUIPart['type']; state: ToolUIPart['state']; toolName?: never }
  | { type: DynamicToolUIPart['type']; state: DynamicToolUIPart['state']; toolName: string }
)

const statusLabels: Record<ToolPart['state'], string> = {
  'approval-requested': 'Awaiting Approval',
  'approval-responded': 'Responded',
  'input-available': 'Running',
  'input-streaming': 'Pending',
  'output-available': 'Completed',
  'output-denied': 'Denied',
  'output-error': 'Error',
}

const statusIcons: Record<ToolPart['state'], ReactNode> = {
  'approval-requested': <ClockIcon className="size-4 text-warning" />,
  'approval-responded': <CheckCircleIcon className="size-4 text-info" />,
  'input-available': <ClockIcon className="size-4 animate-pulse" />,
  'input-streaming': <CircleIcon className="size-4" />,
  'output-available': <CheckCircleIcon className="size-4 text-success" />,
  'output-denied': <XCircleIcon className="size-4 text-warning" />,
  'output-error': <XCircleIcon className="size-4 text-destructive" />,
}

export const getStatusBadge = (status: ToolPart['state']) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
)

export const ToolHeader = ({ className, title, preview, type, state, toolName, ...props }: ToolHeaderProps) => {
  const derivedName = type === 'dynamic-tool' ? toolName : type.split('-').slice(1).join('-')

  return (
    <CollapsibleTrigger className={cn('flex w-full items-center gap-4 p-3', className)} {...props}>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <WrenchIcon className="size-4 text-muted-foreground flex-shrink-0" />
        <span className="inline-flex items-center gap-1 min-w-0 text-sm">
          <span className="font-medium text-foreground">{title ?? derivedName}</span>
          {preview ? <span className="text-muted-foreground truncate">({preview})</span> : null}
        </span>
      </div>
      {getStatusBadge(state)}
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform flex-shrink-0 group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  )
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className
    )}
    {...props}
  />
)

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolPart['input']
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn('space-y-2 overflow-hidden', className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Parameters</h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
)

export type ToolOutputProps = ComponentProps<'div'> & {
  output: ToolPart['output']
  errorText: ToolPart['errorText']
}

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (!(output || errorText)) {
return null
}

  let Output = <div>{output as ReactNode}</div>

  if (typeof output === 'object' && !isValidElement(output)) {
    Output = <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
  } else if (typeof output === 'string') {
    Output = <CodeBlock code={output} language="json" />
  }

  return (
    <div className={cn('space-y-2', className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{errorText ? 'Error' : 'Result'}</h4>
      <div className={cn('overflow-x-auto rounded-md text-xs [&_table]:w-full', errorText ? 'bg-destructive/10 text-destructive' : 'bg-muted/50 text-foreground')}>
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  )
}
