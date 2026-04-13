import { describe, expect, it } from 'vitest';

import type { Pipeline, Project, Ticket } from '@/shared/types';

import { buildSupervisorPrompt } from '@/main/supervisor-prompt';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makePipeline = (columns: { id: string; label: string }[]): Pipeline => ({
  columns: columns.map((c) => ({
    ...c,
  })),
});

const makeTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'ticket-42',
  projectId: 'proj-1',
  milestoneId: 'ms-1',
  title: 'Add dark mode',
  description: 'Implement dark mode across the entire app.',
  priority: 'high',
  columnId: 'col-impl',
  blockedBy: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'proj-1',
  label: 'My Project',
  slug: 'my-project',
  source: { kind: 'local', workspaceDir: '/home/user/project' },
  createdAt: Date.now(),
  ...overrides,
});

const PIPELINE = makePipeline([
  { id: 'col-backlog', label: 'Backlog' },
  { id: 'col-spec', label: 'Spec' },
  { id: 'col-impl', label: 'Implementation' },
  { id: 'col-done', label: 'Done' },
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSupervisorPrompt', () => {
  it('includes ticket title and description', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('Title: Add dark mode');
    expect(prompt).toContain('Implement dark mode across the entire app.');
  });

  it('includes priority', () => {
    const prompt = buildSupervisorPrompt(makeTicket({ priority: 'critical' }), makeProject(), PIPELINE);
    expect(prompt).toContain('Priority: critical');
  });

  it('includes current column label', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('Current Column: Implementation');
  });

  it('mentions key tool names', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('move_ticket');
  });

  it('includes artifacts directory path', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('/home/user/.config/omni_code/tickets/ticket-42/artifacts');
  });

  it('includes pipeline column names', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('Backlog → Spec → Implementation → Done');
  });

  it('handles missing description gracefully', () => {
    const prompt = buildSupervisorPrompt(makeTicket({ description: '' }), makeProject(), PIPELINE);
    expect(prompt).toContain('title is your complete task specification');
  });

  it('includes worker dispatch guidelines', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('spawn_worker');
    expect(prompt).toContain('boundaries');
  });

  it('includes project brief when provided in context', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE, {
      projectBrief: '# My Project\nBuilding a widget system.',
    });
    expect(prompt).toContain('## Project Brief (preview)');
    expect(prompt).toContain('Building a widget system');
  });

  it('includes blocker titles when provided in context', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE, {
      blockerTitles: ['Set up database', 'Configure auth'],
    });
    expect(prompt).toContain('## Blockers');
    expect(prompt).toContain('- Set up database');
    expect(prompt).toContain('- Configure auth');
  });

  it('includes recent comments when provided in context', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE, {
      recentComments: [
        { author: 'agent', content: 'Completed auth middleware' },
        { author: 'human', content: 'Looks good, continue with tests' },
      ],
    });
    expect(prompt).toContain('## Recent Comments');
    expect(prompt).toContain('[agent]: Completed auth middleware');
    expect(prompt).toContain('[human]: Looks good, continue with tests');
  });

  it('omits context sections when not provided', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).not.toContain('## Project Brief');
    expect(prompt).not.toContain('## Blockers');
    expect(prompt).not.toContain('## Recent Comments');
  });
});
