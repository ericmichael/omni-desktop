import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(() => Promise.resolve());
const on = vi.fn();
const getKey = vi.fn(() => []);
const setKey = vi.fn(() => Promise.resolve());
const atomGet = vi.fn(() => ({ tickets: [] }));
const addTabForTicket = vi.fn(() => Promise.resolve());
const setTabProfile = vi.fn(() => Promise.resolve());

vi.mock('@/renderer/services/ipc', () => ({
  emitter: { invoke },
  ipc: { on },
}));

vi.mock('@/renderer/services/store', () => ({
  persistedStoreApi: {
    getKey,
    setKey,
    $atom: { get: atomGet },
  },
}));

vi.mock('@/renderer/features/Code/state', () => ({
  codeApi: { addTabForTicket, setTabProfile },
}));

const makeActor = (ticketId: string) => ({
  ticketId,
  submit: vi.fn(() => Promise.resolve({ runId: 'run-1' })),
  goalStart: vi.fn(() => Promise.resolve()),
  goalStop: vi.fn(() => Promise.resolve()),
  send: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
  reset: vi.fn(() => Promise.resolve()),
});

describe('renderer supervisor bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    invoke.mockClear();
    on.mockClear();
    getKey.mockReset();
    getKey.mockReturnValue([]);
    setKey.mockClear();
    atomGet.mockReset();
    atomGet.mockReturnValue({ tickets: [] });
    addTabForTicket.mockClear();
    setTabProfile.mockClear();
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

  it('creates a ticket tab with the requested sandbox profile', async () => {
    const { startSupervisorBridge } = await import('@/renderer/services/supervisor-bridge');
    atomGet.mockReturnValue({ tickets: [{ id: 't1', projectId: 'p1', title: 'Ticket one' }] } as never);
    startSupervisorBridge();
    const dispatch = on.mock.calls.find(([channel]) => channel === 'supervisor:dispatch')?.[1];

    dispatch('req-1', { kind: 'ensure-column', ticketId: 't1', workspaceDir: '/ws', profileName: 'aci' });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(addTabForTicket).toHaveBeenCalledWith('t1', 'p1', {
      ticketTitle: 'Ticket one',
      workspaceDir: '/ws',
      profileName: 'aci',
    });
    expect(invoke).toHaveBeenCalledWith('supervisor:dispatch-result', 'req-1', true, {}, undefined);
  });

  it('updates an existing ticket tab to the requested sandbox profile', async () => {
    const { startSupervisorBridge } = await import('@/renderer/services/supervisor-bridge');
    getKey.mockImplementation(((key: string) => {
      if (key === 'codeTabs') {
        return [{ id: 'tab-1', ticketId: 't1', profileName: 'host' }];
      }
      return [];
    }) as never);
    startSupervisorBridge();
    const dispatch = on.mock.calls.find(([channel]) => channel === 'supervisor:dispatch')?.[1];

    dispatch('req-2', { kind: 'ensure-column', ticketId: 't1', profileName: 'devbox' });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(setTabProfile).toHaveBeenCalledWith('tab-1', 'devbox');
    expect(addTabForTicket).not.toHaveBeenCalled();
    expect(setKey).toHaveBeenCalledWith('activeCodeTabId', 'tab-1');
  });
});
