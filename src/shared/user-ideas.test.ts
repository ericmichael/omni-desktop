import { describe, expect, it } from 'vitest';
import { applyUserIdeaCommand, USER_IDEA_TOOLS } from './user-ideas';
import { applyUserGoalCommand } from './user-goals';

const user = { kind: 'user' } as const;
const agent = { kind: 'agent', agentId: 'quill' } as const;
const goals = applyUserGoalCommand([], { kind: 'create', title: 'Improve onboarding' }, user, 'g', 1).goals;
const proposal = {
  kind: 'propose',
  goalId: 'g',
  title: 'Review the first visit',
  plan: 'Inspect onboarding and draft improvements.',
  authorization: 'Research and a written draft. No implementation.',
} as const;
const create = () => applyUserIdeaCommand([], goals, proposal, agent, 'i', 2);

describe('user ideas', () => {
  it('requires an open goal and binds proposals to the resident identity', () => {
    expect(create().idea).toMatchObject({ status: 'pending', agentId: 'quill', goalId: 'g' });
    expect(() => applyUserIdeaCommand([], goals, proposal, user, 'i', 2)).toThrow('resident identity');
    expect(() => applyUserIdeaCommand([], [], proposal, agent, 'i', 2)).toThrow('Open user goal');
    expect(() => applyUserIdeaCommand([], [{ ...goals[0]!, completedAt: 3 }], proposal, agent, 'i', 2)).toThrow(
      'Open user goal'
    );
    expect(() => applyUserIdeaCommand([], goals, { ...proposal, authorization: '' }, agent, 'i', 2)).toThrow(
      'Authorization'
    );
  });
  it('only users decide; approval leaves the goal untouched and retries are idempotent', () => {
    const before = create().ideas;
    expect(() =>
      applyUserIdeaCommand(before, goals, { kind: 'decide', id: 'i', status: 'approved' }, agent, 'x', 3)
    ).toThrow('Only the user');
    const approved = applyUserIdeaCommand(before, goals, { kind: 'decide', id: 'i', status: 'approved' }, user, 'x', 3);
    expect(approved.idea.status).toBe('approved');
    expect(approved.decisionChanged).toBe(true);
    expect(
      applyUserIdeaCommand(approved.ideas, goals, { kind: 'decide', id: 'i', status: 'approved' }, user, 'x', 4)
        .decisionChanged
    ).not.toBe(true);
    expect(before[0]!.status).toBe('pending');
    expect(goals[0]!.completedAt).toBeNull();
    expect(
      applyUserIdeaCommand(approved.ideas, goals, { kind: 'decide', id: 'i', status: 'approved' }, user, 'x', 4).idea
    ).toEqual(approved.idea);
    expect(() =>
      applyUserIdeaCommand(approved.ideas, goals, { kind: 'decide', id: 'i', status: 'dismissed' }, user, 'x', 4)
    ).toThrow('already decided');
  });
  it('preserves dismissal feedback and rejects unauthorized progress', () => {
    const pending = create().ideas;
    const progress = { kind: 'progress', id: 'i', note: 'Draft ready', reference: '/draft.md' } as const;
    expect(() => applyUserIdeaCommand(pending, goals, progress, agent, 'n', 4)).toThrow('Only approved');
    const dismissed = applyUserIdeaCommand(
      pending,
      goals,
      { kind: 'decide', id: 'i', status: 'dismissed', feedback: 'Focus on accessibility' },
      user,
      'x',
      3
    );
    expect(dismissed.idea.feedback).toBe('Focus on accessibility');
    expect(() => applyUserIdeaCommand(dismissed.ideas, goals, progress, agent, 'n', 4)).toThrow('Only approved');
    const approved = applyUserIdeaCommand(
      pending,
      goals,
      { kind: 'decide', id: 'i', status: 'approved' },
      user,
      'x',
      3
    );
    expect(() => applyUserIdeaCommand(approved.ideas, goals, progress, user, 'n', 4)).toThrow('resident identity');
    expect(applyUserIdeaCommand(approved.ideas, goals, progress, agent, 'n', 4).idea.progress[0]).toMatchObject({
      agentId: 'quill',
      note: 'Draft ready',
      reference: '/draft.md',
    });
  });
  it('exposes reading, proposing and progress tools without a decision tool', () => {
    expect(USER_IDEA_TOOLS.map((t) => t.name)).toEqual([
      'list_user_ideas',
      'get_user_idea',
      'propose_user_idea',
      'record_user_idea_progress',
    ]);
  });
});
