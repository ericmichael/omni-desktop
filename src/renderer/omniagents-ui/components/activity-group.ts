import { oneLine } from '@/lib/text';
import type {
  ChatMessage,
  GuardianReviewItem,
  MessageItem,
  ReasoningItem,
  ToolItem,
  WorkflowReviewItem,
} from '@/shared/chat-types';

/**
 * Transcript "machinery" — everything that folds into one chain-of-thought
 * block per run: reasoning, tool calls, the guardian/workflow review
 * records that annotate them, and PREAMBLE assistant messages (narration
 * between tool calls — semantically machinery, the prose twin of a
 * reasoning summary). A run's FINAL message is the answer and stays a
 * standalone bubble, as do user/system messages, approvals, plans, run
 * diffs, artifacts and structured cards — all of those break the group.
 */
export type MachineryItem = ToolItem | ReasoningItem | GuardianReviewItem | WorkflowReviewItem | ChatMessage;

export type ActivityGroupData = {
  type: 'activity_group';
  /** Turn/run id when known — machinery from two runs never shares a block. */
  runId?: string;
  items: MachineryItem[];
  isRunning: boolean;
};

export type DisplayItem = MessageItem | ActivityGroupData;

export type GroupSummary = {
  total: number;
  thoughts: number;
  reads: number;
  edits: number;
  commands: number;
  searches: number;
  other: number;
  errors: number;
  /** Guardian denials + workflow completion rejections — loud in the header. */
  rejections: number;
};

/**
 * A reasoning item with a terminal status and an empty summary carries no
 * information — it renders no step and never breaks a machinery run.
 * Streaming reasoning ("started") always renders, even before text arrives.
 */
export function isRenderableReasoning(item: ReasoningItem): boolean {
  return item.status === 'started' || item.summary.trim().length > 0;
}

/** The run id a transcript item belongs to, when it declares one. */
const itemRunId = (item: MessageItem): string | undefined => {
  if (item.type === 'tool') {
    return item.runId;
  }
  if (item.type === 'chat') {
    // Live-appended messages carry the machine's runId stamp; reloaded
    // canonical items carry turn_id. Same identity, two sources.
    return item.runId ?? item.canonical?.turn_id ?? undefined;
  }
  if (item.type === 'reasoning') {
    return item.canonical?.turn_id ?? undefined;
  }
  return undefined;
};

/**
 * An assistant message is a PREAMBLE — narration between tool calls — iff
 * more machinery from the SAME run follows it. The run's last message has
 * nothing after it and stays a standalone bubble (the answer). Detection
 * is structural (run ids), never a reading of the message's wording; a
 * message without a canonical turn id can't be placed and stays a bubble.
 */
function preambleIndices(items: MessageItem[]): Set<number> {
  // What counts as "the run continues after this message": later tools,
  // reasoning, or ANOTHER assistant message of the same run — a message
  // followed by more of the model's own output cannot be the answer. An
  // approval-gated tool records its item at EMISSION time and execution
  // only revises it in place, so narration around the approval has no
  // later tool row; the run's final message is what betrays it.
  // Deliberately NOT markers: approval and run_diff items — a run diff
  // can land after the true final answer, and counting it would fold the
  // answer itself into the chain.
  const lastMachineryIndexByRun = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.type === 'tool' || item.type === 'reasoning' || (item.type === 'chat' && item.role === 'assistant')) {
      const rid = itemRunId(item);
      if (rid) {
        lastMachineryIndexByRun.set(rid, i);
      }
    }
  }
  const preambles = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.type !== 'chat' || item.role !== 'assistant') {
      continue;
    }
    const rid = itemRunId(item);
    if (rid && (lastMachineryIndexByRun.get(rid) ?? -1) > i) {
      preambles.add(i);
    }
  }
  return preambles;
}

