import { rehydrateHistory } from '@/lib/rehydrate-history';
import type {
  ArtifactMcpUi,
  CanonicalItemEnvelope,
  ChatItemMetadata,
  MessageItem,
  PlanStep,
  RunDiffFile,
} from '@/shared/chat-types';
import { OmniagentsRpcError } from '@/shared/omniagents-rpc';

import {
  ConversationClient,
  type ConversationItem,
  ConversationProtocolError,
  type ConversationRpcTransport,
} from './conversation';

const PAGE_SIZE = 500;
const MAX_PAGES = 10_000;

export interface CanonicalHistoryTransport extends ConversationRpcTransport {
  getSessionHistory(sessionId: string): Promise<unknown[]>;
}

export type SessionTranscriptLoad = {
  items: MessageItem[];
  source: 'canonical' | 'legacy';
  rawItemCount: number;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function planStepStatus(value: unknown): PlanStep['status'] {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'blocked'
    ? value
    : undefined;
}

function runDiffChangeType(value: unknown): RunDiffFile['changeType'] | undefined {
  return value === 'added' || value === 'modified' || value === 'deleted' ? value : undefined;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function envelope(item: ConversationItem): CanonicalItemEnvelope {
  return {
    item_id: item.item_id,
    thread_id: item.thread_id,
    turn_id: item.turn_id,
    seq: item.seq,
    kind: item.kind,
    status: item.status,
    revision: item.revision,
    created_at: item.created_at,
    updated_at: item.updated_at,
    content: item.content,
    source_ref: item.source_ref,
  };
}

function role(value: string | null, fallback: 'user' | 'assistant'): 'user' | 'assistant' | 'system' {
  return value === 'user' || value === 'assistant' || value === 'system' ? value : fallback;
}

function structured(item: ConversationItem, title: string, summary?: string): MessageItem {
  return {
    type: 'structured',
    kind: item.kind,
    title,
    ...(summary ? { summary } : {}),
    canonical: envelope(item),
  };
}

function metadata(content: Record<string, unknown>): ChatItemMetadata | undefined {
  const candidate = content.ui_metadata ?? content.metadata;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as ChatItemMetadata)
    : undefined;
}

function mcpUi(content: Record<string, unknown>): ArtifactMcpUi | undefined {
  const candidate = content.mcp_ui;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as ArtifactMcpUi)
    : undefined;
}

/** Convert one canonical conversation item without discarding its wire data. */
export function adaptCanonicalConversationItem(item: ConversationItem): MessageItem {
  const content = item.content;
  const canonical = envelope(item);

  switch (item.kind) {
    case 'user_message':
      return {
        type: 'chat',
        role: role(item.role, 'user'),
        content: stringValue(content.text) ?? '',
        canonical,
      };
    case 'agent_message':
      return {
        type: 'chat',
        role: role(item.role, 'assistant'),
        content: stringValue(content.text) ?? '',
        canonical,
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        summary: stringValue(content.summary) ?? '',
        status: item.status,
        canonical,
      };
    case 'tool_call': {
      const serverLabel = stringValue(content.server_label);
      const toolName = stringValue(content.tool) ?? '';
      return {
        type: 'tool',
        tool: toolName,
        call_id: stringValue(content.call_id) ?? stringValue(item.source_ref.call_id),
        input: stringify(content.input ?? content.arguments),
        output: stringify(content.output),
        status: content.output !== undefined || item.status !== 'started' ? 'result' : 'called',
        metadata: metadata(content),
        server_label: serverLabel,
        tool_label: stringValue(content.tool_label) ?? (serverLabel ? toolName : undefined),
        runId: item.turn_id ?? undefined,
        canonical,
      };
    }
    case 'approval': {
      const approvalKind = content.approval_kind === 'mcp' ? 'mcp' : 'function';
      const requestId = stringValue(content.request_id) ?? stringValue(content.call_id);
      // The existing ApprovalItem is deliberately pending-only. Resolved
      // approvals remain visible as structured history instead of re-opening
      // an actionable approval card.
      if (item.status !== 'started' || !requestId) {
        return structured(item, 'Approval', stringify(content.decision ?? content.reason));
      }
      return {
        type: 'approval',
        request_id: requestId,
        tool: stringValue(content.tool) ?? '',
        argumentsText: stringify(content.arguments),
        kind: approvalKind,
        server_label: stringValue(content.server_label),
        tool_label: stringValue(content.tool_label),
        session_id: item.thread_id,
        canonical,
      };
    }
    case 'artifact':
      return {
        type: 'artifact',
        artifact_id: stringValue(content.artifact_id) ?? item.item_id,
        title: stringValue(content.title) ?? 'Artifact',
        content: stringify(content.content) ?? '',
        mode: stringValue(content.mode),
        session_id: item.thread_id,
        updated_at: item.updated_at,
        mcp_ui: mcpUi(content),
        canonical,
      };
    case 'plan': {
      const rawSteps = Array.isArray(content.steps) ? content.steps : [];
      const steps = rawSteps.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return [];
        }
        const step = entry as Record<string, unknown>;
        const title = stringValue(step.subject) ?? stringValue(step.title);
        return title
          ? [
              {
                title,
                description: stringValue(step.description),
                id: stringValue(step.id),
                activeForm: stringValue(step.active_form),
                status: planStepStatus(step.status),
                owner: stringValue(step.owner),
                blockedBy: Array.isArray(step.blocked_by)
                  ? step.blocked_by.filter((value): value is string => typeof value === 'string')
                  : undefined,
              },
            ]
          : [];
      });
      return {
        type: 'plan',
        id: stringValue(content.plan_id) ?? item.item_id,
        title:
          stringValue(content.title) ??
          (stringValue(content.scope) === 'main' ? 'Plan' : `Plan: ${String(content.scope ?? 'main')}`),
        description: stringValue(content.description),
        steps,
        scope: stringValue(content.scope),
        status: item.status,
        canonical,
      };
    }
    case 'run_diff': {
      const rawFiles = Array.isArray(content.files) ? content.files : [];
      const files = rawFiles.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return [];
        }
        const file = entry as Record<string, unknown>;
        const path = stringValue(file.path);
        const changeType = runDiffChangeType(file.change_type);
        if (!path || !changeType) {
          return [];
        }
        return [
          {
            path,
            changeType,
            additions: typeof file.additions === 'number' ? file.additions : 0,
            deletions: typeof file.deletions === 'number' ? file.deletions : 0,
            opaque: file.opaque === true,
            baselineUnknown: file.baseline_unknown === true,
          },
        ];
      });
      const stats =
        content.stats && typeof content.stats === 'object' && !Array.isArray(content.stats)
          ? (content.stats as Record<string, unknown>)
          : {};
      return {
        type: 'run_diff',
        id: stringValue(content.run_id) ?? item.turn_id ?? item.item_id,
        diff: stringValue(content.diff) ?? '',
        files,
        stats: {
          filesChanged: typeof stats.files_changed === 'number' ? stats.files_changed : files.length,
          additions: typeof stats.additions === 'number' ? stats.additions : 0,
          deletions: typeof stats.deletions === 'number' ? stats.deletions : 0,
        },
        truncated: content.truncated === true,
        filesTruncated: content.files_truncated === true,
        status: item.status,
        canonical,
      };
    }
    case 'compaction':
      return structured(item, 'Context compacted', stringValue(content.summary));
    case 'elicitation':
      return structured(
        item,
        stringValue(content.title) ?? 'User input request',
        stringValue(content.message) ?? stringValue(content.status) ?? stringValue(content.action)
      );
    default:
      return structured(item, `Conversation item: ${item.kind}`);
  }
}

