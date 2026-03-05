import { useDraggable } from '@dnd-kit/core';
import { memo, useCallback, useMemo } from 'react';
import { PiArrowsClockwiseBold, PiDotsSixVerticalBold } from 'react-icons/pi';

import { cn } from '@/renderer/ds';
import type { FleetColumn, FleetTicket } from '@/shared/types';

import { TICKET_PRIORITY_COLORS, TICKET_PRIORITY_LABELS } from './fleet-constants';
import { fleetApi } from './state';

const SUPERVISOR_STATUS_COLORS: Record<string, string> = {
  running: 'text-green-400 bg-green-400/10',
  retrying: 'text-yellow-400 bg-yellow-400/10',
  error: 'text-red-400 bg-red-400/10',
  idle: 'text-fg-muted bg-fg-muted/10',
};

const SUPERVISOR_STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  retrying: 'Retrying…',
  error: 'Error',
  idle: 'Idle',
};

export const FleetKanbanCard = memo(
  ({ ticket, column, isOverlay }: { ticket: FleetTicket; column: FleetColumn; isOverlay?: boolean }) => {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
      id: ticket.id,
      disabled: isOverlay,
    });

    const checklistProgress = useMemo(() => {
      const items = ticket.checklist[column.id];
      if (!items || items.length === 0) {
        return null;
      }
      const completed = items.filter((item) => item.completed).length;
      return { completed, total: items.length, pct: (completed / items.length) * 100 };
    }, [ticket.checklist, column.id]);

    const handleClick = useCallback(() => {
      fleetApi.goToTicket(ticket.id);
    }, [ticket.id]);

    const supervisorStatus = ticket.supervisorStatus;

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
          {supervisorStatus && supervisorStatus !== 'idle' && (
            <span
              className={cn(
                'flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                SUPERVISOR_STATUS_COLORS[supervisorStatus] ?? 'text-fg-muted bg-fg-muted/10'
              )}
            >
              {supervisorStatus === 'running' && <PiArrowsClockwiseBold size={10} className="animate-spin" />}
              {SUPERVISOR_STATUS_LABELS[supervisorStatus] ?? supervisorStatus}
            </span>
          )}
        </div>

        {/* Checklist progress */}
        {checklistProgress && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-[10px] text-fg-muted mb-0.5">
              <span>
                {checklistProgress.completed}/{checklistProgress.total} completed
              </span>
            </div>
            <div className="h-1 rounded-full bg-surface-border overflow-hidden">
              <div
                className="h-full rounded-full bg-accent-500 transition-all"
                style={{ width: `${checklistProgress.pct}%` }}
              />
            </div>
          </div>
        )}
      </div>
    );
  }
);
FleetKanbanCard.displayName = 'FleetKanbanCard';
