/**
 * Contract tests for inbox IPC handlers — verifies all 12 channels are
 * registered and delegate to the correct InboxManager methods.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerInboxHandlers } from '@/main/inbox-handlers';
import { StubIpc } from '@/test-helpers/stub-ipc';

const EXPECTED_CHANNELS = [
  'inbox:get-all',
  'inbox:get-active',
  'inbox:add',
  'inbox:update',
  'inbox:remove',
  'inbox:shape',
  'inbox:defer',
  'inbox:reactivate',
  'inbox:promote-to-ticket',
  'inbox:promote-to-project',
  'inbox:sweep',
  'inbox:gc-promoted',
];

const makeManager = () => ({
  getAll: vi.fn(() => []),
  getActive: vi.fn(() => []),
  add: vi.fn(() => ({ id: '1' })),
  update: vi.fn(),
  remove: vi.fn(),
  shape: vi.fn(),
  defer: vi.fn(),
  reactivate: vi.fn(),
  promoteToTicket: vi.fn(() => ({ id: 't1' })),
  promoteToProject: vi.fn(() => ({ id: 'p1' })),
  sweepExpired: vi.fn(() => 0),
  gcPromoted: vi.fn(() => 0),
});

describe('registerInboxHandlers', () => {
  it('registers all expected channels', () => {
    const ipc = new StubIpc();
    const channels = registerInboxHandlers(ipc, makeManager() as never);
    expect(channels).toEqual(EXPECTED_CHANNELS);
    for (const ch of EXPECTED_CHANNELS) {
      expect(ipc.handlers.has(ch), `missing handler for ${ch}`).toBe(true);
    }
  });

  it('inbox:get-all delegates to getAll()', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerInboxHandlers(ipc, mgr as never);
    ipc.invoke('inbox:get-all');
    expect(mgr.getAll).toHaveBeenCalledOnce();
  });

  it('inbox:add delegates with input arg', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerInboxHandlers(ipc, mgr as never);
    ipc.invoke('inbox:add', { title: 'Test' });
    expect(mgr.add).toHaveBeenCalledWith({ title: 'Test' });
  });

  it('inbox:update delegates with id and patch', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerInboxHandlers(ipc, mgr as never);
    ipc.invoke('inbox:update', 'id-1', { title: 'Updated' });
    expect(mgr.update).toHaveBeenCalledWith('id-1', { title: 'Updated' });
  });

  it('inbox:shape delegates with id and shaping', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerInboxHandlers(ipc, mgr as never);
    const shaping = { outcome: 'Done', appetite: 'small' as const };
    ipc.invoke('inbox:shape', 'id-1', shaping);
    expect(mgr.shape).toHaveBeenCalledWith('id-1', shaping);
  });

  it('inbox:promote-to-ticket delegates with id and opts', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerInboxHandlers(ipc, mgr as never);
    const opts = { projectId: 'p1' };
    ipc.invoke('inbox:promote-to-ticket', 'id-1', opts);
    expect(mgr.promoteToTicket).toHaveBeenCalledWith('id-1', opts);
  });

  it('inbox:promote-to-project delegates with id and opts', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerInboxHandlers(ipc, mgr as never);
    ipc.invoke('inbox:promote-to-project', 'id-1', { label: 'New' });
    expect(mgr.promoteToProject).toHaveBeenCalledWith('id-1', { label: 'New' });
  });

  it('inbox:sweep delegates to sweepExpired()', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerInboxHandlers(ipc, mgr as never);
    ipc.invoke('inbox:sweep');
    expect(mgr.sweepExpired).toHaveBeenCalledOnce();
  });

  it('inbox:gc-promoted delegates to gcPromoted()', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerInboxHandlers(ipc, mgr as never);
    ipc.invoke('inbox:gc-promoted');
    expect(mgr.gcPromoted).toHaveBeenCalledOnce();
  });
});
