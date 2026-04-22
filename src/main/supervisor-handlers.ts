/**
 * IPC handler registration for the supervisor surface — lifecycle, infra,
 * tasks, auto-dispatch, and WIP rollups.
 *
 * Extracted from `createProjectManager` (Sprint C4). Returns the list of
 * channel names registered so the caller can clean them up at shutdown.
 */
import type { SupervisorOrchestrator } from '@/main/supervisor-orchestrator';
import type { IIpcListener } from '@/shared/ipc-listener';

export function registerSupervisorHandlers(ipc: IIpcListener, supervisors: SupervisorOrchestrator): string[] {
  ipc.handle('project:ensure-supervisor-infra', (_, ticketId) => supervisors.ensureSupervisorInfraLocked(ticketId));
  ipc.handle('project:start-supervisor', (_, ticketId) => supervisors.startSupervisor(ticketId));
  ipc.handle('project:stop-supervisor', (_, ticketId) => supervisors.stopSupervisor(ticketId));
  ipc.handle('project:send-supervisor-message', (_, ticketId, message) =>
    supervisors.sendSupervisorMessage(ticketId, message)
  );
  ipc.handle('project:reset-supervisor-session', (_, ticketId) => supervisors.resetSupervisorSession(ticketId));
  ipc.handle('project:set-auto-dispatch', (_, projectId, enabled) => supervisors.setAutoDispatch(projectId, enabled));
  ipc.handle('project:get-supervisor-sandbox-status', (_, tabId) => supervisors.getSupervisorStatusForCodeTab(tabId));
  ipc.handle('project:get-active-wip-tickets', () => supervisors.getActiveWipTickets());
  ipc.handle('project:get-ticket-workspace', (_, ticketId) => supervisors.getTicketWorkspaceLocked(ticketId));
  ipc.handle('project:get-tasks', () => supervisors.listTasks());
  ipc.handle('project:finalize-ticket-cleanup', (_, ticketId) => supervisors.finalizeTicketCleanup(ticketId));

  return [
    'project:ensure-supervisor-infra',
    'project:start-supervisor',
    'project:stop-supervisor',
    'project:send-supervisor-message',
    'project:reset-supervisor-session',
    'project:set-auto-dispatch',
    'project:get-supervisor-sandbox-status',
    'project:get-active-wip-tickets',
    'project:get-ticket-workspace',
    'project:get-tasks',
    'project:finalize-ticket-cleanup',
  ];
}
