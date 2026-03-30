import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo } from 'react';
import {
  PiArrowsClockwiseBold,
  PiCheckCircleBold,
  PiPlayFill,
  PiPlusBold,
  PiStopFill,
  PiWarningCircleBold,
} from 'react-icons/pi';

import { Button, cn, IconButton, Spinner } from '@/renderer/ds';
import { $pipeline, $tasks, $tickets, ticketApi } from '@/renderer/features/Tickets/state';
import type { TicketId, TicketPhase } from '@/shared/types';

import { RESOLUTION_COLORS, RESOLUTION_LABELS } from './ticket-constants';

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

  const handleStart = useCallback(() => ticketApi.startSupervisor(ticketId), [ticketId]);
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
    if (!ticket?.columnId || !pipeline) return null;
    return pipeline.columns.find((c) => c.id === ticket.columnId)?.label ?? null;
  }, [ticket?.columnId, pipeline]);

  if (!columnLabel) return null;

  return (
    <span className="text-[10px] text-fg-subtle bg-surface-raised px-1.5 py-0.5 rounded-sm font-medium truncate max-w-[120px]">
      {columnLabel}
    </span>
  );
});
TicketColumnBadge.displayName = 'TicketColumnBadge';

/** Header action: new session button (+ icon). */
export const TicketHeaderActions = memo(({ ticketId }: { ticketId: TicketId }) => {
  const { handleReset } = useTicketAutomation(ticketId);
  return <IconButton aria-label="New session" icon={<PiPlusBold size={10} />} size="sm" onClick={handleReset} />;
});
TicketHeaderActions.displayName = 'TicketHeaderActions';

/** Banner action: autopilot controls + phase indicator. */
export const TicketBannerActions = memo(({ ticketId }: { ticketId: TicketId }) => {
  const { phase, handleStart, handleStop, handleReset } = useTicketAutomation(ticketId);

  const isAutonomous = phase === 'running' || phase === 'continuing';
  const isProvisioning = phase === 'provisioning' || phase === 'connecting' || phase === 'session_creating';
  const isRetrying = phase === 'retrying';
  const isAwaitingInput = phase === 'awaiting_input';
  const isError = phase === 'error';
  const isCompleted = phase === 'completed';

  if (isAutonomous) {
    return (
      <>
        <PiArrowsClockwiseBold size={10} className="text-green-400 animate-spin" />
        <span className="text-[10px] text-green-400 font-medium">Working</span>
        <IconButton aria-label="Stop" icon={<PiStopFill size={10} />} size="sm" onClick={handleStop} />
      </>
    );
  }
  if (isProvisioning) {
    return <Spinner size="sm" />;
  }
  if (isAwaitingInput) {
    return (
      <>
        <span className="size-1.5 rounded-full bg-blue-400 animate-pulse" />
        <span className="text-[10px] text-blue-400 font-medium">Needs input</span>
        <IconButton aria-label="Stop" icon={<PiStopFill size={10} />} size="sm" onClick={handleStop} />
      </>
    );
  }
  if (isRetrying) {
    return (
      <>
        <PiArrowsClockwiseBold size={10} className="text-yellow-400 animate-spin" />
        <span className="text-[10px] text-yellow-400 font-medium">Retrying</span>
        <IconButton aria-label="Stop" icon={<PiStopFill size={10} />} size="sm" onClick={handleStop} />
      </>
    );
  }
  if (isError) {
    return (
      <>
        <PiWarningCircleBold size={12} className="text-red-400" />
        <Button size="sm" leftIcon={<PiPlayFill size={10} />} onClick={handleStart}>
          Retry
        </Button>
      </>
    );
  }
  if (isCompleted) {
    return (
      <>
        <PiCheckCircleBold size={12} className="text-green-400" />
        <span className="text-[10px] text-green-400 font-medium">Done</span>
      </>
    );
  }
  // Idle — show autopilot button
  return (
    <Button size="sm" leftIcon={<PiPlayFill size={10} />} onClick={handleStart}>
      Autopilot
    </Button>
  );
});
TicketBannerActions.displayName = 'TicketBannerActions';

/** Resolution badge — displays the resolution label when a ticket is resolved. */
export const TicketResolutionBadge = memo(({ ticketId }: { ticketId: TicketId }) => {
  const tickets = useStore($tickets);
  const ticket = tickets[ticketId];

  if (!ticket?.resolution) return null;

  return (
    <span
      className={cn(
        'text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
        RESOLUTION_COLORS[ticket.resolution]
      )}
    >
      {RESOLUTION_LABELS[ticket.resolution]}
    </span>
  );
});
TicketResolutionBadge.displayName = 'TicketResolutionBadge';

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
