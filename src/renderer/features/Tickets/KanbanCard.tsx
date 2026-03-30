import { useDraggable } from '@dnd-kit/core';
import { memo, useCallback } from 'react';
import { PiArrowsClockwiseBold, PiArrowSquareOutBold, PiDotsSixVerticalBold, PiPlayFill } from 'react-icons/pi';

import { cn } from '@/renderer/ds';
import { openTicketInCode } from '@/renderer/services/navigation';
import { isActivePhase } from '@/shared/ticket-phase';
import type { Ticket, TicketPhase } from '@/shared/types';

import { PHASE_COLORS, PHASE_LABELS, TICKET_PRIORITY_COLORS, TICKET_PRIORITY_LABELS } from './ticket-constants';
import { ticketApi } from './state';

const canStart = (phase: TicketPhase | undefined) => !phase || !isActivePhase(phase);

export const KanbanCard = memo(
  ({ ticket, isOverlay }: { ticket: Ticket; isOverlay?: boolean }) => {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
      id: ticket.id,
      disabled: isOverlay,
    });

    const handleClick = useCallback(() => {
      openTicketInCode(ticket.id);
    }, [ticket.id]);

    const handleStart = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        ticketApi.startSupervisor(ticket.id);
      },
      [ticket.id]
    );

    const handleOpen = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        ticketApi.ensureSupervisorInfra(ticket.id);
        openTicketInCode(ticket.id);
      },
      [ticket.id]
    );

    const phase = ticket.phase;

    return (
      <div
        ref={isOverlay ? undefined : setNodeRef}
        className={cn(
          'rounded-lg border border-surface-border bg-surface-raised p-2.5 transition-shadow group',
          isOverlay ? 'shadow-xl' : '',
          isDragging && !isOverlay && 'opacity-30'
        )}
      >
        {/* Title row with drag handle */}
        <div className="flex items-start gap-1.5">
          {!isOverlay && (
            <div
              {...listeners}
              {...attributes}
              className="shrink-0 mt-0.5 cursor-grab active:cursor-grabbing text-fg-muted hover:text-fg touch-none"
            >
              <PiDotsSixVerticalBold size={14} />
            </div>
          )}
          <button onClick={handleClick} className="flex-1 min-w-0 text-left cursor-pointer">
            <p className="text-sm text-fg truncate">{ticket.title}</p>
          </button>
        </div>

        {/* Badges + actions row */}
        <div className="flex items-center gap-1.5 mt-1.5">
          <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                TICKET_PRIORITY_COLORS[ticket.priority]
              )}
            >
              {TICKET_PRIORITY_LABELS[ticket.priority]}
            </span>
            {phase && phase !== 'idle' && (
              <span
                className={cn(
                  'flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                  PHASE_COLORS[phase] ?? 'text-fg-muted bg-fg-muted/10'
                )}
              >
                {isActivePhase(phase) && (
                  <PiArrowsClockwiseBold size={10} className="animate-spin" />
                )}
                {PHASE_LABELS[phase] ?? phase}
              </span>
            )}
          </div>
          {canStart(phase) && (
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={handleOpen}
                className="p-1 rounded text-fg-muted hover:text-fg hover:bg-surface-border/40 transition-colors cursor-pointer"
                title="Chat"
              >
                <PiArrowSquareOutBold size={12} />
              </button>
              <button
                onClick={handleStart}
                className="p-1 rounded text-fg-muted hover:text-accent hover:bg-accent/10 transition-colors cursor-pointer"
                title="Autopilot"
              >
                <PiPlayFill size={12} />
              </button>
            </div>
          )}
        </div>

      </div>
    );
  }
);
KanbanCard.displayName = 'KanbanCard';
