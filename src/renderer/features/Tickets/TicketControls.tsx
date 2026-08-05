import { useStore } from '@nanostores/react';
import { CircleCheck, Play, Plus, RefreshCw, Square, TriangleAlert } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo } from 'react';

import { categoryOf } from '@/lib/pipeline-category';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { $pipeline, $tasks, $tickets, ticketApi } from '@/renderer/features/Tickets/state';
import type { TicketId, TicketPhase } from '@/shared/types';

/** Shared hook for ticket automation state and handlers. */
const useTicketAutomation = (ticketId: TicketId) => {
  const tickets = useStore($tickets);
  const tasks = useStore($tasks);
  const ticket = tickets[ticketId];

  const supervisorTask = useMemo(() => {
    if (ticket?.supervisorTaskId && tasks[ticket.supervisorTaskId]) {
      return tasks[ticket.supervisorTaskId];
    }
    return Object.values(tasks).find((t) => t.ticketId === ticketId);
  }, [ticket, tasks, ticketId]);

  const isContainerLive =
    supervisorTask?.status.type === 'running' ||
    supervisorTask?.status.type === 'connecting' ||
    supervisorTask?.status.type === 'starting';

  const handleStart = useCallback(() => ticketApi.requestStartSupervisor(ticketId), [ticketId]);
  const handleStop = useCallback(() => ticketApi.stopSupervisor(ticketId), [ticketId]);
  const handleReset = useCallback(() => ticketApi.resetSupervisorSession(ticketId), [ticketId]);

  const phase: TicketPhase | undefined = ticket?.phase;

  return { phase, isContainerLive: !!isContainerLive, handleStart, handleStop, handleReset };
};

/** Column label badge for the ticket banner. */
export const TicketColumnBadge = memo(({ ticketId }: { ticketId: TicketId }) => {
  const tickets = useStore($tickets);
  const pipeline = useStore($pipeline);
  const ticket = tickets[ticketId];

  // Ensure pipeline is loaded — it's only fetched when visiting the kanban view,
  // so on a fresh load into the Code tab it would be null.
  useEffect(() => {
    if (!pipeline && ticket?.projectId) {
      void ticketApi.getPipeline(ticket.projectId);
    }
  }, [pipeline, ticket?.projectId]);

  const columnLabel = useMemo(() => {
    if (!ticket?.columnId || !pipeline) {
      return null;
    }
    return pipeline.columns.find((c) => c.id === ticket.columnId)?.label ?? null;
  }, [ticket?.columnId, pipeline]);

  if (!columnLabel) {
    return null;
  }

  return (
    <Badge variant="secondary" className="max-w-30 truncate rounded-md">
      {columnLabel}
    </Badge>
  );
});
TicketColumnBadge.displayName = 'TicketColumnBadge';

/** Header action: new session button (+ icon). */
export const TicketHeaderActions = memo(({ ticketId }: { ticketId: TicketId }) => {
  const { handleReset } = useTicketAutomation(ticketId);
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label="New session" onClick={handleReset}>
      <Plus className="size-4" />
    </Button>
  );
});
TicketHeaderActions.displayName = 'TicketHeaderActions';

/** Banner action: autopilot controls + phase indicator. */
export const TicketBannerActions = memo(({ ticketId }: { ticketId: TicketId }) => {
  const tickets = useStore($tickets);
  const pipeline = useStore($pipeline);
  const ticket = tickets[ticketId];
  const { phase, handleStart, handleStop } = useTicketAutomation(ticketId);

  if (!ticket || ticket.archivedAt || categoryOf(pipeline, ticket.columnId) === 'done') {
    return null;
  }

  const isAutonomous = phase === 'running';
  const isProvisioning = phase === 'provisioning' || phase === 'connecting' || phase === 'session_creating';
  const isError = phase === 'error';
  const isCompleted = phase === 'completed';

  if (isAutonomous) {
    return (
      <>
        <RefreshCw className={`size-3 animate-spin ${'text-success'}`} />
        <span className="text-xs font-medium text-success">Working</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Stop" onClick={handleStop}>
          <Square className="size-4" />
        </Button>
      </>
    );
  }
  if (isProvisioning) {
    return <Spinner />;
  }
  if (isError) {
    return (
      <>
        <TriangleAlert className={`size-3 ${'text-destructive'}`} />
        <Button size="sm" onClick={handleStart}>
          <Play className="size-4" />
          Retry
        </Button>
      </>
    );
  }
  if (isCompleted) {
    return (
      <>
        <CircleCheck className={`size-3 ${'text-success'}`} />
        <span className="text-xs font-medium text-success">Done</span>
      </>
    );
  }
  // Idle — offer the user-facing task action. Environment selection is a
  // project-level advanced setting, not something users repeat per run.
  return (
    <Button size="sm" onClick={handleStart}>
      <Play className="size-4" />
      Start task
    </Button>
  );
});
TicketBannerActions.displayName = 'TicketBannerActions';

/** Combined controls (legacy export). */
export const CodeTicketControls = memo(({ ticketId }: { ticketId: TicketId }) => {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <TicketHeaderActions ticketId={ticketId} />
      <TicketBannerActions ticketId={ticketId} />
    </div>
  );
});
CodeTicketControls.displayName = 'CodeTicketControls';