export function groupItems(items: MessageItem[], currentRunId: string | undefined, thinking: boolean): DisplayItem[] {
  const preambles = preambleIndices(items);
  const result: DisplayItem[] = [];
  let acc: MachineryItem[] = [];
  let accRunId: string | undefined = undefined;

  const flush = () => {
    if (acc.length === 0) {
      return;
    }
    result.push({
      type: 'activity_group',
      runId: accRunId,
      items: acc,
      isRunning: !!accRunId && accRunId === currentRunId && thinking,
    });
    acc = [];
    accRunId = undefined;
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.type === 'reasoning') {
      if (isRenderableReasoning(item)) {
        acc.push(item);
      }
      continue;
    }
    if (item.type === 'tool') {
      const rid = item.runId;
      if (rid && accRunId && rid !== accRunId) {
        // One chain block per run.
        flush();
      }
      acc.push(item);
      accRunId = accRunId ?? rid;
      continue;
    }
    if (item.type === 'guardian_review' || item.type === 'workflow_review') {
      acc.push(item);
      continue;
    }
    if (item.type === 'chat' && preambles.has(i)) {
      const rid = itemRunId(item);
      if (rid && accRunId && rid !== accRunId) {
        flush();
      }
      acc.push(item);
      accRunId = accRunId ?? rid;
      continue;
    }
    // Final answers, user/system chat, approvals, plans, run diffs,
    // artifacts, structured — standalone.
    flush();
    result.push(item);
  }
  flush();
  return result;
}

const READ_PATTERNS = /^(read|cat|get|fetch|load|view|show|list|ls|glob|grep|search_file|file_content)/i;
const EDIT_PATTERNS = /^(edit|write|update|set|create|delete|remove|patch|apply_patch|replace|mv|cp|rename)/i;
const COMMAND_PATTERNS = /^(bash|shell|exec|run|command|terminal|cmd|npm|pip|make)/i;
const SEARCH_PATTERNS = /^(search|find|grep|rg|ripgrep|glob|locate)/i;

export type ToolKind = 'reads' | 'edits' | 'commands' | 'searches' | 'other';

export function categorizeTool(toolName: string): ToolKind {
  if (SEARCH_PATTERNS.test(toolName)) {
    return 'searches';
  }
  if (READ_PATTERNS.test(toolName)) {
    return 'reads';
  }
  if (EDIT_PATTERNS.test(toolName)) {
    return 'edits';
  }
  if (COMMAND_PATTERNS.test(toolName)) {
    return 'commands';
  }
  return 'other';
}

export function computeGroupSummary(items: ReadonlyArray<MachineryItem>): GroupSummary {
  const s: GroupSummary = {
    total: items.length,
    thoughts: 0,
    reads: 0,
    edits: 0,
    commands: 0,
    searches: 0,
    other: 0,
    errors: 0,
    rejections: 0,
  };
  for (const item of items) {
    if (item.type === 'reasoning') {
      s.thoughts++;
    } else if (item.type === 'chat') {
      // Preamble narration counts toward the step total (it IS a step of
      // the run) but has no category of its own in the summary detail.
    } else if (item.type === 'guardian_review') {
      if (item.outcome === 'deny') {
        s.rejections++;
      }
    } else if (item.type === 'workflow_review') {
      if (item.outcome === 'reject') {
        s.rejections++;
      }
    } else {
      // MCP-derived tools categorize by their original name, not the
      // ``mcp_<server>__`` wire encoding (which would always bucket "other").
      s[categorizeTool(item.tool_label || item.tool)]++;
      if (item.metadata?.display_type === 'error') {
        s.errors++;
      }
    }
  }
  return s;
}

