import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo } from 'react';

import { persistedStoreApi } from '@/renderer/services/store';

import { FleetTicketDetail } from './FleetTicketDetail';
import { $fleetPipeline, $fleetTickets, $fleetView, fleetApi } from './state';

/**
 * Focus mode: project-scoped single-ticket work view.
 * Shows a project header bar, then the active ticket full-width.
 * If no project is selected, prompts to pick one from the sidebar.
 */
export const FleetFocusView = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const view = useStore($fleetView);
  const tickets = useStore($fleetTickets);
  const pipeline = useStore($fleetPipeline);
  const activeTicketId = store.activeFleetTicketId;

  // Ensure tickets are loaded for the selected project
  const projectId = view.type === 'project' ? view.projectId : null;
  const project = useMemo(
    () => (projectId ? store.fleetProjects.find((p) => p.id === projectId) : undefined),
    [store.fleetProjects, projectId]
  );

  useEffect(() => {
    if (!projectId || !project) {
      return;
    }
    fleetApi.fetchTickets(projectId);
    fleetApi.getPipeline(projectId);
  }, [projectId, project]);

  // Get tickets for this project grouped by column
  const projectTickets = useMemo(() => {
    if (!projectId) {
      return [];
    }
    return Object.values(tickets).filter((t) => t.projectId === projectId);
  }, [tickets, projectId]);

  const handleSelectTicket = useCallback((ticketId: string) => {
    persistedStoreApi.setKey('activeFleetTicketId', ticketId);
  }, []);

  // No project selected
  if (!projectId || !project) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-fg-muted text-sm">Select a project from the sidebar</p>
      </div>
    );
  }

  const activeTicket = activeTicketId ? tickets[activeTicketId] : undefined;
  const hasActiveTicket = activeTicket && activeTicket.projectId === projectId;

  // Project selected but no ticket — show ticket picker
  if (!hasActiveTicket) {
    return (
      <div className="flex flex-col w-full h-full">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-border shrink-0">
          <span className="text-sm font-semibold text-fg">{project.label}</span>
          <span className="text-xs text-fg-subtle">— select a ticket</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          <div className="flex flex-col gap-1 max-w-lg">
            {pipeline?.columns.map((col) => {
              const colTickets = projectTickets.filter((t) => t.columnId === col.id);
              if (colTickets.length === 0) {
                return null;
              }
              return (
                <div key={col.id} className="mb-3">
                  <div className="text-[10px] font-semibold text-fg-muted uppercase tracking-wider mb-1 px-1">
                    {col.label}
                  </div>
                  {colTickets.map((t) => (
                    <button
                      key={t.id}
                      onClick={handleSelectTicket.bind(null, t.id)}
                      className="w-full text-left px-3 py-2 rounded-md text-sm text-fg hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      {t.title}
                    </button>
                  ))}
                </div>
              );
            })}
            {projectTickets.length === 0 && (
              <p className="text-fg-subtle text-sm px-1">No tickets in this project</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Active ticket — show full detail
  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-border shrink-0">
        <span className="text-sm font-semibold text-fg">{project.label}</span>
      </div>
      <div className="flex-1 min-h-0">
        <FleetTicketDetail key={activeTicketId} ticketId={activeTicketId!} />
      </div>
    </div>
  );
});
FleetFocusView.displayName = 'FleetFocusView';