/**
 * Merge page overlaps by canonical identity. The highest revision wins and
 * thread-monotonic `seq` is the sole display order. A sequence collision
 * between different identities is a protocol error, not something to hide.
 */
export function mergeCanonicalConversationItems(pages: readonly (readonly ConversationItem[])[]): ConversationItem[] {
  const byId = new Map<string, ConversationItem>();
  for (const page of pages) {
    for (const item of page) {
      const previous = byId.get(item.item_id);
      if (
        !previous ||
        item.revision > previous.revision ||
        (item.revision === previous.revision && item.updated_at > previous.updated_at)
      ) {
        byId.set(item.item_id, item);
      }
    }
  }
  const merged = [...byId.values()].sort(
    (left, right) => left.seq - right.seq || left.item_id.localeCompare(right.item_id)
  );
  for (let index = 1; index < merged.length; index += 1) {
    if (merged[index - 1]!.seq === merged[index]!.seq) {
      throw new ConversationProtocolError(
        `list_items returned duplicate seq ${merged[index]!.seq} for different canonical item ids`
      );
    }
  }
  return merged;
}

export async function listAllCanonicalConversationItems(
  transport: ConversationRpcTransport,
  threadId: string
): Promise<ConversationItem[]> {
  const client = new ConversationClient(transport);
  const pages: ConversationItem[][] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = await client.listItems(threadId, { limit: PAGE_SIZE, order: 'asc', ...(cursor ? { cursor } : {}) });
    pages.push(page.items);
    if (!page.has_more) {
      return mergeCanonicalConversationItems(pages);
    }
    if (!page.next_cursor || seenCursors.has(page.next_cursor)) {
      throw new ConversationProtocolError('list_items pagination cursor did not advance');
    }
    seenCursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }
  throw new ConversationProtocolError(`list_items exceeded ${MAX_PAGES} pages`);
}

export function isCanonicalConversationUnsupported(error: unknown): boolean {
  if (!(error instanceof OmniagentsRpcError)) {
    return false;
  }
  if (error.code === -32601) {
    return true;
  }
  if (error.code !== -32013 || !error.data || typeof error.data !== 'object') {
    return false;
  }
  const data = error.data as Record<string, unknown>;
  return data.kind === 'capability_not_negotiated' || data.kind === 'operation_unsupported';
}

/**
 * Launcher-created sessions have an identity before their first message. The
 * runtime can therefore have a live Session while the conversation recorder
 * has not created its canonical Thread yet. That precise not-found is an
 * authoritative empty transcript, not a boot failure.
 */
function isUnrecordedCanonicalThread(error: unknown): boolean {
  if (!(error instanceof OmniagentsRpcError) || error.code !== -32080) {
    return false;
  }
  if (!error.data || typeof error.data !== 'object') {
    return false;
  }
  return (error.data as Record<string, unknown>).kind === 'thread_not_found';
}

/** Canonical items are authoritative; legacy history is old-runtime fallback only. */
export async function loadSessionTranscript(
  transport: CanonicalHistoryTransport,
  sessionId: string
): Promise<SessionTranscriptLoad> {
  try {
    const canonical = await listAllCanonicalConversationItems(transport, sessionId);
    return {
      items: canonical.map(adaptCanonicalConversationItem),
      source: 'canonical',
      rawItemCount: canonical.length,
    };
  } catch (error) {
    if (isUnrecordedCanonicalThread(error)) {
      return { items: [], source: 'canonical', rawItemCount: 0 };
    }
    if (!isCanonicalConversationUnsupported(error)) {
      throw error;
    }
    const raw = await transport.getSessionHistory(sessionId);
    return {
      items: rehydrateHistory(raw as Record<string, unknown>[]) as MessageItem[],
      source: 'legacy',
      rawItemCount: raw.length,
    };
  }
}
