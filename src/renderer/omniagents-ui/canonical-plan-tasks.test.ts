import { describe, expect, it } from 'vitest';

import type { MessageItem, PlanItem } from '@/shared/chat-types';

import { canonicalPlanTasks, negotiatedPlanTasks } from './canonical-plan-tasks';

const plan = (seq: number, revision: number, subject: string, scope = 'main'): PlanItem => ({
  type: 'plan',
  id: `plan-${seq}`,
  title: 'Plan',
  scope,
  steps: [
    {
      id: 'step-1',
      title: subject,
      activeForm: `Doing ${subject}`,
      status: 'blocked',
      owner: 'agent',
      blockedBy: ['step-0'],
    },
  ],
  canonical: {
    item_id: `plan-${seq}`,
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    seq,
    kind: 'plan',
    status: 'started',
    revision,
    created_at: 1,
    updated_at: revision,
    content: {},
    source_ref: {},
  },
});

describe('canonicalPlanTasks', () => {
  it('returns null when the transcript has no canonical main plan', () => {
    expect(canonicalPlanTasks([])).toBeNull();
    expect(canonicalPlanTasks([plan(2, 1, 'worker', 'worker')])).toBeNull();
  });

  it('projects the newest main plan without losing blocked state', () => {
    const items: MessageItem[] = [plan(3, 1, 'older'), plan(4, 2, 'newest'), plan(8, 1, 'worker', 'worker')];
    expect(canonicalPlanTasks(items)).toEqual([
      {
        id: 'step-1',
        subject: 'newest',
        activeForm: 'Doing newest',
        status: 'blocked',
        owner: 'agent',
        blockedBy: ['step-0'],
      },
    ]);
  });

  it('uses legacy task snapshots only when the canonical feature is unavailable', () => {
    const legacy = [{ id: 'legacy', subject: 'Legacy task', status: 'pending' as const }];
    expect(negotiatedPlanTasks([], legacy, false)).toEqual(legacy);
    expect(negotiatedPlanTasks([], legacy, true)).toEqual([]);
    expect(negotiatedPlanTasks([plan(4, 1, 'canonical')], legacy, false)).toMatchObject([{ subject: 'canonical' }]);
  });
});
