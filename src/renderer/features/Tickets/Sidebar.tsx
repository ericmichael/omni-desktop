import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PiPlusBold } from 'react-icons/pi';

import { cn, IconButton } from '@/renderer/ds';
import { $inboxItems } from '@/renderer/features/Inbox/state';
import { openTicketInCode } from '@/renderer/services/navigation';
import { persistedStoreApi } from '@/renderer/services/store';
import type { InboxItem, InboxItemId, Project } from '@/shared/types';

import { COLUMN_BADGE_COLORS } from './ticket-constants';
import { ProjectForm } from './ProjectForm';
import type { ActiveTicketEntry } from './state';
import { $activeTickets, $pipeline, $ticketsView, ticketApi } from './state';

const SidebarProjectItem = memo(
  ({
    project,
    isActive,
    activeTicketCount,
  }: {
    project: Project;
    isActive: boolean;
    activeTicketCount: number;
  }) => {
    const handleClick = useCallback(() => {
      ticketApi.goToProject(project.id);
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
  const { ticket, hasLiveTask } = entry;
  const pipeline = useStore($pipeline);

  const handleClick = useCallback(() => {
    openTicketInCode(ticket.id);
  }, [ticket.id]);

  const pipelineColumn = pipeline?.columns.find((c) => c.id === ticket.columnId);
  const columnLabel = pipelineColumn?.label ?? null;
  const columnBadgeColor = pipelineColumn ? (COLUMN_BADGE_COLORS[pipelineColumn.id] ?? '') : '';

  const phase = ticket.phase;
  const isRunning = phase != null && phase !== 'idle' && phase !== 'error' && phase !== 'completed';

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
        {(isRunning || hasLiveTask) && <span className="size-2 rounded-full bg-green-400 animate-pulse shrink-0" />}
      </div>
    </button>
  );
});
SidebarActiveTicketItem.displayName = 'SidebarActiveTicketItem';

const SidebarInboxItem = memo(
  ({ item, isActive, onSelect }: { item: InboxItem; isActive: boolean; onSelect: (id: InboxItemId) => void }) => {
    const handleClick = useCallback(() => onSelect(item.id), [item.id, onSelect]);

    return (
      <button
        onClick={handleClick}
        className={cn(
          'flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors cursor-pointer',
          isActive ? 'bg-accent-600/20 text-fg' : 'text-fg-muted hover:bg-white/5 hover:text-fg'
        )}
      >
        <span className="text-sm truncate flex-1 min-w-0">{item.title}</span>
      </button>
    );
  }
);
SidebarInboxItem.displayName = 'SidebarInboxItem';

export const TicketsSidebar = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const activeTickets = useStore($activeTickets);
  const view = useStore($ticketsView);
  const [formOpen, setFormOpen] = useState(false);

  const projects = store.projects;

  const ticketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const ticket of store.tickets) {
      counts[ticket.projectId] = (counts[ticket.projectId] ?? 0) + 1;
    }
    return counts;
  }, [store.tickets]);

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
          openTicketInCode(entry.ticket.id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTickets]);

  const inboxItemsMap = useStore($inboxItems);
  const openInboxItems = useMemo(
    () =>
      Object.values(inboxItemsMap)
        .filter((i) => i.status === 'open')
        .sort((a, b) => b.createdAt - a.createdAt),
    [inboxItemsMap]
  );

  const handleSelectInboxItem = useCallback((id: InboxItemId) => {
    ticketApi.goToInbox(id);
  }, []);

  const isInboxView = view.type === 'inbox';
  const selectedInboxItemId = isInboxView ? view.selectedItemId : undefined;

  return (
    <div className="flex flex-col h-full w-60 border-r border-surface-border bg-surface shrink-0">
      {/* Inbox section */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-border">
        <button onClick={() => ticketApi.goToInbox()} className="text-xs font-semibold text-fg-muted uppercase tracking-wider hover:text-fg transition-colors cursor-pointer">
          Inbox
        </button>
        {openInboxItems.length > 0 && <span className="text-xs text-fg-subtle">{openInboxItems.length}</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {openInboxItems.length === 0 ? (
          <p className="px-3 py-2 text-xs text-fg-subtle">No open items</p>
        ) : (
          openInboxItems.map((item) => (
            <SidebarInboxItem
              key={item.id}
              item={item}
              isActive={isInboxView && selectedInboxItemId === item.id}
              onSelect={handleSelectInboxItem}
            />
          ))
        )}
      </div>

      {/* Projects section */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-b border-surface-border">
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
              activeTicketCount={ticketCounts[project.id] ?? 0}
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
              isActive={store.activeTicketId === entry.ticket.id}
            />
          ))
        )}
      </div>

      <ProjectForm open={formOpen} onClose={handleCloseForm} />
    </div>
  );
});
TicketsSidebar.displayName = 'TicketsSidebar';
