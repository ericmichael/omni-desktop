import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(() => Promise.resolve());
const on = vi.fn();

vi.mock('@/renderer/services/ipc', () => ({
  emitter: { invoke },
  ipc: { on },
}));

vi.mock('@/renderer/services/store', () => ({
  persistedStoreApi: {
    getKey: vi.fn(() => []),
    setKey: vi.fn(() => Promise.resolve()),
    $atom: { get: vi.fn(() => ({ tickets: [] })) },
  },
}));

vi.mock('@/renderer/features/Code/state', () => ({
  codeApi: { addTabForTicket: vi.fn(() => Promise.resolve()) },
}));

const makeActor = (ticketId: string) => ({
  ticketId,
  submit: vi.fn(() => Promise.resolve({ runId: 'run-1' })),
  send: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
  reset: vi.fn(() => Promise.resolve()),
});

describe('renderer supervisor bridge', () => {
  beforeEach(() => {
    invoke.mockClear();
    on.mockClear();
  });

  it('does not emit disconnected when an actor is replaced during effect churn', async () => {
    const { registerColumnActor } = await import('@/renderer/services/supervisor-bridge');
    const first = makeActor('ticket-replace');
    const second = makeActor('ticket-replace');

    const unregisterFirst = registerColumnActor(first);
    unregisterFirst();
    const unregisterSecond = registerColumnActor(second);
    await Promise.resolve();

    expect(invoke).not.toHaveBeenCalledWith('supervisor:event', {
      kind: 'disconnected',
      ticketId: 'ticket-replace',
    });

    unregisterSecond();
    await Promise.resolve();
  });

  it('emits disconnected when the registered actor is really removed', async () => {
    const { registerColumnActor } = await import('@/renderer/services/supervisor-bridge');
    const actor = makeActor('ticket-remove');

    const unregister = registerColumnActor(actor);
    unregister();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith('supervisor:event', {
      kind: 'disconnected',
      ticketId: 'ticket-remove',
    });
  });
});
