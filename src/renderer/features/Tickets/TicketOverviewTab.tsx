import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiPencilSimpleBold } from 'react-icons/pi';

import { Button, cn, IconButton } from '@/renderer/ds';
import type { Ticket } from '@/shared/types';

import { COLUMN_BADGE_COLORS } from './ticket-constants';
import { $tickets, ticketApi } from './state';

type TicketOverviewTabProps = {
  ticket: Ticket;
};

export const TicketOverviewTab = memo(({ ticket }: TicketOverviewTabProps) => {
  const tickets = useStore($tickets);
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
      void ticketApi.updateTicket(ticket.id, { description: editDescription });
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

      {/* Supervisor info */}
      {ticket.supervisorSessionId && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-fg">Supervisor</span>
          <div className="text-xs text-fg-muted">
            <p>Session: {ticket.supervisorSessionId}</p>
            {ticket.phase && <p>Phase: {ticket.phase}</p>}
          </div>
        </div>
      )}

      {/* Token usage */}
      {ticket.tokenUsage && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-fg">Token Usage</span>
          <div className="flex items-center gap-4 text-xs text-fg-muted">
            <span>In: {ticket.tokenUsage.inputTokens.toLocaleString()}</span>
            <span>Out: {ticket.tokenUsage.outputTokens.toLocaleString()}</span>
            <span>Total: {ticket.tokenUsage.totalTokens.toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
});
TicketOverviewTab.displayName = 'TicketOverviewTab';
