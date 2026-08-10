import { describe, expect, it } from 'vitest';

import type {
  CanonicalItemEnvelope,
  GuardianReviewItem,
  MessageItem,
  ReasoningItem,
  ToolItem,
  WorkflowReviewItem,
} from '@/shared/chat-types';

import type { ActivityGroupData } from './activity-group';
import { computeGroupSummary, formatGroupFailures, formatGroupSummary, groupItems } from './activity-group';

function tool(name: string, extra: Partial<ToolItem> = {}): ToolItem {
  return { type: 'tool', tool: name, status: 'result', ...extra };
}

function envelope(id: string, extra: Partial<CanonicalItemEnvelope> = {}): CanonicalItemEnvelope {
  return {
    item_id: id,
    thread_id: 'thread-1',
    turn_id: null,
    seq: 0,
    kind: 'reasoning',
    status: 'completed',
    revision: 1,
    created_at: 0,
    updated_at: 0,
    content: {},
    source_ref: {},
    ...extra,
  };
}

function reasoning(id: string, summary: string, status: ReasoningItem['status'] = 'completed'): ReasoningItem {
  return { type: 'reasoning', summary, status, canonical: envelope(id) };
}

function guardian(outcome: GuardianReviewItem['outcome']): GuardianReviewItem {
  return { type: 'guardian_review', request_id: `req-${outcome}`, tool: 'bash', reviewer: 'guardian', outcome };
}

function workflow(outcome: WorkflowReviewItem['outcome']): WorkflowReviewItem {
  return { type: 'workflow_review', task_id: '1', subject: 'step', outcome, reviewer: 'guardian' };
}

const chat = (content: string): MessageItem => ({ type: 'chat', role: 'assistant', content });

describe('groupItems', () => {
  it('folds a contiguous machinery run — reasoning, tools, reviews — into one group, preserving order', () => {
    const items: MessageItem[] = [
      chat('before'),
      reasoning('r1', 'thinking'),
      tool('read_file', { runId: 'run-1' }),
      guardian('allow'),
      tool('write_file', { runId: 'run-1' }),
      workflow('accept_verified'),
      chat('after'),
    ];
    const grouped = groupItems(items, undefined, false);
    expect(grouped).toHaveLength(3);
    const group = grouped[1] as ActivityGroupData;
    expect(group.type).toBe('activity_group');
    expect(group.runId).toBe('run-1');
    expect(group.items.map((it) => it.type)).toEqual([
      'reasoning',
      'tool',
      'guardian_review',
      'tool',
      'workflow_review',
    ]);
  });

  it('renders singleton machinery as a one-step group and lets approvals break the run', () => {
    const items: MessageItem[] = [
      tool('read_file'),
      { type: 'approval', request_id: 'a1', tool: 'bash' },
      tool('bash'),
    ];
    const grouped = groupItems(items, undefined, false);
    expect(grouped.map((it) => it.type)).toEqual(['activity_group', 'approval', 'activity_group']);
    expect((grouped[0] as ActivityGroupData).items).toHaveLength(1);
    expect((grouped[0] as ActivityGroupData).runId).toBeUndefined();
  });

  it('splits groups when the runId changes — one timeline per run', () => {
    const grouped = groupItems([tool('a', { runId: 'run-1' }), tool('b', { runId: 'run-2' })], 'run-2', true);
    expect(grouped).toHaveLength(2);
    expect((grouped[0] as ActivityGroupData).isRunning).toBe(false);
    expect((grouped[1] as ActivityGroupData).isRunning).toBe(true);
  });

  it('drops terminal reasoning with an empty summary without breaking the run', () => {
    const grouped = groupItems(
      [tool('a', { runId: 'run-1' }), reasoning('r-empty', '  '), tool('b', { runId: 'run-1' })],
      undefined,
      false
    );
    expect(grouped).toHaveLength(1);
    expect((grouped[0] as ActivityGroupData).items.map((it) => it.type)).toEqual(['tool', 'tool']);
    // Streaming reasoning renders even before any text arrives.
    const streaming = groupItems([reasoning('r-live', '', 'started')], undefined, true);
    expect((streaming[0] as ActivityGroupData).items).toHaveLength(1);
  });
});

