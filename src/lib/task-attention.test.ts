import { describe, expect, it } from 'vitest';

import { groupTasks, needsAttention } from '@/lib/task-attention';
import type { Column, Pipeline, ProjectId, Ticket, TicketId } from '@/shared/types';

const col = (id: string, category: NonNullable<Column['category']>, gate?: boolean): Column => ({
  id,
  label: id,
  category,
  ...(gate ? { gate: true } : {}),
});

const pipeline: Pipeline = {
  columns: [col('backlog', 'todo'), col('impl', 'doing'), col('review', 'doing', true), col('done', 'done')],
};

let n = 0;
const ticket = (patch: Partial<Ticket>): Ticket => ({
  id: `t${++n}` as TicketId,
  projectId: 'p1' as ProjectId,
  columnId: 'impl',
  title: 'T',
  description: '',
  priority: 'medium',
  blockedBy: [],
  createdAt: 1000 + n,
  updatedAt: 2000 + n,
  ...patch,
});

const pipelineFor = () => pipeline;

describe('needsAttention', () => {
  it('flags agent errors', () => {
    expect(needsAttention(ticket({ phase: 'error' }), pipeline)).toBe('error');
  });

  it('flags tasks parked in a gate column', () => {
    expect(needsAttention(ticket({ columnId: 'review', phase: 'idle' }), pipeline)).toBe('gate');
    expect(needsAttention(ticket({ columnId: 'review' }), pipeline)).toBe('gate');
  });

  it('does not flag a gate column while the agent is still active', () => {
    expect(needsAttention(ticket({ columnId: 'review', phase: 'running' }), pipeline)).toBeNull();
  });

  it('flags agent-finished-but-undispositioned tasks', () => {
    expect(needsAttention(ticket({ phase: 'completed' }), pipeline)).toBe('agent_done');
  });

  it('never flags archived or done tasks', () => {
    expect(needsAttention(ticket({ phase: 'error', archivedAt: 1 }), pipeline)).toBeNull();
    expect(needsAttention(ticket({ phase: 'completed', columnId: 'done' }), pipeline)).toBeNull();
  });

  it('error outranks the gate reason', () => {
    expect(needsAttention(ticket({ columnId: 'review', phase: 'error' }), pipeline)).toBe('error');
  });
});

describe('groupTasks', () => {
  it('groups by category with needs-you as a non-duplicating overlay', () => {
    const errored = ticket({ phase: 'error' });
    const doing = ticket({ columnId: 'impl' });
    const todo = ticket({ columnId: 'backlog' });
    const shipped = ticket({ columnId: 'done' });
    const completed = ticket({ columnId: 'done', completedAt: 5000 });

    const g = groupTasks([errored, doing, todo, shipped, completed], pipelineFor);

    expect(g.needsYou.map((e) => e.ticket.id)).toEqual([errored.id]);
    expect(g.doing.map((t) => t.id)).toEqual([doing.id]);
    expect(g.todo.map((t) => t.id)).toEqual([todo.id]);
    expect(new Set(g.done.map((t) => t.id))).toEqual(new Set([shipped.id, completed.id]));

    // Overlay: the errored task appears exactly once across all groups.
    const all = [...g.needsYou.map((e) => e.ticket.id), ...g.doing, ...g.todo, ...g.done].flat();
    expect(all.filter((id) => id === errored.id)).toHaveLength(1);
  });

  it('excludes archived tasks entirely', () => {
    const g = groupTasks([ticket({ archivedAt: 1 })], pipelineFor);
    expect(g.needsYou).toHaveLength(0);
    expect(g.doing).toHaveLength(0);
    expect(g.todo).toHaveLength(0);
    expect(g.done).toHaveLength(0);
  });

  it('sorts todo by priority then age', () => {
    const low = ticket({ columnId: 'backlog', priority: 'low', createdAt: 1 });
    const critical = ticket({ columnId: 'backlog', priority: 'critical', createdAt: 9 });
    const mediumOld = ticket({ columnId: 'backlog', priority: 'medium', createdAt: 2 });
    const mediumNew = ticket({ columnId: 'backlog', priority: 'medium', createdAt: 8 });

    const g = groupTasks([low, mediumNew, critical, mediumOld], pipelineFor);
    expect(g.todo.map((t) => t.id)).toEqual([critical.id, mediumOld.id, mediumNew.id, low.id]);
  });

  it('puts active-agent tasks first within doing', () => {
    const idle = ticket({ columnId: 'impl', updatedAt: 9000 });
    const active = ticket({ columnId: 'impl', phase: 'running', updatedAt: 100 });
    const g = groupTasks([idle, active], pipelineFor);
    expect(g.doing.map((t) => t.id)).toEqual([active.id, idle.id]);
  });

  it('uses the column as authoritative even if a stale completion timestamp exists', () => {
    const active = ticket({ columnId: 'impl', completedAt: 5000 });
    const g = groupTasks([active], pipelineFor);
    expect(g.doing.map((item) => item.id)).toEqual([active.id]);
    expect(g.done).toHaveLength(0);
  });
});
