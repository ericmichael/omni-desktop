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
  // switch layouts. The tab owns its session id, so we never pass one in.
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
    ticketTitle: ticket.title,
    workspaceDir,
  });
  await persistedStoreApi.setKey('layoutMode', 'code');
};
