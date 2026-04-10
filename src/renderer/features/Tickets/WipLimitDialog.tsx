import { memo, useCallback, useEffect, useState } from 'react';
import { PiStopFill } from 'react-icons/pi';

import { Button, cn } from '@/renderer/ds';
import { APPETITE_COLORS, APPETITE_LABELS } from '@/renderer/features/Inbox/shaping-constants';
import { persistedStoreApi } from '@/renderer/services/store';
import type { Ticket, TicketId } from '@/shared/types';

import { PHASE_COLORS, PHASE_LABELS } from './ticket-constants';
import { ticketApi } from './state';

type WipLimitDialogProps = {
  /** The ticket the user is trying to start. */
  pendingTicket: Ticket;
  /** Currently active WIP tickets. */
  activeTickets: Ticket[];
  /** Called when the user picks a ticket to drop. */
  onDrop: (droppedTicketId: TicketId) => void;
  /** Called when the user abandons the attempt. */
  onCancel: () => void;
};

export const WipLimitDialog = memo(
  ({ pendingTicket, activeTickets, onDrop, onCancel }: WipLimitDialogProps) => {
    const wipLimit = persistedStoreApi.$atom.get().wipLimit ?? 3;

    const handleDrop = useCallback(
      (ticketId: TicketId) => {
        void ticketApi.stopSupervisor(ticketId);
        onDrop(ticketId);
      },
      [onDrop]
    );

    // Close on Escape
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onCancel();
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [onCancel]);

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="w-full max-w-lg mx-4 rounded-2xl border border-surface-border bg-surface-raised shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="px-5 pt-5 pb-3">
            <h2 className="text-base font-semibold text-fg">
              WIP limit reached ({wipLimit} of {wipLimit})
            </h2>
            <p className="text-sm text-fg-muted mt-1">
              To start <span className="text-fg font-medium">{pendingTicket.title}</span>,
              stop one of your active items.
            </p>
          </div>

          {/* Active tickets */}
          <div className="flex flex-col gap-2 px-5 pb-3">
            {activeTickets.map((ticket) => (
              <div
                key={ticket.id}
                className="flex items-center gap-3 rounded-xl bg-surface p-3 border border-surface-border"
              >
                <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                  <span className="text-sm text-fg truncate">{ticket.title}</span>
                  <div className="flex items-center gap-1.5">
                    {ticket.phase && (
                      <span
                        className={cn(
                          'text-xs px-1.5 py-0.5 rounded-full font-medium',
                          PHASE_COLORS[ticket.phase] ?? 'text-fg-muted bg-fg-muted/10'
                        )}
                      >
                        {PHASE_LABELS[ticket.phase] ?? ticket.phase}
                      </span>
                    )}
                    {ticket.shaping?.appetite && (
                      <span
                        className={cn(
                          'text-xs px-1.5 py-0.5 rounded-full font-medium',
                          APPETITE_COLORS[ticket.shaping.appetite]
                        )}
                      >
                        {APPETITE_LABELS[ticket.shaping.appetite]}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => handleDrop(ticket.id)}
                >
                  <PiStopFill size={12} className="mr-1" />
                  Stop
                </Button>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="flex justify-end px-5 py-3 border-t border-surface-border">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Never mind
            </Button>
          </div>
        </div>
      </div>
    );
  }
);
WipLimitDialog.displayName = 'WipLimitDialog';
