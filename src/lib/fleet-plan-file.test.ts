import { describe, expect, it } from 'vitest';

import type { FleetPipeline, FleetTicket } from '@/shared/types';

import { parseTicketYaml, serializeTicketYaml } from './fleet-plan-file';

const makePipeline = (): FleetPipeline => ({
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'todo', label: 'Todo' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'done', label: 'Done' },
  ],
});

const makeTicket = (overrides: Partial<FleetTicket> = {}): FleetTicket => ({
  id: 'tkt-1',
  projectId: 'proj-1',
  title: 'Test ticket',
  description: 'A test',
  priority: 'medium',
  columnId: 'todo',
  blockedBy: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

describe('serializeTicketYaml', () => {
  it('includes column label', () => {
    const result = serializeTicketYaml(makeTicket(), makePipeline());
    expect(result).toContain('column: "Todo"');
  });

  it('includes pipeline in comment', () => {
    const result = serializeTicketYaml(makeTicket(), makePipeline());
    expect(result).toContain('Backlog → Todo → In Progress → Done');
  });

  it('includes escalation instructions in comment', () => {
    const result = serializeTicketYaml(makeTicket(), makePipeline());
    expect(result).toContain('escalation');
  });

  it('falls back to columnId when column not found in pipeline', () => {
    const result = serializeTicketYaml(makeTicket({ columnId: 'unknown' }), makePipeline());
    expect(result).toContain('column: "unknown"');
  });
});

describe('parseTicketYaml', () => {
  it('parses quoted column label', () => {
    const result = parseTicketYaml('column: "In Progress"\n');
    expect(result.column).toBe('In Progress');
    expect(result.escalation).toBeNull();
  });

  it('parses unquoted column label', () => {
    const result = parseTicketYaml('column: Todo\n');
    expect(result.column).toBe('Todo');
  });

  it('parses escalation field', () => {
    const content = 'column: "In Progress"\nescalation: "Need API key for CI"\n';
    const result = parseTicketYaml(content);
    expect(result.column).toBe('In Progress');
    expect(result.escalation).toBe('Need API key for CI');
  });

  it('parses quoted escalation', () => {
    const content = 'column: "Todo"\nescalation: "Tests are failing, need help"\n';
    const result = parseTicketYaml(content);
    expect(result.escalation).toBe('Tests are failing, need help');
  });

  it('ignores comments and parses fields', () => {
    const content = '# comment\n# Pipeline: A → B\n\ncolumn: "B"\n';
    const result = parseTicketYaml(content);
    expect(result.column).toBe('B');
    expect(result.escalation).toBeNull();
  });

  it('returns nulls for empty content', () => {
    const result = parseTicketYaml('');
    expect(result.column).toBeNull();
    expect(result.escalation).toBeNull();
  });

  it('returns null column for content without column field', () => {
    const result = parseTicketYaml('something: else\n');
    expect(result.column).toBeNull();
  });
});