describe('computeGroupSummary', () => {
  it('categorizes MCP-derived tools by their original name, not the wire encoding', () => {
    const summary = computeGroupSummary([
      tool('mcp_omni-projects__list_tickets', { tool_label: 'list_tickets', server_label: 'omni-projects' }),
      tool('mcp_omni-projects__create_ticket', { tool_label: 'create_ticket', server_label: 'omni-projects' }),
      tool('read_file'),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.reads).toBe(2); // list_tickets + read_file
    expect(summary.edits).toBe(1); // create_ticket
    expect(summary.other).toBe(0); // nothing buckets on the mcp_ prefix
  });

  it('falls back to the wire name when no label is present', () => {
    const summary = computeGroupSummary([tool('mcp_srv__whatever')]);
    expect(summary.other).toBe(1);
  });

  it('counts thoughts, errors, and rejected reviews across mixed machinery', () => {
    const summary = computeGroupSummary([
      reasoning('r1', 'hm'),
      tool('edit_file'),
      tool('bash', { metadata: { display_type: 'error' } }),
      guardian('deny'),
      workflow('reject'),
      workflow('accept_verified'),
    ]);
    expect(summary.total).toBe(6);
    expect(summary.thoughts).toBe(1);
    expect(summary.edits).toBe(1);
    expect(summary.commands).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.rejections).toBe(2);
    expect(formatGroupSummary(summary)).toBe('Thought · 6 steps — 1 edit, 1 command');
    expect(formatGroupFailures(summary)).toBe('1 failed · 2 rejected');
  });

  it('keeps failures out of the plain summary line', () => {
    const clean = computeGroupSummary([tool('read_file')]);
    expect(formatGroupSummary(clean)).toBe('1 step — 1 read');
    expect(formatGroupFailures(clean)).toBeUndefined();
  });
});

describe('preamble folding', () => {
  const preamble = (id: string, content: string, turnId: string): MessageItem => ({
    type: 'chat',
    role: 'assistant',
    content,
    canonical: envelope(id, { kind: 'agent_message', turn_id: turnId }),
  });

  it('folds an assistant message into the chain when machinery of the same run follows', () => {
    const groups = groupItems(
      [
        tool('read_file', { runId: 'run-1' }),
        preamble('m1', 'Now let me check the config.', 'run-1'),
        tool('read_file', { runId: 'run-1', call_id: 'c2' }),
      ],
      undefined,
      false
    );
    expect(groups).toHaveLength(1);
    const group = groups[0] as ActivityGroupData;
    expect(group.items.map((i) => i.type)).toEqual(['tool', 'chat', 'tool']);
  });

  it("keeps the run's final message a standalone bubble", () => {
    const groups = groupItems(
      [tool('read_file', { runId: 'run-1' }), preamble('m1', 'Here is what I found: everything passes.', 'run-1')],
      undefined,
      false
    );
    expect(groups).toHaveLength(2);
    expect((groups[0] as ActivityGroupData).items.map((i) => i.type)).toEqual(['tool']);
    expect((groups[1] as MessageItem).type).toBe('chat');
  });

  it('an opening preamble (before the first tool) joins the run it narrates', () => {
    const groups = groupItems(
      [preamble('m1', "I'll start by reading the schema.", 'run-1'), tool('read_file', { runId: 'run-1' })],
      undefined,
      false
    );
    expect(groups).toHaveLength(1);
    expect((groups[0] as ActivityGroupData).items.map((i) => i.type)).toEqual(['chat', 'tool']);
  });

  it('folds a live-stamped preamble — machine runId, no canonical envelope', () => {
    // Live flushes stamp ChatMessage.runId (chat-session machine); the
    // canonical turn_id only exists after a reload. Same fold either way.
    const live: MessageItem = { type: 'chat', role: 'assistant', content: 'Checking the config next.', runId: 'run-1' };
    const final: MessageItem = { type: 'chat', role: 'assistant', content: 'All done.', runId: 'run-1' };
    const groups = groupItems(
      [tool('read_file', { runId: 'run-1' }), live, tool('read_file', { runId: 'run-1', call_id: 'c2' }), final],
      undefined,
      false
    );
    expect(groups).toHaveLength(2);
    expect((groups[0] as ActivityGroupData).items.map((i) => i.type)).toEqual(['tool', 'chat', 'tool']);
    // The run's final message keeps its bubble even with the stamp.
    expect((groups[1] as MessageItem).type).toBe('chat');
  });

  it('a message without a canonical turn id stays a bubble — it cannot be placed', () => {
    const groups = groupItems(
      [tool('read_file', { runId: 'run-1' }), chat('untethered'), tool('read_file', { runId: 'run-1', call_id: 'c2' })],
      undefined,
      false
    );
    expect(groups).toHaveLength(3);
    expect((groups[1] as MessageItem).type).toBe('chat');
  });

  it("a message from a DIFFERENT run never folds into this run's chain", () => {
    const groups = groupItems(
      [
        tool('read_file', { runId: 'run-1' }),
        preamble('m1', 'narration for run 2', 'run-2'),
        tool('read_file', { runId: 'run-2', call_id: 'c2' }),
      ],
      undefined,
      false
    );
    // The run-2 preamble breaks run-1's group and starts run-2's.
    expect(groups).toHaveLength(2);
    expect((groups[0] as ActivityGroupData).items.map((i) => i.type)).toEqual(['tool']);
    expect((groups[1] as ActivityGroupData).items.map((i) => i.type)).toEqual(['chat', 'tool']);
  });

  it('user messages always break the group, canonical or not', () => {
    const userMsg: MessageItem = {
      type: 'chat',
      role: 'user',
      content: 'stop',
      canonical: envelope('u1', { kind: 'user_message', turn_id: 'run-1' }),
    };
    const groups = groupItems(
      [tool('read_file', { runId: 'run-1' }), userMsg, tool('read_file', { runId: 'run-1', call_id: 'c2' })],
      undefined,
      false
    );
    expect(groups).toHaveLength(3);
  });
});

