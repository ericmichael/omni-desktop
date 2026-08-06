import { describe, expect, it, vi } from 'vitest';

import type { ItemUpdatedParams, RpcMethodMap } from '@/generated/omniagents-gui-v1/gui-v1';

import { PlansAndDiffsClient, PlansAndDiffsProtocolError, type PlansAndDiffsTransport } from './plans-and-diffs';

type Method = 'get_plan' | 'get_run_diff';

class FakeTransport implements PlansAndDiffsTransport {
  readonly request = vi.fn(async (_method: Method, _params: RpcMethodMap[Method]['params']) => this.result) as (
    method: Method,
    params: RpcMethodMap[Method]['params']
  ) => Promise<Record<string, unknown>>;
  result: Record<string, unknown> = {};
  private handler: ((payload: ItemUpdatedParams) => void) | null = null;

  on(_event: 'item_updated', handler: (payload: ItemUpdatedParams) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  emit(payload: ItemUpdatedParams): void {
    this.handler?.(payload);
  }
}

const step = (overrides: Record<string, unknown> = {}) => ({
  id: '1',
  subject: 'Implement it',
  description: 'Implement the typed boundary',
  active_form: 'Implementing the typed boundary',
  status: 'in_progress',
  owner: 'agent',
  blocks: [],
  blocked_by: [],
  ...overrides,
});

const plan = (revision = 2, overrides: Record<string, unknown> = {}) => ({
  plan_id: 'itm-plan',
  item_id: 'itm-plan',
  thread_id: 'thread-1',
  turn_id: 'turn-1',
  scope: 'main',
  generation: 0,
  steps: [step()],
  counts: { pending: 0, in_progress: 1, completed: 0, blocked: 0 },
  status: 'started',
  finalized_by: null,
  revision,
  updated_at: 10 + revision,
  ...overrides,
});

const runDiff = (revision = 1, overrides: Record<string, unknown> = {}) => ({
  run_id: 'turn-1',
  item_id: 'itm-diff',
  status: 'completed',
  revision,
  updated_at: 20 + revision,
  diff: '',
  files: [],
  stats: { files_changed: 0, additions: 0, deletions: 0 },
  truncated: false,
  files_truncated: false,
  ...overrides,
});

describe('PlansAndDiffsClient reads', () => {
  it('treats an absent plan as ordinary and preserves additive result fields', async () => {
    const rpc = new FakeTransport();
    rpc.result = { thread_id: 'thread-1', scope: 'worker', plan: null, plans: [], server_hint: 'future' };
    const client = new PlansAndDiffsClient(rpc);

    const result = await client.getPlan('thread-1', 'worker');

    expect(rpc.request).toHaveBeenCalledWith('get_plan', { thread_id: 'thread-1', scope: 'worker' });
    expect(result).toMatchObject({ plan: null, plans: [], server_hint: 'future' });
    client.dispose();
  });

  it('validates structured plan fields while retaining additive item, step, and count fields', async () => {
    const rpc = new FakeTransport();
    const item = plan(2, {
      future_item: true,
      steps: [step({ future_step: 42 })],
      counts: { pending: 0, in_progress: 1, completed: 0, blocked: 0, deferred: 7 },
    });
    rpc.result = { thread_id: 'thread-1', scope: 'main', plan: item, plans: [item] };
    const client = new PlansAndDiffsClient(rpc);

    const result = await client.getPlan('thread-1');

    expect(result.plan).toMatchObject({ future_item: true, revision: 2 });
    expect(result.plan?.steps[0]).toMatchObject({ future_step: 42, status: 'in_progress' });
    expect(result.plan?.counts).toMatchObject({ deferred: 7, in_progress: 1 });
    expect(client.getCached('itm-plan')).toEqual(result.plan);
    client.dispose();
  });

  it('keeps no-change, truncated, opaque, and unknown-baseline states honest', async () => {
    const rpc = new FakeTransport();
    const client = new PlansAndDiffsClient(rpc);

    rpc.result = { thread_id: 'thread-1', turn_id: null, run_diff: null, reason: 'no turns' };
    await expect(client.getRunDiff('thread-1')).resolves.toMatchObject({ turn_id: null, run_diff: null });

    rpc.result = {
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      run_diff: runDiff(4, {
        future_diff: 'kept',
        diff: '',
        files: [
          {
            path: 'assets/logo.bin',
            change_type: 'modified',
            additions: 0,
            deletions: 0,
            opaque: true,
            baseline_unknown: true,
            media_type: 'application/octet-stream',
          },
        ],
        stats: { files_changed: 501, additions: 0, deletions: 0, future_total: 9 },
        truncated: true,
        files_truncated: true,
      }),
    };

    const result = await client.getRunDiff('thread-1', 'turn-1');

    expect(rpc.request).toHaveBeenLastCalledWith('get_run_diff', {
      thread_id: 'thread-1',
      turn_id: 'turn-1',
    });
    expect(result.run_diff).toMatchObject({
      diff: '',
      future_diff: 'kept',
      truncated: true,
      files_truncated: true,
      stats: { files_changed: 501, future_total: 9 },
    });
    expect(result.run_diff?.files[0]).toMatchObject({
      opaque: true,
      baseline_unknown: true,
      media_type: 'application/octet-stream',
    });
    client.dispose();
  });

  it('rejects malformed known fields instead of casting open records', async () => {
    const rpc = new FakeTransport();
    rpc.result = {
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      run_diff: runDiff(1, { files: [{ path: 'bad', change_type: 'renamed' }] }),
    };
    const client = new PlansAndDiffsClient(rpc);

    await expect(client.getRunDiff('thread-1')).rejects.toBeInstanceOf(PlansAndDiffsProtocolError);
    client.dispose();
  });
});

describe('PlansAndDiffsClient item_updated cache', () => {
  it('adopts only increasing revisions and preserves additive notification content', async () => {
    const rpc = new FakeTransport();
    rpc.result = { thread_id: 'thread-1', scope: 'main', plan: plan(4), plans: [plan(4)] };
    const client = new PlansAndDiffsClient(rpc);
    await client.getPlan('thread-1');
    const updates = vi.fn();
    client.onItemUpdated(updates);

    const emitPlan = (revision: number, subject: string) =>
      rpc.emit({
        session_id: 'thread-1',
        thread_id: 'thread-1',
        item_id: 'itm-plan',
        turn_id: 'turn-1',
        kind: 'plan',
        status: 'started',
        revision,
        item_seq: 12,
        updated_at: 30 + revision,
        content: {
          plan_id: 'itm-plan',
          scope: 'main',
          generation: 0,
          steps: [step({ subject })],
          counts: { pending: 0, in_progress: 1, completed: 0, blocked: 0 },
          future_content: { supported: true },
        },
      });

    emitPlan(3, 'stale');
    emitPlan(4, 'duplicate');
    expect(updates).not.toHaveBeenCalled();
    expect((client.getCached('itm-plan') as { steps: Array<{ subject: string }> }).steps[0]?.subject).toBe(
      'Implement it'
    );

    emitPlan(5, 'newest');
    expect(updates).toHaveBeenCalledTimes(1);
    expect(client.getCached('itm-plan')).toMatchObject({
      revision: 5,
      item_seq: 12,
      future_content: { supported: true },
      steps: [{ subject: 'newest' }],
    });
    client.dispose();
  });

  it('applies the same monotonic rule to run diffs and ignores unrelated item kinds', () => {
    const rpc = new FakeTransport();
    const client = new PlansAndDiffsClient(rpc);
    const updates = vi.fn();
    client.onItemUpdated(updates);

    const emitDiff = (revision: number, truncated: boolean) =>
      rpc.emit({
        session_id: 'thread-1',
        thread_id: 'thread-1',
        item_id: 'itm-diff',
        turn_id: 'turn-1',
        kind: 'run_diff',
        status: 'completed',
        revision,
        item_seq: 13,
        updated_at: 40 + revision,
        content: {
          run_id: 'turn-1',
          diff: '',
          files: [],
          stats: { files_changed: 0, additions: 0, deletions: 0 },
          truncated,
          files_truncated: false,
        },
      });

    emitDiff(2, true);
    emitDiff(1, false);
    rpc.emit({
      session_id: 'thread-1',
      thread_id: 'thread-1',
      item_id: 'itm-other',
      kind: 'artifact',
      status: 'completed',
      revision: 99,
      item_seq: 14,
      updated_at: 99,
      content: {},
    });

    expect(updates).toHaveBeenCalledTimes(1);
    expect(client.getCached('itm-diff')).toMatchObject({ revision: 2, truncated: true, files: [] });
    expect(client.getCached('itm-other')).toBeUndefined();
    client.dispose();
  });
});
