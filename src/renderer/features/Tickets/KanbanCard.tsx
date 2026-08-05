import { useDraggable } from '@dnd-kit/core';
import { useStore } from '@nanostores/react';
import { ExternalLink, GitFork, GripVertical, Lock, Play, RefreshCw } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';

import { isDoneColumn } from '@/lib/pipeline-category';
import { cn } from '@/renderer/ds/cn';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/ds/ui/tooltip';
import { openTicketInCode } from '@/renderer/services/navigation';
import { isActivePhase } from '@/shared/ticket-phase';
import type { Ticket, TicketPhase } from '@/shared/types';

import { $pipeline, $tickets, ticketApi } from './state';
import { PHASE_LABELS, TICKET_PRIORITY_LABELS } from './ticket-constants';

const canStart = (phase: TicketPhase | undefined) => !phase || !isActivePhase(phase);

export const KanbanCard = memo(({ ticket, isOverlay }: { ticket: Ticket; isOverlay?: boolean }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: ticket.id,
    disabled: isOverlay,
  });

  const allTickets = useStore($tickets);
  const pipeline = useStore($pipeline);
  const unresolvedBlockers = useMemo(
    () =>
      ticket.blockedBy.filter((id) => {
        const blocker = allTickets[id];
        return blocker && !blocker.archivedAt && !isDoneColumn(pipeline, blocker.columnId);
      }).length,
    [ticket.blockedBy, allTickets, pipeline]
  );

  const handleClick = useCallback(() => {
    ticketApi.goToTicket(ticket.id);
  }, [ticket.id]);

  const handleStart = useCallback(() => {
    ticketApi.requestStartSupervisor(ticket.id);
  }, [ticket.id]);

  const handleOpen = useCallback(() => {
    ticketApi.ensureSupervisorInfra(ticket.id);
    openTicketInCode(ticket.id);
  }, [ticket.id]);

  const phase = ticket.phase;
  const titleText = ticket.title?.trim() ? ticket.title : 'Untitled';
  const hasTitle = Boolean(ticket.title?.trim());
  const branch = ticket.branch?.trim();
  const done = isDoneColumn(pipeline, ticket.columnId);

  return (
    <div
      ref={isOverlay ? undefined : setNodeRef}
      className={cn(
        'rounded-lg border border-border bg-card p-2.5 transition-shadow duration-150',
        isOverlay && 'shadow-lg',
        isDragging && !isOverlay && 'opacity-30'
      )}
    >
      <div className="flex items-start gap-1.5">
        {!isOverlay && (
          <div
            {...listeners}
            {...attributes}
            className="shrink-0 mt-0.5 cursor-grab text-muted-foreground touch-none active:cursor-grabbing hover:text-foreground"
          >
            <GripVertical className="size-4" />
          </div>
        )}
        {hasTitle ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                onClick={handleClick}
                className="h-auto min-w-0 flex-1 justify-start overflow-hidden rounded-none border-0 bg-transparent p-0 text-left font-normal hover:bg-transparent"
              >
                <span className="block min-w-0 max-w-full flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {titleText}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{titleText}</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            variant="ghost"
            onClick={handleClick}
            className="h-auto min-w-0 flex-1 justify-start overflow-hidden rounded-none border-0 bg-transparent p-0 text-left font-normal hover:bg-transparent"
          >
            <span className="block min-w-0 max-w-full flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {titleText}
            </span>
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1.5 mt-1.5">
        <div className="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
          <Badge variant="secondary">{TICKET_PRIORITY_LABELS[ticket.priority]}</Badge>
          {phase && phase !== 'idle' && !done && !ticket.archivedAt && (
            <Badge variant="secondary">
              {isActivePhase(phase) && <RefreshCw className="size-3" />}
              {PHASE_LABELS[phase]}
            </Badge>
          )}
          {branch && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="min-w-0 max-w-48 text-muted-foreground">
                  <GitFork />
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap min-w-0">{branch}</span>
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{branch}</TooltipContent>
            </Tooltip>
          )}
          {unresolvedBlockers > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="border-destructive/30 text-destructive"
                  aria-label={`Blocked by ${unresolvedBlockers}`}
                >
                  <Lock />
                  {unresolvedBlockers}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{`Blocked by ${unresolvedBlockers} task${unresolvedBlockers === 1 ? '' : 's'}`}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {!done && !ticket.archivedAt && canStart(phase) && (
          <div className="flex items-center shrink-0">
            <Button type="button" variant="ghost" size="icon-sm" onClick={handleOpen} aria-label="Chat">
              <ExternalLink />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={handleStart} aria-label="Ask Omni">
              <Play />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});
KanbanCard.displayName = 'KanbanCard';
