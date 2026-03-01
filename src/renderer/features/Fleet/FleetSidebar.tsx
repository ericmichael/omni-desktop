import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiPlusBold } from 'react-icons/pi';

import { cn, IconButton } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { FleetProject } from '@/shared/types';

import { COLUMN_BADGE_COLORS, COLUMN_SHORT_LABELS } from './fleet-constants';
import { FleetProjectForm } from './FleetProjectForm';
import type { ActiveTicketEntry } from './state';
import { $activeTickets, $fleetView, fleetApi } from './state';

const ACTIVE_COLUMN_IDS = new Set(['spec', 'implementation', 'review', 'pr']);

const SidebarProjectItem = memo(
  ({
    project,
    isActive,
    activeTicketCount,
  }: {
    project: FleetProject;
    isActive: boolean;
    activeTicketCount: number;
  }) => {
    const handleClick = useCallback(() => {
      fleetApi.goToProject(project.id);
    }, [project.id]);

    const shortPath = useMemo(() => {
      const segments = project.workspaceDir.split('/').filter(Boolean);
      return segments.slice(-2).join('/');
    }, [project.workspaceDir]);

    return (
      <button
        onClick={handleClick}
        className={cn(
          'flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors cursor-pointer',
          isActive ? 'bg-accent-600/20 text-fg' : 'text-fg-muted hover:bg-white/5 hover:text-fg'
        )}
      >
        <div className="flex flex-col flex-1 min-w-0">
          <span className="text-sm truncate">{project.label}</span>
          <span className="text-[10px] text-fg-subtle truncate">{shortPath}</span>
        </div>
        {activeTicketCount > 0 && (
          <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-400/10 text-blue-400">
            {activeTicketCount}
          </span>
        )}
      </button>
    );
  }
);
SidebarProjectItem.displayName = 'SidebarProjectItem';

const SidebarActiveTicketItem = memo(({ entry, isActive }: { entry: ActiveTicketEntry; isActive: boolean }) => {
  const { ticket, hasLiveTask, currentPhase } = entry;

  const handleClick = useCallback(() => {
    fleetApi.goToTicket(ticket.id);
  }, [ticket.id]);

  const columnLabel = ticket.columnId ? (COLUMN_SHORT_LABELS[ticket.columnId] ?? ticket.columnId) : null;
  const columnBadgeColor = ticket.columnId ? (COLUMN_BADGE_COLORS[ticket.columnId] ?? '') : '';

  const loopRunning = currentPhase?.loop?.status === 'running';
  const loopLabel = loopRunning ? `${currentPhase.loop.currentIteration}/${currentPhase.loop.maxIterations}` : null;

  return (
    <button
      onClick={handleClick}
      className={cn(
        'flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors cursor-pointer',
        isActive ? 'bg-accent-600/20 text-fg' : 'text-fg-muted hover:bg-white/5 hover:text-fg'
      )}
    >
      {columnLabel && (
        <span className={cn('shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium', columnBadgeColor)}>
          {columnLabel}
        </span>
      )}
      <span className="text-sm truncate flex-1 min-w-0">{ticket.title}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        {loopLabel && <span className="text-[10px] font-mono text-fg-subtle">{loopLabel}</span>}
        {hasLiveTask && <span className="size-2 rounded-full bg-green-400 animate-pulse shrink-0" />}
      </div>
    </button>
  );
});
SidebarActiveTicketItem.displayName = 'SidebarActiveTicketItem';

export const FleetSidebar = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const activeTickets = useStore($activeTickets);
  const view = useStore($fleetView);
  const [formOpen, setFormOpen] = useState(false);

  const projects = store.fleetProjects;

  const activeTicketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const ticket of store.fleetTickets) {
      if (ticket.columnId && ACTIVE_COLUMN_IDS.has(ticket.columnId)) {
        counts[ticket.projectId] = (counts[ticket.projectId] ?? 0) + 1;
      }
    }
    return counts;
  }, [store.fleetTickets]);

  const handleOpenForm = useCallback(() => {
    setFormOpen(true);
  }, []);

  const handleCloseForm = useCallback(() => {
    setFormOpen(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
        return;
      }
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 9) {
        const entry = activeTickets[num - 1];
        if (entry) {
          e.preventDefault();
          fleetApi.goToTicket(entry.ticket.id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTickets]);

  return (
    <div className="flex flex-col h-full w-60 border-r border-surface-border bg-surface shrink-0">
      {/* Projects section */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-border">
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Projects</span>
        <IconButton aria-label="New project" icon={<PiPlusBold />} size="sm" onClick={handleOpenForm} />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {projects.length === 0 ? (
          <p className="px-3 py-2 text-xs text-fg-subtle">No projects yet</p>
        ) : (
          projects.map((project) => (
            <SidebarProjectItem
              key={project.id}
              project={project}
              isActive={view.type === 'project' && view.projectId === project.id}
              activeTicketCount={activeTicketCounts[project.id] ?? 0}
            />
          ))
        )}
      </div>

      {/* Active Tickets section */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-b border-surface-border">
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Active Tickets</span>
        {activeTickets.length > 0 && <span className="text-xs text-fg-subtle">{activeTickets.length}</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {activeTickets.length === 0 ? (
          <p className="px-3 py-2 text-xs text-fg-subtle">No active tickets</p>
        ) : (
          activeTickets.map((entry) => (
            <SidebarActiveTicketItem
              key={entry.ticket.id}
              entry={entry}
              isActive={view.type === 'ticket' && view.ticketId === entry.ticket.id}
            />
          ))
        )}
      </div>

      <FleetProjectForm open={formOpen} onClose={handleCloseForm} />
    </div>
  );
});
FleetSidebar.displayName = 'FleetSidebar';
