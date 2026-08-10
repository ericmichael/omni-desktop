import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import type { LucideIcon } from 'lucide-react';
import {
  ActivityIcon,
  BrainIcon,
  CircleAlertIcon,
  CircleXIcon,
  FilePenLineIcon,
  FileTextIcon,
  MessageSquareTextIcon,
  SearchIcon,
  ShieldCheckIcon,
  ShieldQuestionIcon,
  ShieldXIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';

import type { ChatMessage, GuardianReviewItem, ReasoningItem, ToolItem, WorkflowReviewItem } from '@/shared/chat-types';

import type { ActivityGroupData, ToolKind } from './activity-group';
import {
  categorizeTool,
  computeGroupSummary,
  formatArgsPreview,
  formatGroupFailures,
  formatGroupSummary,
  guardianReviewSummary,
  reasoningDurationSeconds,
  toolTouchedFile,
  workflowReviewSummary,
} from './activity-group';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from './ai/chain-of-thought';

/**
 * One machinery run — reasoning, tool calls, guardian/workflow reviews —
 * rendered as a single compact chain-of-thought timeline. Replaces the old
 * per-item rendering (Reasoning collapsible, ActivityGroup slab, review
 * chips) with one block per run.
 *
 * Lifecycle mirrors ``ai/reasoning.tsx``: auto-open while the run streams,
 * auto-close shortly after it finishes. A manual toggle wins permanently,
 * and a run containing an error or a rejected review never auto-collapses.
 */

const AUTO_CLOSE_DELAY = 1000;

const streamdownPlugins = { cjk, code, math, mermaid };

const TOOL_KIND_ICONS: Record<ToolKind, LucideIcon> = {
  reads: FileTextIcon,
  edits: FilePenLineIcon,
  commands: SquareTerminalIcon,
  searches: SearchIcon,
  other: WrenchIcon,
};

type ActivityChainProps = {
  group: ActivityGroupData;
  statusText?: string;
  renderTool: (item: ToolItem) => React.ReactNode;
  /**
   * Pending approval request ids. For function-tool approvals the id IS the
   * tool call_id, so an in-flight tool step with a pending approval renders
   * as "awaiting approval" (nothing is running — the run is waiting on the
   * user) instead of the tool's running phrasing.
   */
  pendingApprovalIds?: ReadonlySet<string>;
};

const isAwaitingApproval = (item: ToolItem, pending?: ReadonlySet<string>): boolean =>
  !!pending && item.status !== 'result' && !!item.call_id && pending.has(item.call_id);

export function ActivityChain({ group, statusText, renderTool, pendingApprovalIds }: ActivityChainProps) {
  const summary = useMemo(() => computeGroupSummary(group.items), [group.items]);
  const failures = formatGroupFailures(summary);

  const [isOpen, setIsOpen] = useState(group.isRunning);
  const userToggledRef = useRef(false);
  const hasEverRunRef = useRef(group.isRunning);
  const [hasAutoClosed, setHasAutoClosed] = useState(false);

  useEffect(() => {
    if (group.isRunning) {
      hasEverRunRef.current = true;
      if (!userToggledRef.current) {
        setIsOpen(true);
      }
    }
  }, [group.isRunning]);

  useEffect(() => {
    if (!group.isRunning && hasEverRunRef.current && isOpen && !hasAutoClosed && !userToggledRef.current && !failures) {
      const timer = setTimeout(() => {
        setIsOpen(false);
        setHasAutoClosed(true);
      }, AUTO_CLOSE_DELAY);
      return () => clearTimeout(timer);
    }
  }, [group.isRunning, isOpen, hasAutoClosed, failures]);

  const handleOpenChange = useCallback((open: boolean) => {
    userToggledRef.current = true;
    setIsOpen(open);
  }, []);

  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(new Set());
  const toggleTool = useCallback((key: string) => {
    setOpenTools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const latestTool = useMemo(() => {
    for (let i = group.items.length - 1; i >= 0; i--) {
      const item = group.items[i];
      if (item && item.type === 'tool') {
        return item;
      }
    }
    return undefined;
  }, [group.items]);

  const awaitingApproval = useMemo(
    () => group.items.some((item) => item.type === 'tool' && isAwaitingApproval(item, pendingApprovalIds)),
    [group.items, pendingApprovalIds]
  );

  let liveLabel = statusText || '';
  if (!liveLabel && latestTool) {
    const preview = formatArgsPreview(latestTool.input || '', 60);
    const name = latestTool.tool_label || latestTool.tool;
    liveLabel = preview ? `${name} (${preview})` : name;
  }
  if (!liveLabel) {
    liveLabel = 'Working…';
  }

  return (
    <ChainOfThought
      open={isOpen}
      onOpenChange={handleOpenChange}
      data-testid="activity-chain"
      className="space-y-2 max-w-full"
    >
      <ChainOfThoughtHeader icon={summary.thoughts > 0 ? BrainIcon : ActivityIcon}>
        {group.isRunning ? (
          <span className="flex min-w-0 items-center gap-2">
            {awaitingApproval ? (
              // Static, no shimmer: nothing is running — the run is waiting
              // on the user's approval decision.
              <span className="min-w-0 truncate">Awaiting approval…</span>
            ) : (
              // The self-animating .text-shimmer CSS class, applied directly.
              // Never route it through the motion Shimmer / cn(): tailwind-merge
              // classifies `text-shimmer` as a text-color utility, so the
              // component's own `text-transparent` deletes it and the label
              // paints invisibly (transparent text, no gradient to clip).
              <span className="text-shimmer min-w-0 truncate">{liveLabel}</span>
            )}
            <span className="shrink-0 text-xs tabular-nums">{group.items.length}</span>
          </span>
        ) : (
          <span className="block min-w-0 truncate">
            {formatGroupSummary(summary)}
            {failures ? <span className="text-destructive"> · {failures}</span> : null}
          </span>
        )}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {group.items.map((item, i) => {
          if (item.type === 'reasoning') {
            return <ReasoningStep key={item.canonical.item_id} item={item} />;
          }
          if (item.type === 'chat') {
            return <MessageStep key={item.canonical?.item_id ?? `chat-${i}`} item={item} />;
          }
          if (item.type === 'guardian_review') {
            return <GuardianReviewStep key={`${item.request_id}-review`} item={item} />;
          }
          if (item.type === 'workflow_review') {
            return <WorkflowReviewStep key={`${item.task_id}-${item.outcome}-${i}`} item={item} />;
          }
          const key = item.call_id || `tool-${i}`;
          return (
            <ToolStep
              key={key}
              item={item}
              awaitingApproval={isAwaitingApproval(item, pendingApprovalIds)}
              expanded={openTools.has(key)}
              stepKey={key}
              onToggle={toggleTool}
            >
              {openTools.has(key) ? renderTool(item) : null}
            </ToolStep>
          );
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

function ReasoningStep({ item }: { item: ReasoningItem }) {
  const active = item.status === 'started';
  const summary = item.summary.trim();
  const duration = reasoningDurationSeconds(item);
  return (
    <ChainOfThoughtStep
      icon={BrainIcon}
      status={active ? 'active' : 'complete'}
      data-testid="reasoning-step"
      label={
        active ? (
          <span className="text-shimmer">Thinking…</span>
        ) : duration !== undefined ? (
          `Thought for ${duration}s`
        ) : (
          'Thought for a few seconds'
        )
      }
    >
      {summary ? (
        <div className="min-w-0 max-w-full overflow-hidden text-sm text-muted-foreground">
          <Streamdown plugins={streamdownPlugins}>{summary}</Streamdown>
        </div>
      ) : null}
    </ChainOfThoughtStep>
  );
}

/**
 * A preamble message — the model narrating between tool calls. Rendered in
 * the chain's quiet register: the first line as the step label, the full
 * markdown as the body only when truncation would lose content. The run's
 * final message never lands here (grouping keeps it a standalone bubble).
 */
function MessageStep({ item }: { item: ChatMessage }) {
  const text = item.content.trim();
  const newline = text.indexOf('\n');
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  const clipped = newline !== -1 || firstLine.length > 120;
  return (
    <ChainOfThoughtStep
      icon={MessageSquareTextIcon}
      status="complete"
      data-testid="message-step"
      label={
        <span className="block min-w-0 truncate" title={clipped ? undefined : firstLine}>
          {firstLine}
        </span>
      }
    >
      {clipped ? (
        <div className="min-w-0 max-w-full overflow-hidden text-sm text-muted-foreground">
          <Streamdown plugins={streamdownPlugins}>{text}</Streamdown>
        </div>
      ) : null}
    </ChainOfThoughtStep>
  );
}

function ToolStep({
  item,
  awaitingApproval,
  expanded,
  stepKey,
  onToggle,
  children,
}: {
  item: ToolItem;
  awaitingApproval?: boolean;
  expanded: boolean;
  stepKey: string;
  onToggle: (key: string) => void;
  children?: React.ReactNode;
}) {
  const failed = item.metadata?.display_type === 'error';
  const active = !failed && !awaitingApproval && item.status !== 'result';
  const icon = failed
    ? CircleXIcon
    : awaitingApproval
      ? ShieldQuestionIcon
      : TOOL_KIND_ICONS[categorizeTool(item.tool_label || item.tool)];
  const metaSummary = typeof item.metadata?.summary === 'string' ? item.metadata.summary.trim() : '';
  const name = item.tool_label || item.tool;
  // The running summary ("Running shell command...") would be a lie while
  // the call waits on the user — name the wait and the tool instead.
  const preview = metaSummary && !awaitingApproval ? '' : formatArgsPreview(item.input || '', 60);
  const labelText = awaitingApproval
    ? `Awaiting approval — ${name}${preview ? ` (${preview})` : ''}`
    : metaSummary || (preview ? `${name} (${preview})` : name);
  const file = toolTouchedFile(item);
  const handleToggle = useCallback(() => onToggle(stepKey), [onToggle, stepKey]);
  return (
    <ChainOfThoughtStep
      icon={icon}
      iconClassName={failed ? 'text-destructive' : undefined}
      status={active ? 'active' : awaitingApproval ? 'pending' : 'complete'}
      className={failed ? 'text-destructive' : undefined}
      data-testid="tool-step"
      label={
        <button
          type="button"
          data-testid="tool-step-toggle"
          onClick={handleToggle}
          aria-expanded={expanded}
          title={labelText}
          className="block w-full min-w-0 truncate text-left hover:text-foreground"
        >
          {active ? <span className="text-shimmer">{labelText}</span> : labelText}
        </button>
      }
    >
      {file ? (
        <ChainOfThoughtSearchResults>
          <ChainOfThoughtSearchResult className="max-w-full truncate font-mono">{file}</ChainOfThoughtSearchResult>
        </ChainOfThoughtSearchResults>
      ) : null}
      {children}
    </ChainOfThoughtStep>
  );
}

function GuardianReviewStep({ item }: { item: GuardianReviewItem }) {
  const denied = item.outcome === 'deny';
  return (
    <ChainOfThoughtStep
      icon={denied ? ShieldXIcon : ShieldCheckIcon}
      iconClassName={denied ? 'text-destructive' : 'text-primary/70'}
      data-testid="guardian-review-step"
      label={
        <span className="block min-w-0 truncate" title={item.rationale || undefined}>
          {guardianReviewSummary(item)}
          {item.risk_level ? <span className="opacity-70"> ({item.risk_level} risk)</span> : null}
        </span>
      }
      description={item.rationale || undefined}
    />
  );
}

function WorkflowReviewStep({ item }: { item: WorkflowReviewItem }) {
  const rejected = item.outcome === 'reject';
  const verified = item.outcome === 'accept_verified';
  // Unverified and escalated are trust signals, not errors — amber/muted,
  // never destructive; only the rejection icon carries a destructive tint.
  const icon = rejected ? ShieldXIcon : verified ? ShieldCheckIcon : CircleAlertIcon;
  const tint = rejected
    ? 'text-destructive'
    : verified
      ? 'text-primary/70'
      : item.outcome === 'accept_unverified'
        ? 'text-warning/80'
        : 'text-muted-foreground';
  return (
    <ChainOfThoughtStep
      icon={icon}
      iconClassName={tint}
      data-testid="workflow-review-step"
      label={
        <span className="block min-w-0 truncate" title={item.rationale || undefined}>
          {workflowReviewSummary(item)}
        </span>
      }
      description={item.rationale || undefined}
    />
  );
}
