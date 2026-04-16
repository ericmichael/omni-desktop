/**
 * Contract tests for milestone IPC handlers — verifies all 4 channels are
 * registered and delegate to the correct MilestoneManager methods.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerMilestoneHandlers } from '@/main/milestone-handlers';
import { StubIpc } from '@/test-helpers/stub-ipc';

const EXPECTED_CHANNELS = [
  'milestone:get-items',
  'milestone:add-item',
  'milestone:update-item',
  'milestone:remove-item',
];

const makeManager = () => ({
  getByProject: vi.fn(() => []),
  add: vi.fn(() => ({ id: 'ms-1' })),
  update: vi.fn(),
  remove: vi.fn(),
});

describe('registerMilestoneHandlers', () => {
  it('registers all expected channels', () => {
    const ipc = new StubIpc();
    const channels = registerMilestoneHandlers(ipc, makeManager() as never);
    expect(channels).toEqual(EXPECTED_CHANNELS);
    for (const ch of EXPECTED_CHANNELS) {
      expect(ipc.handlers.has(ch), `missing handler for ${ch}`).toBe(true);
    }
  });

  it('milestone:get-items delegates with projectId', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerMilestoneHandlers(ipc, mgr as never);
    ipc.invoke('milestone:get-items', 'proj-1');
    expect(mgr.getByProject).toHaveBeenCalledWith('proj-1');
  });

  it('milestone:add-item delegates with item', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerMilestoneHandlers(ipc, mgr as never);
    const item = { projectId: 'p1', title: 'M1', description: '' };
    ipc.invoke('milestone:add-item', item);
    expect(mgr.add).toHaveBeenCalledWith(item);
  });

  it('milestone:update-item delegates with id and patch', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerMilestoneHandlers(ipc, mgr as never);
    ipc.invoke('milestone:update-item', 'ms-1', { title: 'Updated' });
    expect(mgr.update).toHaveBeenCalledWith('ms-1', { title: 'Updated' });
  });

  it('milestone:remove-item delegates with id', () => {
    const ipc = new StubIpc();
    const mgr = makeManager();
    registerMilestoneHandlers(ipc, mgr as never);
    ipc.invoke('milestone:remove-item', 'ms-1');
    expect(mgr.remove).toHaveBeenCalledWith('ms-1');
  });
});
