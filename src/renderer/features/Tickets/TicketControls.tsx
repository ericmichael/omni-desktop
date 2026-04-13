import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { ArrowSync20Regular, CheckmarkCircle20Regular, Play20Filled, Add20Regular, Stop20Filled, Warning20Regular } from '@fluentui/react-icons';
import { makeStyles, tokens } from '@fluentui/react-components';

import { Badge, Button, IconButton, Spinner } from '@/renderer/ds';
import { $pipeline, $tasks, $tickets, ticketApi } from '@/renderer/features/Tickets/state';
import type { TicketId, TicketPhase } from '@/shared/types';

import { RESOLUTION_COLORS, RESOLUTION_LABELS } from './ticket-constants';

const useStyles = makeStyles({
  columnBadge: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralBackground2} 50%, transparent)`,
    backdropFilter: 'blur(20px) saturate(160%)',
    WebkitBackdropFilter: 'blur(20px) saturate(160%)',
    paddingLeft: '6px',
    paddingRight: '6px',
    paddingTop: '2px',
    paddingBottom: '2px',
    borderRadius: tokens.borderRadiusSmall,
    fontWeight: tokens.fontWeightMedium,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '120px',
  },
  phaseRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
  },
  greenIcon: {
    color: tokens.colorPaletteGreenForeground1,
  },
  greenText: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorPaletteGreenForeground1,
    fontWeight: tokens.fontWeightMedium,
  },
  yellowIcon: {
    color: tokens.colorPaletteYellowForeground1,
  },
  yellowText: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorPaletteYellowForeground1,
    fontWeight: tokens.fontWeightMedium,
  },
  blueText: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightMedium,
  },
  blueDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: tokens.colorBrandForeground1,
  },
  redIcon: {
    color: tokens.colorPaletteRedForeground1,
  },
  controlsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
  },
});

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
  const styles = useStyles();
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

  // Hide when resolved — TicketResolutionBadge takes over.
  if (ticket?.resolution) return null;
  if (!columnLabel) return null;

  return (
    <span className={styles.columnBadge}>
      {columnLabel}
    </span>
  );
});
TicketColumnBadge.displayName = 'TicketColumnBadge';

/** Header action: new session button (+ icon). */
export const TicketHeaderActions = memo(({ ticketId }: { ticketId: TicketId }) => {
  const { handleReset } = useTicketAutomation(ticketId);
  return <IconButton aria-label="New session" icon={<Add20Regular style={{ width: 10, height: 10 }} />} size="sm" onClick={handleReset} />;
});
TicketHeaderActions.displayName = 'TicketHeaderActions';

/** Banner action: autopilot controls + phase indicator. */
export const TicketBannerActions = memo(({ ticketId }: { ticketId: TicketId }) => {
  const styles = useStyles();
  const tickets = useStore($tickets);
  const ticket = tickets[ticketId];
  const { phase, handleStart, handleStop, handleReset } = useTicketAutomation(ticketId);

  // When the ticket has a resolution, TicketResolutionBadge handles the display.
  if (ticket?.resolution) return null;

  const isAutonomous = phase === 'running' || phase === 'continuing';
  const isProvisioning = phase === 'provisioning' || phase === 'connecting' || phase === 'session_creating';
  const isRetrying = phase === 'retrying';
  const isAwaitingInput = phase === 'awaiting_input';
  const isError = phase === 'error';
  const isCompleted = phase === 'completed';

  if (isAutonomous) {
    return (
      <>
        <ArrowSync20Regular style={{ width: 10, height: 10 }} className={`${styles.greenIcon} animate-spin`} />
        <span className={styles.greenText}>Working</span>
        <IconButton aria-label="Stop" icon={<Stop20Filled style={{ width: 10, height: 10 }} />} size="sm" onClick={handleStop} />
      </>
    );
  }
  if (isProvisioning) {
    return <Spinner size="sm" />;
  }
  if (isAwaitingInput) {
    return (
      <>
        <span className={`${styles.blueDot} animate-pulse`} />
        <span className={styles.blueText}>Needs input</span>
        <IconButton aria-label="Stop" icon={<Stop20Filled style={{ width: 10, height: 10 }} />} size="sm" onClick={handleStop} />
      </>
    );
  }
  if (isRetrying) {
    return (
      <>
        <ArrowSync20Regular style={{ width: 10, height: 10 }} className={`${styles.yellowIcon} animate-spin`} />
        <span className={styles.yellowText}>Retrying</span>
        <IconButton aria-label="Stop" icon={<Stop20Filled style={{ width: 10, height: 10 }} />} size="sm" onClick={handleStop} />
      </>
    );
  }
  if (isError) {
    return (
      <>
        <Warning20Regular style={{ width: 12, height: 12 }} className={styles.redIcon} />
        <Button size="sm" leftIcon={<Play20Filled style={{ width: 10, height: 10 }} />} onClick={handleStart}>
          Retry
        </Button>
      </>
    );
  }
  if (isCompleted) {
    return (
      <>
        <CheckmarkCircle20Regular style={{ width: 12, height: 12 }} className={styles.greenIcon} />
        <span className={styles.greenText}>Done</span>
      </>
    );
  }
  // Idle — show autopilot button
  return (
    <Button size="sm" leftIcon={<Play20Filled style={{ width: 10, height: 10 }} />} onClick={handleStart}>
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
    <Badge color={RESOLUTION_COLORS[ticket.resolution]}>{RESOLUTION_LABELS[ticket.resolution]}</Badge>
  );
});
TicketResolutionBadge.displayName = 'TicketResolutionBadge';

/** Combined controls (legacy export). */
export const CodeTicketControls = memo(({ ticketId }: { ticketId: TicketId }) => {
  const styles = useStyles();
  return (
    <div className={styles.controlsRow}>
      <TicketHeaderActions ticketId={ticketId} />
      <TicketBannerActions ticketId={ticketId} />
    </div>
  );
});
CodeTicketControls.displayName = 'CodeTicketControls';
