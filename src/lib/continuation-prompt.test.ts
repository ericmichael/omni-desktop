import { describe, expect, it } from 'vitest';

import { buildContinuationPrompt } from './continuation-prompt';
import type { Pipeline, Ticket } from '@/shared/types';

const makeTicket = (overrides: Partial<Ticket> = {}): Ticket =>
  ({
    id: 't1',
    projectId: 'p1',
    columnId: 'doing',
    title: 'Do the thing',
    description: '',
    priority: 'medium',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as unknown as Ticket;

const pipeline: Pipeline = {
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'doing', label: 'Doing' },
    { id: 'done', label: 'Done' },
  ],
} as unknown as Pipeline;

describe('buildContinuationPrompt', () => {
  it('substitutes {{turn}} and {{maxTurns}} in custom template', () => {
    const out = buildContinuationPrompt({
      ticket: makeTicket(),
      pipeline,
      customContinuation: 'Turn {{turn}} of {{maxTurns}} — continue',
      turn: 3,
      maxTurns: 10,
    });
    expect(out).toBe('Turn 3 of 10 — continue');
  });

  it('returns default guidance with current column label', () => {
    const out = buildContinuationPrompt({
      ticket: makeTicket(),
      pipeline,
      turn: 2,
      maxTurns: 5,
    });
    expect(out).toContain('continuation turn 2 of 5');
    expect(out).toContain('Your ticket is currently in column "Doing"');
    expect(out).toContain('Valid columns: Backlog, Doing, Done');
  });

  it('includes last run endReason when present', () => {
    const ticket = makeTicket({
      runs: [{ id: 'r1', startedAt: 0, endedAt: 1, endReason: 'max_turns' }],
    } as Partial<Ticket>);
    const out = buildContinuationPrompt({ ticket, pipeline, turn: 1, maxTurns: 5 });
    expect(out).toContain('previous run ended with reason: "max_turns"');
  });

  it('truncates very long last comments to 200 chars', () => {
    const long = 'x'.repeat(500);
    const ticket = makeTicket({
      comments: [{ id: 'c1', author: 'agent', content: long, createdAt: 0 }],
    } as Partial<Ticket>);
    const out = buildContinuationPrompt({ ticket, pipeline, turn: 1, maxTurns: 5 });
    expect(out).toContain('Last comment [agent]: ');
    expect(out).toContain('…');
    expect(out).not.toContain('x'.repeat(201));
  });

  it('omits last-comment line when there are no comments', () => {
    const out = buildContinuationPrompt({
      ticket: makeTicket({ comments: [] } as Partial<Ticket>),
      pipeline,
      turn: 1,
      maxTurns: 5,
    });
    expect(out).not.toContain('Last comment');
  });

  it('falls back gracefully when ticket is undefined', () => {
    const out = buildContinuationPrompt({ ticket: undefined, pipeline: null, turn: 1, maxTurns: 5 });
    expect(out).toContain('continuation turn 1 of 5');
    expect(out).toContain('Valid columns: ');
  });
});
