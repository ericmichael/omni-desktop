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
  initiativeId: 'init-1',
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

  it('mentions tool names', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('move_ticket');
    expect(prompt).toContain('escalate');
    expect(prompt).toContain('get_ticket');
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
});
