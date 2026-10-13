import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ServerStore } from '@/server/store';
import { applyUserGoalCommand, USER_GOAL_TOOLS, type UserGoalCommand, userGoalsContext } from '@/shared/user-goals';

const user = { kind: 'user' } as const;
const agent = { kind: 'agent', agentId: 'researcher' } as const;
const create = () =>
  applyUserGoalCommand([], { kind: 'create', title: '  Make the app easier  ', notes: 'Still vague' }, user, 'g1', 10);

describe('user goals, separate from execution goals', () => {
  it('persists outcomes across store reloads without creating run state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'user-goals-'));
    try {
      const path = join(dir, 'settings.json');
      const store = new ServerStore(path);
      store.set('userGoals', create().goals);
      const reopened = new ServerStore(path);
      expect(reopened.get('userGoals')?.[0]).toMatchObject({
        id: 'g1',
        title: 'Make the app easier',
        completedAt: null,
      });
      expect(Object.keys(reopened.store)).not.toContain('goal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('lets only the user complete and reopen; progress does not complete', () => {
    const created = create();
    const progress = applyUserGoalCommand(
      created.goals,
      { kind: 'progress', id: 'g1', note: 'Ready for your review', reference: 'report.md' },
      agent,
      'p1',
      11
    );
    expect(progress.goal.completedAt).toBeNull();
    expect(progress.goal.progress[0]).toMatchObject({ agentId: 'researcher', reference: 'report.md' });
    expect(created.goal.progress).toEqual([]);
    expect(() =>
      applyUserGoalCommand(progress.goals, { kind: 'set_completed', id: 'g1', completed: true }, agent, '', 12)
    ).toThrow('Only the user');
    const done = applyUserGoalCommand(
      progress.goals,
      { kind: 'set_completed', id: 'g1', completed: true },
      user,
      '',
      12
    );
    expect(done.goal.completedAt).toBe(12);
    expect(
      applyUserGoalCommand(done.goals, { kind: 'set_completed', id: 'g1', completed: false }, user, '', 13).goal
        .completedAt
    ).toBeNull();
    expect(() =>
      applyUserGoalCommand(
        done.goals,
        { kind: 'set_completed', id: 'g1', completed: 'false' } as unknown as UserGoalCommand,
        user,
        '',
        14
      )
    ).toThrow('boolean');
  });
  it('exposes read/progress tools only and injects bounded background data', () => {
    expect(USER_GOAL_TOOLS.map((t) => t.name)).toEqual([
      'list_user_goals',
      'get_user_goal',
      'record_user_goal_progress',
    ]);
    const context = userGoalsContext(create().goals);
    expect(context).toContain('separate from the /goal execution loop');
    expect(context).toContain('Do not start autopilot');
    expect(context).toContain('g1');
    const done = applyUserGoalCommand(
      create().goals,
      { kind: 'set_completed', id: 'g1', completed: true },
      user,
      '',
      12
    );
    expect(userGoalsContext(done.goals)).not.toContain('g1');
  });
  it('rejects invalid edits and unknown goals without mutating storage', () => {
    expect(() => applyUserGoalCommand([], { kind: 'create', title: ' ' }, user, '', 1)).toThrow('Title');
    expect(() => applyUserGoalCommand([], { kind: 'progress', id: 'missing', note: 'x' }, agent, '', 1)).toThrow(
      'not found'
    );
    expect(() =>
      applyUserGoalCommand(create().goals, { kind: 'edit', id: 'g1', title: 'x', notes: '' }, agent, '', 1)
    ).toThrow('Only the user');
  });
});
