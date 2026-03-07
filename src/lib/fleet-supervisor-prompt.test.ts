import { describe, expect, it } from 'vitest';

import type { FleetPipeline, FleetProject, FleetTicket } from '@/shared/types';

import { buildSupervisorPrompt } from '@/main/fleet-supervisor-prompt';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makePipeline = (columns: { id: string; label: string }[]): FleetPipeline => ({
  columns: columns.map((c) => ({
    ...c,
  })),
});

const makeTicket = (overrides: Partial<FleetTicket> = {}): FleetTicket => ({
  id: 'ticket-42',
  projectId: 'proj-1',
  title: 'Add dark mode',
  description: 'Implement dark mode across the entire app.',
  priority: 'high',
  columnId: 'col-impl',
  blockedBy: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

const makeProject = (overrides: Partial<FleetProject> = {}): FleetProject => ({
  id: 'proj-1',
  label: 'My Project',
  workspaceDir: '/home/user/project',
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

  it('includes TICKET.yaml path and instructions', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('/home/user/.config/omni_code/fleet/tickets/ticket-42/TICKET.yaml');
    expect(prompt).toContain('edit the `column` field');
  });

  it('includes artifacts directory path', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('/home/user/.config/omni_code/fleet/tickets/ticket-42/artifacts');
  });

  it('includes pipeline column names', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('Backlog → Spec → Implementation → Done');
  });

  it('shows "(no description)" when description is empty', () => {
    const prompt = buildSupervisorPrompt(makeTicket({ description: '' }), makeProject(), PIPELINE);
    expect(prompt).toContain('(no description)');
  });

  it('includes worker dispatch guidelines', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('spawn_worker');
    expect(prompt).toContain('Goal');
    expect(prompt).toContain('Boundaries');
  });
});
