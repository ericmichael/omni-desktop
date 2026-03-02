import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiPencilSimpleBold } from 'react-icons/pi';

import { Button, cn, IconButton } from '@/renderer/ds';
import type { FleetPipeline, FleetTicket } from '@/shared/types';

import { COLUMN_BADGE_COLORS } from './fleet-constants';
import { $fleetTickets, fleetApi } from './state';

type FleetTicketOverviewTabProps = {
  ticket: FleetTicket;
  pipeline: FleetPipeline | null;
};

export const FleetTicketOverviewTab = memo(({ ticket, pipeline }: FleetTicketOverviewTabProps) => {
  const tickets = useStore($fleetTickets);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editDescription, setEditDescription] = useState('');

  const blockerTickets = useMemo(() => {
    return ticket.blockedBy.flatMap((id) => {
      const t = tickets[id];
      return t ? [t] : [];
    });
  }, [ticket, tickets]);

  const handleStartEditDescription = useCallback(() => {
    setEditDescription(ticket.description);
    setEditingDescription(true);
  }, [ticket]);

  const handleEditDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditDescription(e.target.value);
  }, []);

  const handleSaveDescription = useCallback(() => {
    if (editDescription !== ticket.description) {
      void fleetApi.updateTicket(ticket.id, { description: editDescription });
    }
    setEditingDescription(false);
  }, [editDescription, ticket]);

  const handleDescriptionKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setEditingDescription(false);
    }
  }, []);

  const handleCancelEditDescription = useCallback(() => {
    setEditingDescription(false);
  }, []);

  // Checklist progress across all columns
  const checklistSummary = useMemo(() => {
    if (!pipeline) {
      return [];
    }
    return pipeline.columns
      .map((col) => {
        const items = ticket.checklist[col.id];
        if (!items || items.length === 0) {
          return null;
        }
        const completed = items.filter((item) => item.completed).length;
        return { columnId: col.id, label: col.label, completed, total: items.length };
      })
      .filter(Boolean) as Array<{ columnId: string; label: string; completed: number; total: number }>;
  }, [ticket, pipeline]);

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {/* Description */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 group/desc">
          <span className="text-sm font-medium text-fg">Description</span>
          {!editingDescription && (
            <IconButton
              aria-label="Edit description"
              icon={<PiPencilSimpleBold />}
              size="sm"
              onClick={handleStartEditDescription}
              className="opacity-0 group-hover/desc:opacity-100 transition-opacity"
            />
          )}
        </div>
        {editingDescription ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={editDescription}
              onChange={handleEditDescriptionChange}
              onKeyDown={handleDescriptionKeyDown}
              autoFocus
              rows={5}
              className="w-full rounded-md border border-accent-500 bg-surface px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none resize-y"
              placeholder="Ticket description..."
            />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={handleSaveDescription}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancelEditDescription}>
                Cancel
              </Button>
            </div>
          </div>
        ) : ticket.description ? (
          <p className="text-sm text-fg-muted whitespace-pre-wrap">{ticket.description}</p>
        ) : (
          <p className="text-sm text-fg-subtle italic">No description</p>
        )}
      </div>

      {/* Dependencies */}
      {blockerTickets.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-fg">Blocked By</span>
          <div className="flex flex-col gap-1">
            {blockerTickets.map((blocker) => (
              <div key={blocker.id} className="flex items-center gap-2 text-sm">
                <span
                  className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                    COLUMN_BADGE_COLORS[blocker.columnId ?? 'backlog'] ?? 'text-fg-muted bg-fg-muted/10'
                  )}
                >
                  {blocker.columnId ?? 'backlog'}
                </span>
                <span className="text-fg-muted">{blocker.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Checklist Progress */}
      {checklistSummary.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-fg">Checklist Progress</span>
          <div className="flex flex-col gap-2">
            {checklistSummary.map((entry) => (
              <div key={entry.columnId} className="flex items-center gap-3">
                <span
                  className={cn(
                    'text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0 w-20 text-center',
                    COLUMN_BADGE_COLORS[entry.columnId] ?? 'text-fg-muted bg-fg-muted/10'
                  )}
                >
                  {entry.label}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-surface-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent-500 transition-all"
                    style={{ width: `${(entry.completed / entry.total) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-fg-muted shrink-0">
                  {entry.completed}/{entry.total}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Supervisor info */}
      {ticket.supervisorSessionId && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-fg">Supervisor</span>
          <div className="text-xs text-fg-muted">
            <p>Session: {ticket.supervisorSessionId}</p>
            {ticket.supervisorStatus && <p>Status: {ticket.supervisorStatus}</p>}
          </div>
        </div>
      )}
    </div>
  );
});
FleetTicketOverviewTab.displayName = 'FleetTicketOverviewTab';
