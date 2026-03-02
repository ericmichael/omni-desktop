import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo } from 'react';
import { PiArrowsClockwiseBold, PiTrashFill } from 'react-icons/pi';

import { Button, cn } from '@/renderer/ds';
import type { FleetTicket } from '@/shared/types';

import { COLUMN_BADGE_COLORS, TICKET_PRIORITY_COLORS, TICKET_PRIORITY_LABELS } from './fleet-constants';
import { $fleetPipeline, fleetApi } from './state';

export const FleetTicketCard = memo(({ ticket, isBlocked }: { ticket: FleetTicket; isBlocked: boolean }) => {
  const pipeline = useStore($fleetPipeline);

  const columnLabel = useMemo(() => {
    if (!ticket.columnId || !pipeline) {
      return null;
    }
    return pipeline.columns.find((c) => c.id === ticket.columnId)?.label ?? null;
  }, [ticket.columnId, pipeline]);

  const handleView = useCallback(() => {
    fleetApi.goToTicket(ticket.id);
  }, [ticket.id]);

  const handleRemove = useCallback(() => {
    fleetApi.removeTicket(ticket.id);
  }, [ticket.id]);

  const supervisorStatus = ticket.supervisorStatus;

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-surface-border bg-surface-raised">
      {/* Column badge */}
      {ticket.columnId && columnLabel ? (
        <span
          className={cn(
            'text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
            COLUMN_BADGE_COLORS[ticket.columnId] ?? 'text-fg-muted bg-fg-muted/10'
          )}
        >
          {columnLabel}
        </span>
      ) : (
        <div className="size-2.5 rounded-full shrink-0 bg-fg-muted/30" />
      )}

      <div className="flex-1 min-w-0">
        <p className="text-sm text-fg truncate">{ticket.title}</p>
        <div className="flex items-center gap-2 mt-0.5">
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
          {supervisorStatus === 'running' && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium text-green-400 bg-green-400/10">
              <PiArrowsClockwiseBold size={10} className="animate-spin" />
              Running
            </span>
          )}
          {supervisorStatus === 'error' && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium text-red-400 bg-red-400/10">
              Error
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" onClick={handleView}>
          View
        </Button>
        <Button size="sm" variant="ghost" onClick={handleRemove}>
          <PiTrashFill size={12} />
        </Button>
      </div>
    </div>
  );
});
FleetTicketCard.displayName = 'FleetTicketCard';
