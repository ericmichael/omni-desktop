import { useDraggable } from '@dnd-kit/core';
import { memo, useCallback } from 'react';
import { PiArrowsClockwiseBold, PiDotsSixVerticalBold } from 'react-icons/pi';

import { cn } from '@/renderer/ds';
import type { FleetTicket } from '@/shared/types';

import { PHASE_COLORS, PHASE_LABELS, TICKET_PRIORITY_COLORS, TICKET_PRIORITY_LABELS } from './fleet-constants';
import { fleetApi } from './state';

export const FleetKanbanCard = memo(
  ({ ticket, isOverlay }: { ticket: FleetTicket; isOverlay?: boolean }) => {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
      id: ticket.id,
      disabled: isOverlay,
    });

    const handleClick = useCallback(() => {
      fleetApi.goToTicket(ticket.id);
    }, [ticket.id]);

    const phase = ticket.phase;

    return (
      <div
        ref={isOverlay ? undefined : setNodeRef}
        className={cn(
          'rounded-lg border border-surface-border bg-surface-raised p-2.5 transition-shadow',
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

        {/* Badges row */}
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
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
              {(phase === 'running' || phase === 'continuing' || phase === 'provisioning' || phase === 'connecting' || phase === 'session_creating') && (
                <PiArrowsClockwiseBold size={10} className="animate-spin" />
              )}
              {PHASE_LABELS[phase] ?? phase}
            </span>
          )}
        </div>

      </div>
    );
  }
);
FleetKanbanCard.displayName = 'FleetKanbanCard';
