import { memo, useCallback } from 'react';
import { PiArrowsClockwiseBold, PiPlayFill, PiTrashFill, PiXBold } from 'react-icons/pi';

import { Button, cn, IconButton } from '@/renderer/ds';
import type { FleetTicket } from '@/shared/types';

import {
  TICKET_PRIORITY_COLORS,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_COLORS,
  TICKET_STATUS_LABELS,
} from './fleet-constants';
import { fleetApi } from './state';

export const FleetTicketCard = memo(({ ticket, isBlocked }: { ticket: FleetTicket; isBlocked: boolean }) => {
  const isOpen = ticket.status === 'open';
  const isDone = ticket.status === 'completed' || ticket.status === 'closed';

  const handleView = useCallback(() => {
    fleetApi.goToTicket(ticket.id);
  }, [ticket.id]);

  const handleClose = useCallback(() => {
    fleetApi.updateTicket(ticket.id, { status: 'closed' });
  }, [ticket.id]);

  const handleRemove = useCallback(() => {
    fleetApi.removeTicket(ticket.id);
  }, [ticket.id]);

  const handleRunTask = useCallback(() => {
    fleetApi.submitTicketTask(ticket.id);
  }, [ticket.id]);

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-surface-border bg-surface-raised">
      <div className={cn('size-2.5 rounded-full shrink-0', TICKET_STATUS_COLORS[ticket.status])} />

      <div className="flex-1 min-w-0">
        <p className="text-sm text-fg truncate">{ticket.title}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-fg-muted">{TICKET_STATUS_LABELS[ticket.status]}</span>
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
              TICKET_PRIORITY_COLORS[ticket.priority]
            )}
          >
            {TICKET_PRIORITY_LABELS[ticket.priority]}
          </span>
          {isBlocked && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium text-orange-400 bg-orange-400/10">
              Blocked
            </span>
          )}
          {ticket.loopEnabled && ticket.loopStatus === 'running' && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium text-green-400 bg-green-400/10">
              <PiArrowsClockwiseBold size={10} className="animate-spin" />
              {ticket.loopIteration}/{ticket.loopMaxIterations}
            </span>
          )}
          {ticket.loopEnabled && ticket.loopStatus && ticket.loopStatus !== 'running' && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium text-fg-muted bg-fg-muted/10">
              <PiArrowsClockwiseBold size={10} />
              {ticket.loopIteration}/{ticket.loopMaxIterations}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" onClick={handleView}>
          View
        </Button>
        {isOpen && !isBlocked && (
          <IconButton aria-label="Run task" icon={<PiPlayFill />} size="sm" onClick={handleRunTask} />
        )}
        {!isDone && <IconButton aria-label="Close ticket" icon={<PiXBold />} size="sm" onClick={handleClose} />}
        {isDone && <IconButton aria-label="Delete ticket" icon={<PiTrashFill />} size="sm" onClick={handleRemove} />}
      </div>
    </div>
  );
});
FleetTicketCard.displayName = 'FleetTicketCard';
