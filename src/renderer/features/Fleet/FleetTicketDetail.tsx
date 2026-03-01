import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useCallback, useMemo, useState } from 'react';
import {
  PiArrowLeftBold,
  PiArrowsClockwiseBold,
  PiCheckCircleBold,
  PiMonitorBold,
  PiPencilSimpleBold,
  PiPlayFill,
  PiStopFill,
} from 'react-icons/pi';

import { Button, cn, Heading, IconButton } from '@/renderer/ds';
import type { FleetTicketId } from '@/shared/types';

import {
  COLUMN_BADGE_COLORS,
  TICKET_PRIORITY_COLORS,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_COLORS,
  TICKET_STATUS_LABELS,
} from './fleet-constants';
import { FleetTicketArtifactsTab } from './FleetTicketArtifactsTab';
import { FleetTicketOverviewTab } from './FleetTicketOverviewTab';
import { FleetTicketPlanTab } from './FleetTicketPlanTab';
import { $fleetPipeline, $fleetTasks, $fleetTickets, fleetApi } from './state';

type TicketTab = 'Plan' | 'Overview' | 'Artifacts';
const TABS: TicketTab[] = ['Plan', 'Overview', 'Artifacts'];

export const FleetTicketDetail = memo(({ ticketId }: { ticketId: FleetTicketId }) => {
  const tickets = useStore($fleetTickets);
  const tasks = useStore($fleetTasks);
  const pipeline = useStore($fleetPipeline);
  const ticket = tickets[ticketId];
  const [activeTab, setTicketActiveTab] = useState<TicketTab>('Plan');
  const [rejectNote, setRejectNote] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');

  const currentColumn = useMemo(() => {
    if (!ticket?.columnId || !pipeline) {
      return undefined;
    }
    return pipeline.columns.find((c) => c.id === ticket.columnId);
  }, [ticket, pipeline]);

  const currentPhase = useMemo(() => {
    if (!ticket?.currentPhaseId) {
      return undefined;
    }
    return ticket.phases.find((p) => p.id === ticket.currentPhaseId);
  }, [ticket]);

  // Phase task: find the latest task from the current phase
  const phaseTask = useMemo(() => {
    if (!currentPhase || currentPhase.taskIds.length === 0) {
      return undefined;
    }
    const lastTaskId = currentPhase.taskIds[currentPhase.taskIds.length - 1];
    return lastTaskId ? tasks[lastTaskId] : undefined;
  }, [currentPhase, tasks]);

  // Active running task (phase task or legacy linked task)
  const activeTask = useMemo(() => {
    const t = phaseTask ?? (ticket?.taskId ? tasks[ticket.taskId] : undefined);
    return t?.status.type === 'running' || t?.status.type === 'starting' ? t : undefined;
  }, [phaseTask, ticket, tasks]);

  const hasChecklist = useMemo(() => {
    if (!ticket) {
      return false;
    }
    return Object.values(ticket.checklist).some((items) => items.length > 0);
  }, [ticket]);

  const handleBack = useCallback(() => {
    if (ticket) {
      fleetApi.goToProject(ticket.projectId);
    } else {
      fleetApi.goToDashboard();
    }
  }, [ticket]);

  const handleOpenSandbox = useCallback(() => {
    if (activeTask) {
      fleetApi.goToTask(activeTask.id);
    }
  }, [activeTask]);

  // Inline title editing
  const handleStartEditTitle = useCallback(() => {
    if (ticket) {
      setEditTitle(ticket.title);
      setEditingTitle(true);
    }
  }, [ticket]);

  const handleEditTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditTitle(e.target.value);
  }, []);

  const handleSaveTitle = useCallback(() => {
    const trimmed = editTitle.trim();
    if (trimmed && ticket && trimmed !== ticket.title) {
      void fleetApi.updateTicket(ticketId, { title: trimmed });
    }
    setEditingTitle(false);
  }, [editTitle, ticket, ticketId]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSaveTitle();
      } else if (e.key === 'Escape') {
        setEditingTitle(false);
      }
    },
    [handleSaveTitle]
  );

  const handlePlan = useCallback(async () => {
    if (!ticket) {
      return;
    }
    const task = await fleetApi.submitPlanTask(ticket.id);
    fleetApi.goToTask(task.id);
  }, [ticket]);

  const handleChat = useCallback(async () => {
    if (!ticket) {
      return;
    }
    const task = await fleetApi.submitChatTask(ticket.id);
    fleetApi.goToTask(task.id);
  }, [ticket]);

  const handleAuto = useCallback(() => {
    fleetApi.startPhase(ticketId);
  }, [ticketId]);

  const handleDelete = useCallback(() => {
    fleetApi.removeTicket(ticketId);
  }, [ticketId]);

  // Phase controls
  const handleStartPhase = useCallback(() => {
    fleetApi.startPhase(ticketId);
  }, [ticketId]);

  const handleStopPhase = useCallback(() => {
    fleetApi.stopPhase(ticketId);
  }, [ticketId]);

  const handleResumePhase = useCallback(() => {
    fleetApi.resumePhase(ticketId);
  }, [ticketId]);

  const handleApprove = useCallback(() => {
    fleetApi.approvePhase(ticketId);
  }, [ticketId]);

  const handleShowReject = useCallback(() => {
    setShowRejectInput(true);
  }, []);

  const handleRejectNoteChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRejectNote(e.target.value);
  }, []);

  const handleReject = useCallback(() => {
    if (rejectNote.trim()) {
      fleetApi.rejectPhase(ticketId, rejectNote.trim());
      setRejectNote('');
      setShowRejectInput(false);
    }
  }, [ticketId, rejectNote]);

  const handleCancelReject = useCallback(() => {
    setShowRejectInput(false);
    setRejectNote('');
  }, []);

  // Legacy loop controls (for tickets without columnId)
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

  const handleRejectKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleReject();
      }
    },
    [handleReject]
  );

  // Tab click handlers
  const handleTabPlan = useCallback(() => {
    setTicketActiveTab('Plan');
  }, []);

  const handleTabOverview = useCallback(() => {
    setTicketActiveTab('Overview');
  }, []);

  const handleTabArtifacts = useCallback(() => {
    setTicketActiveTab('Artifacts');
  }, []);

  const tabClickHandlers = useMemo(
    () =>
      ({
        Plan: handleTabPlan,
        Overview: handleTabOverview,
        Artifacts: handleTabArtifacts,
      }) as Record<TicketTab, () => void>,
    [handleTabPlan, handleTabOverview, handleTabArtifacts]
  );

  if (!ticket) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-fg-muted text-sm">Ticket not found</p>
      </div>
    );
  }

  const hasColumnId = ticket.columnId !== null;

  // Determine unified status bar state
  const isLegacyLoop = !hasColumnId && ticket.loopEnabled && ticket.loopStatus;
  const isAgentRunning = currentPhase?.loop.status === 'running' || (isLegacyLoop && ticket.loopStatus === 'running');
  const isAwaitingApproval = hasColumnId && currentColumn?.requiresApproval && currentPhase?.status === 'completed';
  const isBlocked =
    (currentPhase?.status === 'blocked' || currentPhase?.loop.status === 'stopped') &&
    currentPhase?.status !== 'completed';
  const isPhasePending = currentPhase?.status === 'pending';
  const isPhaseCompleted = currentPhase?.status === 'completed' && !isAwaitingApproval;
  const isLegacyBlocked = isLegacyLoop && (ticket.loopStatus === 'stopped' || ticket.loopStatus === 'error');
  const showStatusBar =
    isAgentRunning ||
    isAwaitingApproval ||
    isBlocked ||
    isPhasePending ||
    isPhaseCompleted ||
    isLegacyBlocked ||
    !!activeTask;

  // Iteration label for running loops
  const iterationLabel = isLegacyLoop
    ? `Iteration ${ticket.loopIteration ?? 0}/${ticket.loopMaxIterations ?? 0}`
    : currentPhase?.loop.status === 'running'
      ? `Iteration ${currentPhase.loop.currentIteration}/${currentPhase.loop.maxIterations}`
      : null;

  return (
    <div className="flex flex-col w-full h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-6 py-4 border-b border-surface-border shrink-0">
        <IconButton aria-label="Back" icon={<PiArrowLeftBold />} size="sm" onClick={handleBack} />
        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <input
              type="text"
              value={editTitle}
              onChange={handleEditTitleChange}
              onBlur={handleSaveTitle}
              onKeyDown={handleTitleKeyDown}
              autoFocus
              className="w-full rounded-md border border-accent-500 bg-surface px-2 py-1 text-base font-semibold text-fg focus:outline-none"
            />
          ) : (
            <div className="flex items-center gap-1.5 group/title">
              <Heading size="md">{ticket.title}</Heading>
              <IconButton
                aria-label="Edit title"
                icon={<PiPencilSimpleBold />}
                size="sm"
                onClick={handleStartEditTitle}
                className="opacity-0 group-hover/title:opacity-100 transition-opacity"
              />
            </div>
          )}
          <div className="flex items-center gap-2 mt-1">
            {hasColumnId && currentColumn ? (
              <span
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                  COLUMN_BADGE_COLORS[currentColumn.id] ?? 'text-fg-muted bg-fg-muted/10'
                )}
              >
                {currentColumn.label}
              </span>
            ) : (
              <>
                <div className={cn('size-2 rounded-full', TICKET_STATUS_COLORS[ticket.status])} />
                <span className="text-xs text-fg-muted">{TICKET_STATUS_LABELS[ticket.status]}</span>
              </>
            )}
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
        {!hasChecklist && (
          <Button size="sm" variant="ghost" onClick={handlePlan}>
            Plan
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={handleChat}>
          Chat
        </Button>
        {hasChecklist && (
          <Button size="sm" variant="ghost" onClick={handleAuto}>
            Auto
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={handleDelete}>
          Delete
        </Button>
      </div>

      {/* Status Bar */}
      {showStatusBar && (
        <div className="flex items-center gap-3 px-6 py-3 border-b border-surface-border shrink-0">
          {isAgentRunning && <div className="size-2.5 rounded-full bg-green-400 animate-pulse shrink-0" />}
          {isAwaitingApproval && <div className="size-2.5 rounded-full bg-blue-400 shrink-0" />}
          {(isBlocked || isLegacyBlocked) && <div className="size-2.5 rounded-full bg-orange-400 shrink-0" />}
          {isPhasePending && <div className="size-2.5 rounded-full bg-fg-muted/30 shrink-0" />}
          {isPhaseCompleted && <PiCheckCircleBold size={14} className="text-green-400 shrink-0" />}

          <div className="flex items-center gap-2 flex-1 min-w-0">
            {isAgentRunning && (
              <>
                <PiArrowsClockwiseBold size={14} className="text-green-400 animate-spin shrink-0" />
                <span className="text-sm font-medium text-green-400">Running</span>
                {iterationLabel && <span className="text-sm text-fg-muted">{iterationLabel}</span>}
              </>
            )}
            {isAwaitingApproval && !showRejectInput && (
              <span className="text-sm font-medium text-blue-400">Awaiting Approval</span>
            )}
            {isBlocked && (
              <>
                <span className="text-sm font-medium text-orange-400">
                  {currentPhase?.status === 'blocked' ? 'Blocked' : 'Stopped'}
                </span>
                {currentPhase?.exitSentinel && (
                  <span className="text-xs text-fg-muted">{currentPhase.exitSentinel}</span>
                )}
              </>
            )}
            {isLegacyBlocked && (
              <span className="text-sm font-medium text-orange-400">
                {ticket.loopStatus === 'error' ? 'Error' : 'Stopped'}
              </span>
            )}
            {isPhasePending && <span className="text-sm text-fg-muted">Ready</span>}
            {isPhaseCompleted && <span className="text-sm text-fg-muted">Completed</span>}
          </div>

          {isAwaitingApproval && showRejectInput && (
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <input
                type="text"
                value={rejectNote}
                onChange={handleRejectNoteChange}
                placeholder="Rejection reason..."
                autoFocus
                className="flex-1 rounded-md border border-surface-border bg-surface px-2 py-1 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
                onKeyDown={handleRejectKeyDown}
              />
              <Button size="sm" onClick={handleReject} isDisabled={!rejectNote.trim()}>
                Reject
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancelReject}>
                Cancel
              </Button>
            </div>
          )}

          <div className="flex items-center gap-2 shrink-0">
            {isAgentRunning && !isLegacyLoop && (
              <IconButton aria-label="Stop" icon={<PiStopFill />} size="sm" onClick={handleStopPhase} />
            )}
            {isAgentRunning && isLegacyLoop && (
              <IconButton aria-label="Stop" icon={<PiStopFill />} size="sm" onClick={handleStopLoop} />
            )}
            {activeTask && (
              <Button size="sm" variant="ghost" onClick={handleOpenSandbox}>
                <PiMonitorBold size={14} className="mr-1" />
                Open Sandbox
              </Button>
            )}
            {isAwaitingApproval && !showRejectInput && (
              <>
                <Button size="sm" onClick={handleApprove}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost" onClick={handleShowReject}>
                  Reject
                </Button>
              </>
            )}
            {(isBlocked || isLegacyBlocked || isPhasePending) && (
              <Button
                size="sm"
                onClick={isPhasePending ? handleStartPhase : isLegacyLoop ? handleResumeLoop : handleResumePhase}
              >
                <PiPlayFill size={12} className="mr-1" />
                Go
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <div className="flex gap-1 px-6 py-2 border-b border-surface-border shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={tabClickHandlers[tab]}
            className="relative px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer select-none transition-colors"
            style={{ color: activeTab === tab ? 'var(--color-fg)' : 'var(--color-fg-muted)' }}
          >
            {activeTab === tab && (
              <motion.div
                layoutId="ticket-tab-indicator"
                className="absolute inset-0 bg-white/10 rounded-md"
                transition={{ type: 'spring', duration: 0.3, bounce: 0.15 }}
              />
            )}
            <span className="relative z-10">{tab}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'Plan' && (
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          <FleetTicketPlanTab ticket={ticket} pipeline={pipeline} />
        </div>
      )}
      {activeTab === 'Overview' && (
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          <FleetTicketOverviewTab ticket={ticket} pipeline={pipeline} />
        </div>
      )}
      {activeTab === 'Artifacts' && (
        <div className="flex-1 min-h-0">
          <FleetTicketArtifactsTab ticketId={ticketId} />
        </div>
      )}
    </div>
  );
});
FleetTicketDetail.displayName = 'FleetTicketDetail';
