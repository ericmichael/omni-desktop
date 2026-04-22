import { codeApi } from '@/renderer/features/Code/state';
import { $tickets, ticketApi } from '@/renderer/features/Tickets/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { TicketId } from '@/shared/types';

/**
 * In-flight openTicketInCode promises keyed by ticketId, so rapid repeat clicks
 * (chat button + autopilot button, double-click, etc.) coalesce into a single
 * tab creation instead of racing past the dedup check.
 */
const inflight = new Map<TicketId, Promise<void>>();

/**
 * Open a ticket in the Code tab. Creates or focuses the tab, then
 * switches to the Code layout.
 */
export const openTicketInCode = (ticketId: TicketId): Promise<void> => {
  const existing = inflight.get(ticketId);
  if (existing) {
    return existing;
  }
  const promise = runOpenTicketInCode(ticketId).finally(() => {
    inflight.delete(ticketId);
  });
  inflight.set(ticketId, promise);
  return promise;
};

const runOpenTicketInCode = async (ticketId: TicketId): Promise<void> => {
  // Fast path: if a tab for this ticket already exists, just focus it and
  // switch layouts. Skips the workspace-resolution round-trip (which can
  // create a worktree lock) and avoids spawning a duplicate column.
  const tabs = persistedStoreApi.getKey('codeTabs') ?? [];
  const existing = tabs.find((t) => t.ticketId === ticketId);
  if (existing) {
    await persistedStoreApi.setKey('activeCodeTabId', existing.id);
    await persistedStoreApi.setKey('layoutMode', 'code');
    return;
  }

  // Ensure the ticket is in the in-memory map
  let ticket = $tickets.get()[ticketId];
  if (!ticket) {
    const persisted = persistedStoreApi.$atom.get().tickets.find((t) => t.id === ticketId);
    if (!persisted) {
      return;
    }
    $tickets.setKey(ticketId, persisted);
    ticket = persisted;
  }
  // Pre-fetch all tickets for this project
  await ticketApi.fetchTickets(ticket.projectId);
  await ticketApi.fetchTasks();
  const workspaceDir = await ticketApi.getTicketWorkspace(ticketId);

  await codeApi.addTabForTicket(ticketId, ticket.projectId, {
    sessionId: ticket.supervisorSessionId,
    ticketTitle: ticket.title,
    workspaceDir,
  });
  await persistedStoreApi.setKey('layoutMode', 'code');
};

/**
 * Subscribe to ticket changes and sync supervisorSessionId to linked Code tabs.
 */
const startSessionSync = (): void => {
  // Track previous session IDs so we only sync on actual changes
  const prevSessionIds = new Map<TicketId, string | undefined>();

  $tickets.subscribe((tickets) => {
    const codeTabs = persistedStoreApi.getKey('codeTabs') ?? [];
    for (const tab of codeTabs) {
      if (!tab.ticketId) {
continue;
}
      const ticket = tickets[tab.ticketId];
      if (!ticket) {
continue;
}
      const prev = prevSessionIds.get(tab.ticketId);
      if (ticket.supervisorSessionId !== prev) {
        prevSessionIds.set(tab.ticketId, ticket.supervisorSessionId);
        if (ticket.supervisorSessionId && ticket.supervisorSessionId !== tab.sessionId) {
          codeApi.setTabSessionId(tab.id, ticket.supervisorSessionId);
        }
      }
    }
  });
};

startSessionSync();
