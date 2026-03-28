import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { persistedStoreApi } from '@/renderer/services/store';
import { isActivePhase } from '@/shared/ticket-phase';
import type { FleetTicketId } from '@/shared/types';

import { FleetTicketDetail } from './FleetTicketDetail';
import { $fleetTickets, fleetApi } from './state';

const COLUMN_WIDTH = 520;
const EXPANDED_COLUMN_WIDTH = 920;

export const FleetDeck = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const tickets = useStore($fleetTickets);

  // Fetch tickets for all projects on mount
  useEffect(() => {
    for (const project of store.fleetProjects) {
      void fleetApi.fetchTickets(project.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.fleetProjects.length]);

  const openTicketIds = (store.fleetOpenTicketIds ?? []) as FleetTicketId[];

  // Show explicitly opened tickets + any with active phases (deduplicated, opened first)
  const visibleTicketIds = useMemo(() => {
    const seen = new Set<FleetTicketId>();
    const result: FleetTicketId[] = [];
    // Explicitly opened tickets first (user-ordered)
    for (const id of openTicketIds) {
      if (tickets[id] && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    // Then any active-phase tickets not already included
    for (const id of Object.keys(tickets) as FleetTicketId[]) {
      const phase = tickets[id]?.phase;
      if (phase && isActivePhase(phase) && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    return result;
  }, [tickets, openTicketIds]);
  const [expandedTicketId, setExpandedTicketId] = useState<FleetTicketId | null>(null);

  const handleToggleExpand = useCallback((id: FleetTicketId) => {
    setExpandedTicketId((current) => (current === id ? null : id));
  }, []);

  // Cmd/Ctrl+E to expand active column
  const activeTicketId = store.activeFleetTicketId ?? visibleTicketIds[0] ?? null;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable =
        target?.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
      if (isEditable || !activeTicketId) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        setExpandedTicketId((current) => (current === activeTicketId ? null : activeTicketId));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTicketId]);

  if (visibleTicketIds.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-fg-muted text-sm">Start a run on a ticket to see it here</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-x-auto overflow-y-hidden">
      <div className="flex h-full min-w-max">
        {visibleTicketIds.map((id) => {
          const ticket = tickets[id];
          if (!ticket) {
            return null;
          }
          return (
            <div
              key={id}
              style={{ width: expandedTicketId === id ? EXPANDED_COLUMN_WIDTH : COLUMN_WIDTH }}
              className="h-full flex-shrink-0 border-r border-surface-border"
            >
              <FleetTicketDetail
                ticketId={id}
                compact
                isExpanded={expandedTicketId === id}
                onToggleExpand={handleToggleExpand.bind(null, id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});
FleetDeck.displayName = 'FleetDeck';
