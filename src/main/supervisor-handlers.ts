/**
 * IPC handler registration for the supervisor surface — lifecycle, infra,
 * tasks, auto-dispatch, and WIP rollups.
 *
 * Takes a `resolve(event)` callback (see registerMilestoneHandlers) so the same
 * registration serves the single-manager Electron app and the per-tenant
 * server. Returns the channel names registered for cleanup.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupervisorOrchestrator } from '@/main/supervisor-orchestrator';
import type { IIpcListener } from '@/shared/ipc-listener';

export function registerSupervisorHandlers(
  ipc: IIpcListener,
  resolve: (event: unknown) => SupervisorOrchestrator
): string[] {
  const channels: string[] = [];
  const h = (ch: string, fn: (s: SupervisorOrchestrator, ...args: any[]) => unknown): void => {
    ipc.handle(ch, (event: unknown, ...args: any[]) => fn(resolve(event), ...args));
    channels.push(ch);
  };

  h('project:ensure-supervisor-infra', (s, ticketId) => s.ensureSupervisorInfraLocked(ticketId));
  h('project:start-supervisor', (s, ticketId, profileName) => s.startSupervisor(ticketId, profileName));
  h('project:stop-supervisor', (s, ticketId) => s.stopSupervisor(ticketId));
  h('project:send-supervisor-message', (s, ticketId, message) => s.sendSupervisorMessage(ticketId, message));
  h('project:reset-supervisor-session', (s, ticketId) => s.resetSupervisorSession(ticketId));
  h('project:set-auto-dispatch', (s, projectId, enabled) => s.setAutoDispatch(projectId, enabled));
  h('project:get-active-wip-tickets', (s) => s.getActiveWipTickets());
  h('project:get-ticket-workspace', (s, ticketId) => s.getTicketWorkspaceLocked(ticketId));
  h('project:get-tasks', (s) => s.listTasks());
  h('project:finalize-ticket-cleanup', (s, ticketId) => s.finalizeTicketCleanup(ticketId));

  return channels;
}
