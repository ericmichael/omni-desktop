/**
 * Tests for the "## Prior plan" seeding section of the supervisor prompt
 * (docs/agentic-workflow-enforcement-plan.md §F): incomplete prior steps
 * render with their exit criteria and the recreate instruction; an absent or
 * fully-completed prior plan renders nothing.
 */
import { describe, expect, it } from 'vitest';

import { buildAutopilotGoalText, type SupervisorContext } from '@/main/supervisor-prompt';
import type { ColumnId, Pipeline, PlanSnapshotEntry, Project, ProjectId, Ticket, TicketId } from '@/shared/types';

const project: Project = {
  id: 'p1' as ProjectId,
  label: 'Proj',
  slug: 'proj',
  sources: [],
  createdAt: 0,
};

const pipeline: Pipeline = {
  columns: [
    { id: 'todo' as ColumnId, label: 'To do', category: 'todo' },
    { id: 'doing' as ColumnId, label: 'Doing', category: 'doing' },
    { id: 'done' as ColumnId, label: 'Done', category: 'done' },
  ],
};

const ticket: Ticket = {
  id: 't1' as TicketId,
  projectId: project.id,
  columnId: 'doing' as ColumnId,
  title: 'Fix the flaky login test',
  description: '',
  priority: 'medium',
  blockedBy: [],
  createdAt: 0,
  updatedAt: 0,
};

const priorPlan: PlanSnapshotEntry[] = [
  { id: '1', subject: 'Reproduce the failure', status: 'completed' },
  {
    id: '2',
    subject: 'Fix the race in login()',
    status: 'in_progress',
    exitCriteria: 'npx vitest run src/login.test.ts passes',
    blockedBy: ['1'],
  },
  { id: '3', subject: 'Get sign-off', status: 'blocked', owner: 'user', blockedBy: ['2'] },
];

const render = (context?: SupervisorContext): string => buildAutopilotGoalText(ticket, project, pipeline, context);

describe('buildAutopilotGoalText — prior plan seeding', () => {
  it('renders the section with criteria, edges, and the recreate instruction', () => {
    const prompt = render({ priorPlan });

    expect(prompt).toContain('## Prior plan');
    // Completed steps listed as done context.
    expect(prompt).toContain('Already completed');
    expect(prompt).toContain('Reproduce the failure');
    // Incomplete steps carry their criteria and blocker edges.
    expect(prompt).toContain('#2 Fix the race in login()');
    expect(prompt).toContain('exit criteria: npx vitest run src/login.test.ts passes');
    expect(prompt).toContain('blocked by: #2');
    expect(prompt).toContain('owner: user');
    // The recreate instruction names the tools.
    expect(prompt).toContain('task_create');
    expect(prompt).toContain('addBlockedBy');
  });

  it('renders nothing without a prior plan', () => {
    expect(render()).not.toContain('## Prior plan');
    expect(render({ priorPlan: [] })).not.toContain('## Prior plan');
  });

  it('renders nothing when every prior step completed', () => {
    const prompt = render({
      priorPlan: [
        { id: '1', subject: 'A', status: 'completed' },
        { id: '2', subject: 'B', status: 'completed' },
      ],
    });
    expect(prompt).not.toContain('## Prior plan');
    expect(prompt).not.toContain('task_create');
  });
});
