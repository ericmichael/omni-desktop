import { useDraggable } from '@dnd-kit/core';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiArrowsClockwiseBold, PiCheckCircleBold, PiDotsSixVerticalBold, PiXCircleBold } from 'react-icons/pi';

import { Button, cn } from '@/renderer/ds';
import type { FleetColumn, FleetTicket } from '@/shared/types';

import {
  PHASE_STATUS_COLORS,
  PHASE_STATUS_LABELS,
  TICKET_PRIORITY_COLORS,
  TICKET_PRIORITY_LABELS,
} from './fleet-constants';
import { fleetApi } from './state';

export const FleetKanbanCard = memo(
  ({ ticket, column, isOverlay }: { ticket: FleetTicket; column: FleetColumn; isOverlay?: boolean }) => {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
      id: ticket.id,
      disabled: isOverlay,
    });
    const [rejectNote, setRejectNote] = useState('');
    const [showRejectInput, setShowRejectInput] = useState(false);

    const currentPhase = useMemo(() => {
      if (!ticket.currentPhaseId) {
        return undefined;
      }
      return ticket.phases.find((p) => p.id === ticket.currentPhaseId);
    }, [ticket.currentPhaseId, ticket.phases]);

    const checklistProgress = useMemo(() => {
      const items = ticket.checklist[column.id];
      if (!items || items.length === 0) {
        return null;
      }
      const completed = items.filter((item) => item.completed).length;
      return { completed, total: items.length, pct: (completed / items.length) * 100 };
    }, [ticket.checklist, column.id]);

    const showGateActions = column.requiresApproval && currentPhase?.status === 'completed';

    const handleClick = useCallback(() => {
      fleetApi.goToTicket(ticket.id);
    }, [ticket.id]);

    const handleApprove = useCallback(() => {
      fleetApi.approvePhase(ticket.id);
    }, [ticket.id]);

    const handleShowReject = useCallback(() => {
      setShowRejectInput(true);
    }, []);

    const handleRejectNoteChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setRejectNote(e.target.value);
    }, []);

    const handleReject = useCallback(() => {
      if (rejectNote.trim()) {
        fleetApi.rejectPhase(ticket.id, rejectNote.trim());
        setRejectNote('');
        setShowRejectInput(false);
      }
    }, [ticket.id, rejectNote]);

    const handleCancelReject = useCallback(() => {
      setShowRejectInput(false);
      setRejectNote('');
    }, []);

    const handleRejectKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          handleReject();
        }
      },
      [handleReject]
    );

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
          {currentPhase && (
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                PHASE_STATUS_COLORS[currentPhase.status]
              )}
            >
              {PHASE_STATUS_LABELS[currentPhase.status]}
            </span>
          )}
          {currentPhase?.loop.status === 'running' && (
            <span className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium text-green-400 bg-green-400/10">
              <PiArrowsClockwiseBold size={10} className="animate-spin" />
              {currentPhase.loop.currentIteration}/{currentPhase.loop.maxIterations}
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

        {/* Gate actions */}
        {showGateActions && !showRejectInput && (
          <div className="flex items-center gap-1 mt-2">
            <Button size="sm" onClick={handleApprove}>
              <PiCheckCircleBold size={12} className="mr-1" />
              Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={handleShowReject}>
              <PiXCircleBold size={12} className="mr-1" />
              Reject
            </Button>
          </div>
        )}
        {showRejectInput && (
          <div className="flex flex-col gap-1 mt-2">
            <input
              type="text"
              value={rejectNote}
              onChange={handleRejectNoteChange}
              placeholder="Rejection reason..."
              className="w-full rounded-md border border-surface-border bg-surface px-2 py-1 text-xs text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
              onKeyDown={handleRejectKeyDown}
            />
            <div className="flex items-center gap-1">
              <Button size="sm" onClick={handleReject} isDisabled={!rejectNote.trim()}>
                Reject
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancelReject}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }
);
FleetKanbanCard.displayName = 'FleetKanbanCard';
