import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiPencilSimpleBold, PiXBold } from 'react-icons/pi';

import { Button, cn, IconButton, SectionLabel, Select, Textarea } from '@/renderer/ds';
import type { Ticket, TicketPriority } from '@/shared/types';

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

  const availableBlockers = useMemo(() => {
    const blocked = new Set(ticket.blockedBy);
    return Object.values(tickets).filter((t) => t.id !== ticket.id && t.projectId === ticket.projectId && !blocked.has(t.id));
  }, [ticket, tickets]);

  const handlePriorityChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      void ticketApi.updateTicket(ticket.id, { priority: e.target.value as TicketPriority });
    },
    [ticket.id]
  );

  const handleAddBlocker = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const blockerId = e.target.value;
      if (!blockerId) return;
      void ticketApi.updateTicket(ticket.id, { blockedBy: [...ticket.blockedBy, blockerId] });
    },
    [ticket.id, ticket.blockedBy]
  );

  const handleRemoveBlocker = useCallback(
    (blockerId: string) => {
      void ticketApi.updateTicket(ticket.id, { blockedBy: ticket.blockedBy.filter((id) => id !== blockerId) });
    },
    [ticket.id, ticket.blockedBy]
  );

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
        <div className="flex items-center gap-1.5">
          <SectionLabel>Description</SectionLabel>
          {!editingDescription && (
            <IconButton
              aria-label="Edit description"
              icon={<PiPencilSimpleBold />}
              size="sm"
              onClick={handleStartEditDescription}
              className="sm:opacity-0 sm:group-hover/desc:opacity-100 sm:transition-opacity"
            />
          )}
        </div>
        {editingDescription ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={editDescription}
              onChange={handleEditDescriptionChange}
              onKeyDown={handleDescriptionKeyDown}
              autoFocus
              rows={5}
              maxHeight={400}
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
          <button onClick={handleStartEditDescription} className="text-sm text-fg-subtle italic text-left cursor-pointer hover:text-fg-muted transition-colors">
            Tap to add description
          </button>
        )}
      </div>

      {/* Priority */}
      <div className="flex flex-col gap-2">
        <SectionLabel>Priority</SectionLabel>
        <Select size="sm" value={ticket.priority} onChange={handlePriorityChange} className="w-full sm:w-40">
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </Select>
      </div>

      {/* Dependencies */}
      <div className="flex flex-col gap-2">
        <SectionLabel>Blocked By</SectionLabel>
        {blockerTickets.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {blockerTickets.map((blocker) => (
              <div key={blocker.id} className="flex items-center gap-2">
                <span
                  className={cn(
                    'text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0',
                    COLUMN_BADGE_COLORS[blocker.columnId ?? 'backlog'] ?? 'text-fg-muted bg-fg-muted/10'
                  )}
                >
                  {blocker.columnId ?? 'backlog'}
                </span>
                <span className="text-sm text-fg-muted flex-1 truncate">{blocker.title}</span>
                <IconButton
                  aria-label={`Remove blocker ${blocker.title}`}
                  icon={<PiXBold />}
                  size="sm"
                  onClick={() => handleRemoveBlocker(blocker.id)}
                  className="text-fg-subtle hover:text-red-400 shrink-0"
                />
              </div>
            ))}
          </div>
        )}
        {availableBlockers.length > 0 && (
          <Select size="sm" value="" onChange={handleAddBlocker} className="w-full sm:w-60">
            <option value="">Add dependency...</option>
            {availableBlockers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
        )}
        {blockerTickets.length === 0 && availableBlockers.length === 0 && (
          <p className="text-sm sm:text-xs text-fg-subtle">No tickets available to block on</p>
        )}
      </div>

      {/* Supervisor info */}
      {ticket.supervisorSessionId && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Supervisor</SectionLabel>
          <div className="text-sm sm:text-xs text-fg-muted">
            <p>Session: {ticket.supervisorSessionId}</p>
            {ticket.phase && <p>Phase: {ticket.phase}</p>}
          </div>
        </div>
      )}

      {/* Token usage */}
      {ticket.tokenUsage && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Token Usage</SectionLabel>
          <div className="flex items-center gap-4 text-sm sm:text-xs text-fg-muted">
            <span>In: {ticket.tokenUsage.inputTokens.toLocaleString()}</span>
            <span>Out: {ticket.tokenUsage.outputTokens.toLocaleString()}</span>
            <span>Total: {ticket.tokenUsage.totalTokens.toLocaleString()}</span>
          </div>
        </div>
      )}

      {/* Timestamps */}
      <div className="flex flex-col gap-1">
        <SectionLabel>Details</SectionLabel>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm sm:text-xs text-fg-muted">
          <span>Created {new Date(ticket.createdAt).toLocaleDateString()}</span>
          <span>Updated {new Date(ticket.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
});
TicketOverviewTab.displayName = 'TicketOverviewTab';
