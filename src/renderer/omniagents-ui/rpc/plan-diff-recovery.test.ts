import { describe, expect, it, vi } from 'vitest';

import type { ConversationItem } from './conversation';
import { PlanDiffRecovery } from './plan-diff-recovery';

const canonical = (itemId: string, kind: 'plan' | 'run_diff'): ConversationItem => ({
  item_id: itemId,
  thread_id: 'thread-1',
  turn_id: 'turn-1',
  seq: kind === 'plan' ? 2 : 3,
  kind,
  status: 'completed',
  role: null,
  created_at: 1,
  updated_at: 2,
  completed_at: 2,
  revision: 1,
  content:
    kind === 'plan'
      ? { plan_id: itemId, scope: 'main', steps: [] }
      : {
          run_id: 'turn-1',
          diff: '',
          files: [],
          stats: { files_changed: 0, additions: 0, deletions: 0 },
          truncated: false,
          files_truncated: false,
        },
  source_ref: {},
  long_lived: false,
  source: 'recorder',
  schema_version: 1,
});

describe('PlanDiffRecovery', () => {
  it('does not issue experimental reads unless the complete feature was negotiated', async () => {
    const plans = { getPlan: vi.fn(), getRunDiff: vi.fn() };
    const conversations = { getItem: vi.fn() };
    const recovery = new PlanDiffRecovery(plans as never, conversations as never, () => false);

    await expect(recovery.recoverPlans('thread-1')).resolves.toEqual([]);
    await expect(recovery.recoverLatestRunDiff('thread-1')).resolves.toEqual([]);
    expect(plans.getPlan).not.toHaveBeenCalled();
    expect(plans.getRunDiff).not.toHaveBeenCalled();
  });

  it('hydrates authoritative plan and run-diff identities through canonical get_item', async () => {
    const plan = { item_id: 'plan-1' };
    const diff = { item_id: 'diff-1' };
    const plans = {
      getPlan: vi.fn().mockResolvedValue({ plan, plans: [plan] }),
      getRunDiff: vi.fn().mockResolvedValue({ run_diff: diff }),
    };
    const conversations = {
      getItem: vi.fn(async (_threadId: string, itemId: string) =>
        itemId === 'plan-1' ? canonical(itemId, 'plan') : canonical(itemId, 'run_diff')
      ),
    };
    const recovery = new PlanDiffRecovery(plans as never, conversations as never, () => true);

    await expect(recovery.recoverPlans('thread-1')).resolves.toMatchObject([{ type: 'plan', id: 'plan-1' }]);
    await expect(recovery.recoverLatestRunDiff('thread-1')).resolves.toMatchObject([
      { type: 'run_diff', id: 'turn-1', files: [] },
    ]);
    expect(plans.getPlan).toHaveBeenCalledWith('thread-1');
    expect(plans.getRunDiff).toHaveBeenCalledWith('thread-1', undefined);
    expect(conversations.getItem).toHaveBeenCalledTimes(2);
  });
});
