/**
 * Contract tests for supervisor IPC handlers — verifies all channels are
 * registered and delegate to the correct SupervisorOrchestrator methods.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerSupervisorHandlers } from '@/main/supervisor-handlers';
import { StubIpc } from '@/test-helpers/stub-ipc';

const EXPECTED_CHANNELS = [
  'project:ensure-supervisor-infra',
  'project:start-supervisor',
  'project:stop-supervisor',
  'project:send-supervisor-message',
  'project:reset-supervisor-session',
  'project:set-auto-dispatch',
  'project:get-active-wip-tickets',
  'project:get-ticket-workspace',
  'project:get-tasks',
  'project:finalize-ticket-cleanup',
];

const makeOrchestrator = () => ({
  ensureSupervisorInfraLocked: vi.fn(),
  startSupervisor: vi.fn(),
  stopSupervisor: vi.fn(),
  sendSupervisorMessage: vi.fn(),
  resetSupervisorSession: vi.fn(),
  setAutoDispatch: vi.fn(),
  getActiveWipTickets: vi.fn(() => []),
  getTicketWorkspaceLocked: vi.fn(() => '/tmp'),
  listTasks: vi.fn(() => []),
  finalizeTicketCleanup: vi.fn(async () => true),
});

describe('registerSupervisorHandlers', () => {
  it('registers all expected channels', () => {
    const ipc = new StubIpc();
    const channels = registerSupervisorHandlers(ipc, makeOrchestrator() as never);
    expect(channels).toEqual(EXPECTED_CHANNELS);
    for (const ch of EXPECTED_CHANNELS) {
      expect(ipc.handlers.has(ch), `missing handler for ${ch}`).toBe(true);
    }
  });

  it('project:ensure-supervisor-infra delegates with ticketId', () => {
    const ipc = new StubIpc();
    const orch = makeOrchestrator();
    registerSupervisorHandlers(ipc, orch as never);
    ipc.invoke('project:ensure-supervisor-infra', 't1');
    expect(orch.ensureSupervisorInfraLocked).toHaveBeenCalledWith('t1');
  });

  it('project:start-supervisor delegates with ticketId', () => {
    const ipc = new StubIpc();
    const orch = makeOrchestrator();
    registerSupervisorHandlers(ipc, orch as never);
    ipc.invoke('project:start-supervisor', 't1');
    expect(orch.startSupervisor).toHaveBeenCalledWith('t1');
  });

  it('project:stop-supervisor delegates with ticketId', () => {
    const ipc = new StubIpc();
    const orch = makeOrchestrator();
    registerSupervisorHandlers(ipc, orch as never);
    ipc.invoke('project:stop-supervisor', 't1');
    expect(orch.stopSupervisor).toHaveBeenCalledWith('t1');
  });

  it('project:send-supervisor-message delegates with ticketId and message', () => {
    const ipc = new StubIpc();
    const orch = makeOrchestrator();
    registerSupervisorHandlers(ipc, orch as never);
    ipc.invoke('project:send-supervisor-message', 't1', 'hello');
    expect(orch.sendSupervisorMessage).toHaveBeenCalledWith('t1', 'hello');
  });

  it('project:set-auto-dispatch delegates with projectId and enabled flag', () => {
    const ipc = new StubIpc();
    const orch = makeOrchestrator();
    registerSupervisorHandlers(ipc, orch as never);
    ipc.invoke('project:set-auto-dispatch', 'p1', true);
    expect(orch.setAutoDispatch).toHaveBeenCalledWith('p1', true);
  });

  it('project:get-active-wip-tickets delegates with no args', () => {
    const ipc = new StubIpc();
    const orch = makeOrchestrator();
    registerSupervisorHandlers(ipc, orch as never);
    ipc.invoke('project:get-active-wip-tickets');
    expect(orch.getActiveWipTickets).toHaveBeenCalledOnce();
  });

  it('project:get-tasks delegates with no args', () => {
    const ipc = new StubIpc();
    const orch = makeOrchestrator();
    registerSupervisorHandlers(ipc, orch as never);
    ipc.invoke('project:get-tasks');
    expect(orch.listTasks).toHaveBeenCalledOnce();
  });

  it('project:finalize-ticket-cleanup delegates with ticketId', () => {
    const ipc = new StubIpc();
    const orch = makeOrchestrator();
    registerSupervisorHandlers(ipc, orch as never);
    ipc.invoke('project:finalize-ticket-cleanup', 't1');
    expect(orch.finalizeTicketCleanup).toHaveBeenCalledWith('t1');
  });
});
