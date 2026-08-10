import { describe, expect, it } from 'vitest';

import type { PlanItem as RpcPlanItem } from '@/renderer/omniagents-ui/rpc/plans-and-diffs';
import type { MessageItem, PlanItem, PlanStep } from '@/shared/chat-types';

import {
  canonicalPlanTasks,
  negotiatedPlanTasks,
  planUpdateForBridge,
  rpcPlanTasks,
  type TaskSummary,
} from './canonical-plan-tasks';

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

  it('carries exit criteria and verification through the projection, absent stays undefined', () => {
    const withReview = plan(5, 1, 'reviewed');
    const steps: PlanStep[] = [
      { id: 's1', title: 'verified step', status: 'completed', exitCriteria: 'tests pass', verified: true },
      { id: 's2', title: 'unverified step', status: 'completed', verified: false },
      { id: 's3', title: 'plain step', status: 'pending' },
    ];
    withReview.steps = steps;
    const tasks = canonicalPlanTasks([withReview])!;
    expect(tasks[0]).toMatchObject({ exitCriteria: 'tests pass', verified: true });
    expect(tasks[1]).toMatchObject({ verified: false });
    expect(tasks[1]!.exitCriteria).toBeUndefined();
    expect(tasks[2]!.exitCriteria).toBeUndefined();
    expect(tasks[2]!.verified).toBeUndefined();
  });

  it('carries the criteria-edit stamp through the projection, absent stays undefined', () => {
    const stamped = plan(6, 1, 'stamped');
    stamped.steps = [
      { id: 's1', title: 'edited step', status: 'in_progress', exitCriteria: 'looser bar', criteriaEdited: true },
      { id: 's2', title: 'clean step', status: 'pending', exitCriteria: 'original bar' },
    ];
    const tasks = canonicalPlanTasks([stamped])!;
    expect(tasks[0]!.criteriaEdited).toBe(true);
    expect(tasks[1]!.criteriaEdited).toBeUndefined();
  });
});

describe('rpcPlanTasks', () => {
  const rpcStep = (overrides: Record<string, unknown>): RpcPlanItem['steps'][number] => ({
    id: '1',
    subject: 'step',
    description: '',
    active_form: '',
    status: 'pending',
    owner: '',
    blocks: [],
    blocked_by: [],
    ...overrides,
  });

  const rpcPlan = (steps: RpcPlanItem['steps']): RpcPlanItem => ({
    plan_id: 'plan-1',
    item_id: 'plan-1',
    thread_id: 'worker-thread',
    turn_id: null,
    scope: 'main',
    generation: 1,
    steps,
    counts: { pending: 0, in_progress: 0, completed: 0, blocked: 0 },
    status: 'started',
    finalized_by: null,
    revision: 1,
    updated_at: 1,
  });

  it('returns null when the worker has no plan', () => {
    expect(rpcPlanTasks(null)).toBeNull();
  });

  it('projects mechanical fields and defensively reads the review passthrough keys', () => {
    const tasks = rpcPlanTasks(
      rpcPlan([
        rpcStep({
          id: '1',
          subject: 'repro',
          active_form: 'Reproducing',
          status: 'completed',
          owner: 'agent:worker',
          blocked_by: [],
          exit_criteria: 'failing test exists',
          verified: true,
        }),
        rpcStep({
          id: '2',
          subject: 'fix',
          status: 'completed',
          blocked_by: ['1'],
          review: { outcome: 'unverified' },
          criteria_edited: true,
        }),
        rpcStep({ id: '3', subject: 'stamped', original_exit_criteria: 'stricter bar' }),
        rpcStep({ id: '4', subject: 'plain', exit_criteria: '', review: { outcome: 'waived' } }),
      ])
    )!;
    expect(tasks[0]).toEqual({
      id: '1',
      subject: 'repro',
      activeForm: 'Reproducing',
      status: 'completed',
      owner: 'agent:worker',
      blockedBy: [],
      exitCriteria: 'failing test exists',
      verified: true,
      criteriaEdited: undefined,
    });
    expect(tasks[1]).toMatchObject({ verified: false, criteriaEdited: true, blockedBy: ['1'] });
    expect(tasks[2]).toMatchObject({ criteriaEdited: true });
    expect(tasks[3]!.exitCriteria).toBeUndefined();
    expect(tasks[3]!.verified).toBeUndefined();
    expect(tasks[3]!.criteriaEdited).toBeUndefined();
  });
});

describe('planUpdateForBridge', () => {
  const tasks: TaskSummary[] = [
    {
      id: '1',
      subject: 'repro',
      activeForm: 'Reproducing',
      status: 'completed',
      owner: 'agent:omni',
      blockedBy: [],
      exitCriteria: 'failing test exists',
      verified: false,
    },
    { id: '2', subject: 'fix', status: 'in_progress' },
  ];

  it('returns null without a ticket context', () => {
    expect(planUpdateForBridge(undefined, tasks)).toBeNull();
  });

  it('maps the panel task list into a plan-update snapshot for the ticket', () => {
    const event = planUpdateForBridge('ticket-1', tasks);
    expect(event).toEqual({
      kind: 'plan-update',
      ticketId: 'ticket-1',
      snapshot: [
        {
          id: '1',
          subject: 'repro',
          activeForm: 'Reproducing',
          status: 'completed',
          owner: 'agent:omni',
          blockedBy: [],
          exitCriteria: 'failing test exists',
          verified: false,
        },
        { id: '2', subject: 'fix', status: 'in_progress' },
      ],
    });
  });

  it('forwards an empty panel as a null snapshot (main ignores it)', () => {
    expect(planUpdateForBridge('ticket-1', [])).toEqual({
      kind: 'plan-update',
      ticketId: 'ticket-1',
      snapshot: null,
    });
  });
});
