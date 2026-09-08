import { describe, expect, it, vi } from 'vitest';

import { OmniagentsRpcError } from '@/shared/omniagents-rpc';

import {
  adaptCanonicalConversationItem,
  listAllCanonicalConversationItems,
  loadSessionTranscript,
  mergeCanonicalConversationItems,
} from './canonical-chat-history';
import type { ConversationItem, ConversationRpcTransport } from './conversation';

const item = (overrides: Partial<ConversationItem> = {}): ConversationItem => ({
  item_id: 'itm_1',
  thread_id: 'thread-1',
  turn_id: 'run-1',
  seq: 1,
  kind: 'agent_message',
  status: 'completed',
  role: 'assistant',
  created_at: 1,
  updated_at: 2,
  completed_at: 2,
  revision: 0,
  content: { text: 'hello' },
  source_ref: { event: 'message_output' },
  long_lived: false,
  source: 'recorder',
  schema_version: 1,
  ...overrides,
});

const page = (items: ConversationItem[], nextCursor: string | null, total = items.length) => ({
  thread_id: 'thread-1',
  turn_id: null,
  items,
  next_cursor: nextCursor,
  has_more: nextCursor !== null,
  total,
});

describe('canonical conversation item adapters', () => {
  it('adapts messages and retains canonical identity and content', () => {
    const adapted = adaptCanonicalConversationItem(item());
    expect(adapted).toMatchObject({
      type: 'chat',
      role: 'assistant',
      content: 'hello',
      canonical: { item_id: 'itm_1', seq: 1, revision: 0, content: { text: 'hello' } },
    });
  });

  it('preserves MCP tool structure', () => {
    const adapted = adaptCanonicalConversationItem(
      item({
        kind: 'tool_call',
        status: 'completed',
        content: {
          tool: 'search',
          tool_kind: 'mcp',
          call_id: 'call-1',
          server_label: 'github',
          input: { q: 'omni' },
          output: { hits: 2 },
          ui_metadata: { display_type: 'table', metadata: { columns: ['name'] } },
        },
      })
    );
    expect(adapted).toMatchObject({
      type: 'tool',
      tool: 'search',
      call_id: 'call-1',
      server_label: 'github',
      tool_label: 'search',
      input: '{"q":"omni"}',
      output: '{"hits":2}',
      status: 'result',
      metadata: { display_type: 'table' },
    });
  });

  it('uses dedicated reasoning, plan, artifact, and pending approval rows', () => {
    expect(
      adaptCanonicalConversationItem(item({ kind: 'reasoning', content: { summary: 'considered options' } }))
    ).toMatchObject({ type: 'reasoning', summary: 'considered options' });
    expect(
      adaptCanonicalConversationItem(
        item({
          kind: 'plan',
          status: 'started',
          content: {
            plan_id: 'plan-1',
            scope: 'main',
            steps: [
              {
                id: 'step-1',
                subject: 'Build it',
                description: 'carefully',
                active_form: 'Building it',
                status: 'in_progress',
                owner: 'agent',
                blocked_by: [],
              },
              {
                id: 'step-2',
                subject: 'Verify it',
                status: 'completed',
                exit_criteria: 'tests pass',
                review: { outcome: 'unverified' },
                criteria_edited: true,
                original_exit_criteria: 'all tests pass',
              },
              {
                id: 'step-3',
                subject: 'Stamp only',
                status: 'in_progress',
                original_exit_criteria: 'stricter bar',
              },
            ],
          },
        })
      )
    ).toMatchObject({
      type: 'plan',
      id: 'plan-1',
      title: 'Plan',
      steps: [
        {
          id: 'step-1',
          title: 'Build it',
          description: 'carefully',
          activeForm: 'Building it',
          status: 'in_progress',
          owner: 'agent',
          blockedBy: [],
          criteriaEdited: undefined,
        },
        {
          id: 'step-2',
          title: 'Verify it',
          status: 'completed',
          exitCriteria: 'tests pass',
          verified: false,
          criteriaEdited: true,
        },
        // The stamp alone implies an edit even when the flag is missing.
        { id: 'step-3', title: 'Stamp only', criteriaEdited: true },
      ],
    });
    expect(
      adaptCanonicalConversationItem(
        item({
          kind: 'artifact',
          content: { artifact_id: 'a1', title: 'Report', content: '# Report', mode: 'markdown' },
        })
      )
    ).toMatchObject({ type: 'artifact', artifact_id: 'a1', title: 'Report', content: '# Report' });
    expect(
      adaptCanonicalConversationItem(
        item({
          kind: 'approval',
          status: 'started',
          content: { approval_kind: 'mcp', request_id: 'req-1', tool: 'publish', server_label: 'github' },
        })
      )
    ).toMatchObject({ type: 'approval', request_id: 'req-1', kind: 'mcp', server_label: 'github' });
  });

  it('maps reviewer-resolved approvals to guardian review steps', () => {
    const reviewed = adaptCanonicalConversationItem(
      item({
        kind: 'approval',
        content: {
          approval_kind: 'function',
          call_id: 'call-1',
          tool: 'bash',
          reviewer: 'guardian',
          outcome: 'allow',
          rationale: 'read-only command',
          risk_level: 'low',
          decision: 'approve',
        },
      })
    );
    expect(reviewed).toMatchObject({
      type: 'guardian_review',
      request_id: 'call-1',
      tool: 'bash',
      reviewer: 'guardian',
      outcome: 'allow',
      rationale: 'read-only command',
      risk_level: 'low',
      kind: 'tool',
      session_id: 'thread-1',
      canonical: { kind: 'approval' },
    });
    // A reviewer verdict outside allow/deny is not a guardian step.
    const unknownOutcome = adaptCanonicalConversationItem(
      item({ kind: 'approval', content: { call_id: 'call-1', tool: 'bash', reviewer: 'guardian', outcome: 'shrug' } })
    );
    expect(unknownOutcome).toMatchObject({ type: 'structured', kind: 'approval' });
  });

  it('folds human-decided approvals into the chain as a review by you', () => {
    const approved = adaptCanonicalConversationItem(
      item({
        kind: 'approval',
        content: { approval_kind: 'function', call_id: 'call-2', tool: 'bash', decision: 'approve' },
      })
    );
    expect(approved).toMatchObject({
      type: 'guardian_review',
      request_id: 'call-2',
      tool: 'bash',
      reviewer: 'you',
      outcome: 'allow',
      kind: 'tool',
    });

    const rejected = adaptCanonicalConversationItem(
      item({
        kind: 'approval',
        content: {
          approval_kind: 'mcp',
          request_id: 'req-9',
          tool: 'publish',
          server_label: 'github',
          decision: 'reject',
          rejection_message: 'not now',
        },
      })
    );
    expect(rejected).toMatchObject({
      type: 'guardian_review',
      reviewer: 'you',
      outcome: 'deny',
      rationale: 'not now',
      kind: 'mcp',
      server_label: 'github',
    });
  });

  it('maps workflow_review items to workflow steps, skipping unknown outcomes', () => {
    const reviewed = adaptCanonicalConversationItem(
      item({
        kind: 'workflow_review',
        content: {
          task_id: '3',
          subject: 'Verify it',
          outcome: 'accept_verified',
          reviewer: 'guardian',
          rationale: 'tests pass',
        },
      })
    );
    expect(reviewed).toMatchObject({
      type: 'workflow_review',
      task_id: '3',
      subject: 'Verify it',
      outcome: 'accept_verified',
      reviewer: 'guardian',
      rationale: 'tests pass',
      session_id: 'thread-1',
      canonical: { kind: 'workflow_review' },
    });
    const unknownOutcome = adaptCanonicalConversationItem(
      item({ kind: 'workflow_review', content: { task_id: '3', subject: 'Verify it', outcome: 'maybe' } })
    );
    expect(unknownOutcome).toMatchObject({ type: 'structured', kind: 'workflow_review' });
  });

  it('keeps resolved approvals and structured/future kinds non-actionable without flattening their content', () => {
    // A resolved approval with neither reviewer metadata nor a usable
    // decision (nothing to attribute) stays a structured card — never an
    // actionable approval, never a fabricated review step.
    const resolved = adaptCanonicalConversationItem(
      item({ kind: 'approval', content: { call_id: 'call-1', tool: 'rm', reason: 'unsafe' } })
    );
    expect(resolved).toMatchObject({
      type: 'structured',
      kind: 'approval',
      canonical: { content: { reason: 'unsafe' } },
    });

    for (const kind of ['elicitation', 'compaction', 'server_feature_v3']) {
      const adapted = adaptCanonicalConversationItem(item({ kind, content: { nested: { preserved: true } } }));
      expect(adapted).toMatchObject({
        type: 'structured',
        kind,
        canonical: { content: { nested: { preserved: true } } },
      });
    }
  });

  it('preserves honest run-diff empty, opaque, unknown-baseline, and truncation states', () => {
    const adapted = adaptCanonicalConversationItem(
      item({
        kind: 'run_diff',
        content: {
          run_id: 'run-1',
          diff: '',
          files: [
            {
              path: 'assets/logo.bin',
              change_type: 'modified',
              additions: 0,
              deletions: 0,
              opaque: true,
              baseline_unknown: true,
            },
          ],
          stats: { files_changed: 501, additions: 0, deletions: 0 },
          truncated: true,
          files_truncated: true,
        },
      })
    );
    expect(adapted).toMatchObject({
      type: 'run_diff',
      id: 'run-1',
      diff: '',
      files: [{ path: 'assets/logo.bin', opaque: true, baselineUnknown: true }],
      stats: { filesChanged: 501 },
      truncated: true,
      filesTruncated: true,
    });
  });
});

