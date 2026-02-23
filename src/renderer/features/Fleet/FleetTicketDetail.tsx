import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiArrowLeftBold, PiArrowsClockwiseBold, PiStopFill } from 'react-icons/pi';

import { Button, cn, Heading, IconButton, Switch } from '@/renderer/ds';
import type { FleetTicketId, GitRepoInfo } from '@/shared/types';

import {
  TICKET_PRIORITY_COLORS,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_COLORS,
  TICKET_STATUS_LABELS,
} from './fleet-constants';
import { FleetTaskCard } from './FleetTaskCard';
import { $fleetTasks, $fleetTickets, fleetApi } from './state';

export const FleetTicketDetail = memo(({ ticketId }: { ticketId: FleetTicketId }) => {
  const tickets = useStore($fleetTickets);
  const tasks = useStore($fleetTasks);
  const ticket = tickets[ticketId];
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [loopMaxIterations, setLoopMaxIterations] = useState(10);

  const blockerTickets = useMemo(() => {
    if (!ticket) {
      return [];
    }
    return ticket.blockedBy.flatMap((id) => {
      const t = tickets[id];
      return t ? [t] : [];
    });
  }, [ticket, tickets]);

  const isBlocked = useMemo(() => {
    return blockerTickets.some((b) => b.status !== 'completed' && b.status !== 'closed');
  }, [blockerTickets]);

  const linkedTask = useMemo(() => {
    if (!ticket?.taskId) {
      return undefined;
    }
    return tasks[ticket.taskId];
  }, [ticket, tasks]);

  const handleBack = useCallback(() => {
    if (ticket) {
      fleetApi.goToProject(ticket.projectId);
    } else {
      fleetApi.goToDashboard();
    }
  }, [ticket]);

  const handleClose = useCallback(() => {
    fleetApi.updateTicket(ticketId, { status: 'closed' });
  }, [ticketId]);

  const handleReopen = useCallback(() => {
    fleetApi.updateTicket(ticketId, { status: 'open' });
  }, [ticketId]);

  const handleComplete = useCallback(() => {
    fleetApi.updateTicket(ticketId, { status: 'completed' });
  }, [ticketId]);

  const handleDelete = useCallback(() => {
    fleetApi.removeTicket(ticketId);
  }, [ticketId]);

  const handleLoopToggle = useCallback((checked: boolean) => {
    setLoopEnabled(checked);
  }, []);

  const handleMaxIterationsChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val > 0) {
      setLoopMaxIterations(val);
    }
  }, []);

  const handleStopLoop = useCallback(() => {
    if (ticket) {
      fleetApi.stopLoop(ticket.id);
    }
  }, [ticket]);

  const handleResumeLoop = useCallback(() => {
    if (ticket) {
      fleetApi.resumeLoop(ticket.id);
    }
  }, [ticket]);

  const handleStartTask = useCallback(async () => {
    if (!ticket || isSubmitting) {
      return;
    }
    setIsSubmitting(true);

    // Fetch git info for worktree options if not yet loaded
    if (!gitInfo) {
      const info = await fleetApi.checkGitRepo(
        (await import('@/renderer/services/store')).persistedStoreApi
          .get()
          .fleetProjects.find((p) => p.id === ticket.projectId)?.workspaceDir ?? ''
      );
      setGitInfo(info);
    }

    try {
      await fleetApi.submitTicketTask(ticketId, {
        loop: loopEnabled,
        loopMaxIterations,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [ticket, ticketId, isSubmitting, gitInfo, loopEnabled, loopMaxIterations]);

  if (!ticket) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-fg-muted text-sm">Ticket not found</p>
      </div>
    );
  }

  const isOpen = ticket.status === 'open';
  const isDone = ticket.status === 'completed' || ticket.status === 'closed';
  const canStartTask = isOpen && !isBlocked && !ticket.taskId;

  return (
    <div className="flex flex-col w-full h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-2 px-6 py-4 border-b border-surface-border shrink-0">
        <IconButton aria-label="Back" icon={<PiArrowLeftBold />} size="sm" onClick={handleBack} />
        <div className="flex-1 min-w-0">
          <Heading size="md">{ticket.title}</Heading>
          <div className="flex items-center gap-2 mt-1">
            <div className={cn('size-2 rounded-full', TICKET_STATUS_COLORS[ticket.status])} />
            <span className="text-xs text-fg-muted">{TICKET_STATUS_LABELS[ticket.status]}</span>
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                TICKET_PRIORITY_COLORS[ticket.priority]
              )}
            >
              {TICKET_PRIORITY_LABELS[ticket.priority]}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {isOpen && (
            <Button size="sm" variant="ghost" onClick={handleComplete}>
              Complete
            </Button>
          )}
          {isOpen && (
            <Button size="sm" variant="ghost" onClick={handleClose}>
              Close
            </Button>
          )}
          {isDone && (
            <Button size="sm" variant="ghost" onClick={handleReopen}>
              Reopen
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={handleDelete}>
            Delete
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="flex flex-col gap-6 max-w-2xl">
          {/* Description */}
          {ticket.description && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-fg">Description</span>
              <p className="text-sm text-fg-muted whitespace-pre-wrap">{ticket.description}</p>
            </div>
          )}

          {/* Dependencies */}
          {blockerTickets.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-fg">Blocked By</span>
              <div className="flex flex-col gap-1">
                {blockerTickets.map((blocker) => (
                  <div key={blocker.id} className="flex items-center gap-2 text-sm">
                    <div className={cn('size-2 rounded-full', TICKET_STATUS_COLORS[blocker.status])} />
                    <span className="text-fg-muted">{blocker.title}</span>
                    <span className="text-xs text-fg-subtle">({TICKET_STATUS_LABELS[blocker.status]})</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Loop Status */}
          {ticket.loopEnabled && ticket.loopStatus && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-fg">Loop Mode</span>
              <div className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface-overlay/50 p-3">
                <PiArrowsClockwiseBold
                  size={16}
                  className={cn(
                    ticket.loopStatus === 'running' && 'text-green-400 animate-spin',
                    ticket.loopStatus === 'completed' && 'text-blue-400',
                    ticket.loopStatus === 'stopped' && 'text-fg-muted',
                    ticket.loopStatus === 'error' && 'text-red-400'
                  )}
                />
                <span className="text-sm text-fg">
                  Iteration {ticket.loopIteration ?? 0}/{ticket.loopMaxIterations ?? 0}
                </span>
                <span
                  className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                    ticket.loopStatus === 'running' && 'text-green-400 bg-green-400/10',
                    ticket.loopStatus === 'completed' && 'text-blue-400 bg-blue-400/10',
                    ticket.loopStatus === 'stopped' && 'text-fg-muted bg-fg-muted/10',
                    ticket.loopStatus === 'error' && 'text-red-400 bg-red-400/10'
                  )}
                >
                  {ticket.loopStatus}
                </span>
                {ticket.loopStatus === 'running' && (
                  <IconButton aria-label="Stop loop" icon={<PiStopFill />} size="sm" onClick={handleStopLoop} />
                )}
                {(ticket.loopStatus === 'stopped' || ticket.loopStatus === 'error') && (
                  <Button size="sm" onClick={handleResumeLoop}>
                    Resume
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Linked Task */}
          {linkedTask && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-fg">Linked Task</span>
              <FleetTaskCard task={linkedTask} />
            </div>
          )}

          {/* Start Task */}
          {canStartTask && (
            <div className="flex flex-col gap-3">
              {/* Loop mode toggle */}
              <div className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-overlay/50 p-3">
                <div className="flex items-center gap-3">
                  <label className="text-xs font-medium text-fg-subtle w-20 shrink-0">Loop Mode</label>
                  <Switch checked={loopEnabled} onCheckedChange={handleLoopToggle} />
                  <span className="text-xs text-fg-muted">
                    {loopEnabled ? 'Auto-restart agent on completion' : 'Single run'}
                  </span>
                </div>
                {loopEnabled && (
                  <div className="flex items-center gap-3">
                    <label className="text-xs font-medium text-fg-subtle w-20 shrink-0">Max Iterations</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={loopMaxIterations}
                      onChange={handleMaxIterationsChange}
                      className="w-20 rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent-500"
                    />
                  </div>
                )}
              </div>
              <div>
                <Button onClick={handleStartTask} isDisabled={isSubmitting}>
                  {isSubmitting ? 'Starting...' : loopEnabled ? 'Start Loop' : 'Start Task'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
FleetTicketDetail.displayName = 'FleetTicketDetail';