export function formatGroupSummary(s: GroupSummary): string {
  const steps = `${s.total} step${s.total === 1 ? '' : 's'}`;
  const head = s.thoughts ? `Thought · ${steps}` : steps;
  const detail: string[] = [];
  if (s.edits) {
    detail.push(`${s.edits} edit${s.edits === 1 ? '' : 's'}`);
  }
  if (s.reads) {
    detail.push(`${s.reads} read${s.reads === 1 ? '' : 's'}`);
  }
  if (s.commands) {
    detail.push(`${s.commands} command${s.commands === 1 ? '' : 's'}`);
  }
  if (s.searches) {
    detail.push(`${s.searches} search${s.searches === 1 ? '' : 'es'}`);
  }
  return detail.length ? `${head} — ${detail.join(', ')}` : head;
}

/** Destructive-tint header suffix — errors and rejected reviews stay loud. */
export function formatGroupFailures(s: GroupSummary): string | undefined {
  const parts: string[] = [];
  if (s.errors) {
    parts.push(`${s.errors} failed`);
  }
  if (s.rejections) {
    parts.push(`${s.rejections} rejected`);
  }
  return parts.length ? parts.join(' · ') : undefined;
}

/** The guardian chip's summary line, kept verbatim on the chain step. */
export function guardianReviewSummary(item: GuardianReviewItem): string {
  const reviewerLabel = item.reviewer === 'sandbox-policy' ? 'sandbox policy' : item.reviewer;
  const toolLabel = item.server_label ? `${item.server_label} · ${item.tool}` : item.tool;
  return item.outcome === 'deny'
    ? `${toolLabel} denied by ${reviewerLabel}`
    : `${toolLabel} approved by ${reviewerLabel}`;
}

/** The workflow chip's summary line, kept verbatim on the chain step. */
export function workflowReviewSummary(item: WorkflowReviewItem): string {
  const step = `step #${item.task_id} '${item.subject}'`;
  if (item.outcome === 'reject') {
    return `${step} — completion rejected`;
  }
  if (item.outcome === 'accept_verified') {
    return `${step} — completion verified`;
  }
  if (item.outcome === 'accept_unverified') {
    return `${step} — completion accepted (unverified)`;
  }
  return `${step} — completion contested — accepted after repeated disagreement`;
}

/** The file a tool touched, when its rich metadata names one — chip fodder. */
export function toolTouchedFile(item: ToolItem): string | undefined {
  const inner = item.metadata?.metadata;
  if (!inner || typeof inner !== 'object') {
    return undefined;
  }
  const filePath = (inner as Record<string, unknown>).file_path;
  if (typeof filePath === 'string' && filePath) {
    return filePath;
  }
  const path = (inner as Record<string, unknown>).path;
  return typeof path === 'string' && path ? path : undefined;
}

/**
 * Reasoning duration in whole seconds from the canonical envelope's
 * timestamps (epoch seconds; tolerate ms). Undefined when unknowable.
 */
export function reasoningDurationSeconds(item: ReasoningItem): number | undefined {
  const { created_at, updated_at } = item.canonical;
  if (!Number.isFinite(created_at) || !Number.isFinite(updated_at)) {
    return undefined;
  }
  let delta = updated_at - created_at;
  if (created_at > 1e12) {
    delta /= 1000;
  }
  if (delta <= 0) {
    return undefined;
  }
  return Math.max(1, Math.round(delta));
}

export function formatArgsPreview(args: string, maxLen: number) {
  if (!args) {
    return '';
  }
  let parsed: any;
  try {
    parsed = JSON.parse(args);
  } catch {}
  let text: string;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const parts: string[] = [];
    Object.entries(parsed).forEach(([k, v]) => {
      let vs: string;
      if (typeof v === 'string') {
        vs = `"${v}"`;
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        vs = String(v);
      } else {
        try {
          vs = JSON.stringify(v);
        } catch {
          vs = String(v);
        }
      }
      parts.push(`${k}: ${vs}`);
    });
    text = parts.join(', ');
  } else {
    text = oneLine(args);
  }
  if (text.length > maxLen) {
    return `${text.slice(0, maxLen - 3)}...`;
  }
  return text;
}