describe('preamble folding around approval-gated tools (session 39a9b6a8 shape)', () => {
  const preamble = (id: string, content: string, turnId: string): MessageItem => ({
    type: 'chat',
    role: 'assistant',
    content,
    canonical: envelope(id, { kind: 'agent_message', turn_id: turnId }),
  });

  it('narration before an approval resolution folds — a later same-run message betrays it', () => {
    // Approval-gated tools record their item at EMISSION time; execution
    // revises it in place. So the narration has no later tool row — only
    // the approval record, the run diff, and the final answer follow.
    const approvalHistory: MessageItem = {
      type: 'structured',
      kind: 'approval',
      title: 'Approval',
      canonical: envelope('a1', { kind: 'approval', turn_id: 'run-1' }),
    };
    const runDiff: MessageItem = {
      type: 'run_diff',
      id: 'd1',
      diff: 'diff --git a b',
      files: [],
      stats: { filesChanged: 1, additions: 1, deletions: 0 },
      truncated: false,
      filesTruncated: false,
      status: 'completed',
      canonical: envelope('d1', { kind: 'run_diff', turn_id: 'run-1' }),
    } as MessageItem;
    const groups = groupItems(
      [
        tool('apply_patch', { runId: 'run-1' }),
        reasoning('r1', 'planning the file'),
        preamble('m1', "The workspace is empty, so I'm adding index.html.", 'run-1'),
        approvalHistory,
        runDiff,
        preamble('m2', 'Created the page at index.html.', 'run-1'),
      ],
      undefined,
      false
    );
    // ONE chain (tool, reasoning, folded narration), then the approval and
    // diff cards, then ONE final bubble — never two bubbles at the end.
    expect(groups).toHaveLength(4);
    expect((groups[0] as ActivityGroupData).items.map((i) => i.type)).toEqual(['tool', 'reasoning', 'chat']);
    expect((groups[1] as MessageItem).type).toBe('structured');
    expect((groups[2] as MessageItem).type).toBe('run_diff');
    expect((groups[3] as MessageItem).type).toBe('chat');
  });

  it('a run_diff AFTER the final answer never folds the answer into the chain', () => {
    const runDiff: MessageItem = {
      type: 'run_diff',
      id: 'd1',
      diff: 'diff --git a b',
      files: [],
      stats: { filesChanged: 1, additions: 1, deletions: 0 },
      truncated: false,
      filesTruncated: false,
      status: 'completed',
      canonical: envelope('d1', { kind: 'run_diff', turn_id: 'run-1' }),
    } as MessageItem;
    const groups = groupItems(
      [tool('apply_patch', { runId: 'run-1' }), preamble('m1', 'Done — created the page.', 'run-1'), runDiff],
      undefined,
      false
    );
    expect(groups).toHaveLength(3);
    expect((groups[1] as MessageItem).type).toBe('chat');
  });
});
