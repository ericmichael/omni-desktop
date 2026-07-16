import { CheckCircleIcon, ChevronDownIcon, CircleIcon, ClockIcon, WrenchIcon, XCircleIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { isValidElement } from 'react';

import type { DynamicToolUIPart, ToolUIPart } from '@/renderer/omniagents-ui/ai-types';
import { Badge } from '@/renderer/omniagents-ui/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/renderer/omniagents-ui/components/ui/collapsible';
import { cn } from '@/renderer/omniagents-ui/lib/utils';

import { CodeBlock } from './code-block';

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    data-slot="tool"
    className={cn(
      'group not-prose mb-4 w-full min-w-0 max-w-full overflow-hidden rounded-md border bg-muted',
      className
    )}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  preview?: string;
  className?: string;
} & (
  | { type: ToolUIPart['type']; state: ToolUIPart['state']; toolName?: never }
  | { type: DynamicToolUIPart['type']; state: DynamicToolUIPart['state']; toolName: string }
);

const statusLabels: Record<ToolPart['state'], string> = {
  'approval-requested': 'Awaiting Approval',
  'approval-responded': 'Responded',
  'input-available': 'Running',
  'input-streaming': 'Pending',
  'output-available': 'Completed',
  'output-denied': 'Denied',
  'output-error': 'Error',
};

const statusIcons: Record<ToolPart['state'], ReactNode> = {
  'approval-requested': <ClockIcon className="size-4 text-warning" />,
  'approval-responded': <CheckCircleIcon className="size-4 text-info" />,
  'input-available': <ClockIcon className="size-4 animate-pulse" />,
  'input-streaming': <CircleIcon className="size-4" />,
  'output-available': <CheckCircleIcon className="size-4 text-success" />,
  'output-denied': <XCircleIcon className="size-4 text-warning" />,
  'output-error': <XCircleIcon className="size-4 text-destructive" />,
};

export const getStatusBadge = (status: ToolPart['state']) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({ className, title, preview, type, state, toolName, ...props }: ToolHeaderProps) => {
  const derivedName = type === 'dynamic-tool' ? toolName : type.split('-').slice(1).join('-');

  return (
    <CollapsibleTrigger className={cn('flex w-full min-w-0 items-center gap-4 p-3 text-left', className)} {...props}>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <WrenchIcon className="size-4 text-muted-foreground flex-shrink-0" />
        <span className="inline-flex items-center gap-1 min-w-0 text-sm">
          <span className="font-medium text-foreground">{title ?? derivedName}</span>
          {preview ? <span className="min-w-0 truncate text-muted-foreground">({preview})</span> : null}
        </span>
      </div>
      {getStatusBadge(state)}
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform flex-shrink-0 group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 min-w-0 max-w-full space-y-4 overflow-hidden p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolPart['input'];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const INLINE_STRING_MAX = 120;

/**
 * Render a single parameter value by type. Strings show bare (no JSON
 * quoting/escaping); long or multiline strings and nested objects fall
 * back to a scrollable pre block so one verbose argument (e.g. edit_file's
 * old_text) doesn't swallow the list.
 */
const renderParamValue = (value: unknown): ReactNode => {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return <span className="font-mono">{String(value)}</span>;
  }
  if (typeof value === 'string') {
    if (value.includes('\n') || value.length > INLINE_STRING_MAX) {
      return (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1 font-mono text-[11px]">
          {value}
        </pre>
      );
    }
    return <span className="break-words font-mono">{value}</span>;
  }
  // Arrays and nested objects — per-value JSON fallback
  let json: string;
  try {
    json = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    json = String(value);
  }
  return (
    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1 font-mono text-[11px]">
      {json}
    </pre>
  );
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const entries = isPlainObject(input) ? Object.entries(input) : null;
  return (
    <div className={cn('space-y-2 overflow-hidden', className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Parameters</h4>
      {entries && entries.length > 0 ? (
        <dl data-slot="tool-input-panel" className="space-y-1.5 rounded-md bg-muted/50 px-3 py-2">
          {entries.map(([key, value]) => (
            <div key={key} className="flex min-w-0 items-baseline gap-3">
              <dt className="w-32 flex-shrink-0 break-words text-xs text-muted-foreground">{key}</dt>
              <dd className="min-w-0 flex-1 text-xs">{renderParamValue(value)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        // Non-object payloads (arrays, primitives, empty objects) keep the raw JSON view
        <div data-slot="tool-input-panel" className="rounded-md bg-muted/50">
          <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
        </div>
      )}
    </div>
  );
};

export type ToolOutputProps = ComponentProps<'div'> & {
  output: ToolPart['output'];
  errorText: ToolPart['errorText'];
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === 'object' && !isValidElement(output)) {
    Output = <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />;
  } else if (typeof output === 'string') {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn('space-y-2', className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? 'Error' : 'Result'}
      </h4>
      <div
        data-slot="tool-output-panel"
        data-error={errorText ? 'true' : undefined}
        className={cn(
          'overflow-x-auto rounded-md text-xs [&_table]:w-full',
          errorText ? 'bg-destructive/10 text-destructive' : 'bg-muted/50 text-foreground'
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