describe('canonical transcript pagination boundary', () => {
  it('loads a large overlapping history without dropping revisions or reordering rows', async () => {
    const items = Array.from({ length: 1500 }, (_, index) =>
      item({ item_id: `item-${index}`, seq: index + 1, content: { text: `message ${index}` } })
    );
    const revised = { ...items[499]!, revision: 2, content: { text: 'revised boundary message' } };
    const request = vi
      .fn()
      .mockResolvedValueOnce(page(items.slice(0, 500), 'p2', 1500))
      .mockResolvedValueOnce(page([revised, ...items.slice(500, 999)], 'p3', 1500))
      .mockResolvedValueOnce(page(items.slice(999, 1499), 'p4', 1500))
      .mockResolvedValueOnce(page(items.slice(1499), null, 1500));
    const loaded = await loadSessionTranscript({ request, getSessionHistory: vi.fn() } as never, 'thread-1');
    expect(loaded.rawItemCount).toBe(1500);
    expect(loaded.items.map((entry) => entry.canonical?.seq)).toEqual(items.map((entry) => entry.seq));
    expect(loaded.items[499]).toMatchObject({ content: 'revised boundary message', canonical: { revision: 2 } });
  });

  it('deduplicates page overlap by item_id/revision and orders by seq', () => {
    const old = item({ item_id: 'itm-2', seq: 2, revision: 0, updated_at: 2, content: { text: 'old' } });
    const revised = item({ item_id: 'itm-2', seq: 2, revision: 1, updated_at: 3, content: { text: 'new' } });
    const first = item({ item_id: 'itm-1', seq: 1 });
    expect(mergeCanonicalConversationItems([[old], [revised, first]])).toEqual([first, revised]);
  });

  it('loads every canonical page as the authoritative baseline', async () => {
    const first = item({ item_id: 'itm-1', seq: 1 });
    const second = item({ item_id: 'itm-2', seq: 2 });
    const request = vi
      .fn()
      .mockResolvedValueOnce(page([first], 'cursor-2', 2))
      .mockResolvedValueOnce(page([second], null, 2));
    const getSessionHistory = vi.fn();

    const loaded = await loadSessionTranscript({ request, getSessionHistory } as never, 'thread-1');

    expect(loaded).toMatchObject({ source: 'canonical', rawItemCount: 2 });
    expect(loaded.items.map((entry) => entry.canonical?.item_id)).toEqual(['itm-1', 'itm-2']);
    expect(request).toHaveBeenNthCalledWith(1, 'list_items', { thread_id: 'thread-1', limit: 500, order: 'asc' });
    expect(request).toHaveBeenNthCalledWith(2, 'list_items', {
      thread_id: 'thread-1',
      limit: 500,
      order: 'asc',
      cursor: 'cursor-2',
    });
    expect(getSessionHistory).not.toHaveBeenCalled();
  });

  it('falls back to legacy history only when canonical list_items is unsupported', async () => {
    const getSessionHistory = vi.fn().mockResolvedValue([{ role: 'user', content: 'legacy' }]);
    const request = vi.fn().mockRejectedValue(new OmniagentsRpcError({ code: -32601, message: 'Method not found' }));

    const loaded = await loadSessionTranscript({ request, getSessionHistory } as never, 'thread-1');

    expect(loaded).toMatchObject({ source: 'legacy', rawItemCount: 1 });
    expect(loaded.items[0]).toMatchObject({ type: 'chat', role: 'user', content: 'legacy' });
    expect(getSessionHistory).toHaveBeenCalledWith('thread-1');
  });

  it('treats a live session with no recorded canonical thread as an empty transcript', async () => {
    const request = vi.fn().mockRejectedValue(
      new OmniagentsRpcError({
        code: -32080,
        message: 'Unknown thread: fresh-session',
        data: { kind: 'thread_not_found', thread_id: 'fresh-session' },
      })
    );
    const getSessionHistory = vi.fn();

    const loaded = await loadSessionTranscript({ request, getSessionHistory } as never, 'fresh-session');

    expect(loaded).toEqual({ items: [], source: 'canonical', rawItemCount: 0 });
    expect(getSessionHistory).not.toHaveBeenCalled();
  });

  it('does not hide canonical protocol or server failures behind legacy history', async () => {
    const failure = new Error('database unavailable');
    const request = vi.fn().mockRejectedValue(failure);
    const getSessionHistory = vi.fn();

    await expect(loadSessionTranscript({ request, getSessionHistory } as never, 'thread-1')).rejects.toBe(failure);
    expect(getSessionHistory).not.toHaveBeenCalled();
  });

  it('rejects a pagination cursor loop', async () => {
    const request = vi.fn().mockResolvedValue(page([item()], 'same-cursor'));
    await expect(
      listAllCanonicalConversationItems({ request } as unknown as ConversationRpcTransport, 'thread-1')
    ).rejects.toThrow(/cursor did not advance/);
  });
});
