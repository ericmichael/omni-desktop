import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PiArrowLeftBold,
  PiArrowsClockwiseBold,
  PiPlusBold,
  PiMonitorBold,
  PiPencilSimpleBold,
  PiPlayFill,
  PiStopFill,
  PiTrashBold,
} from 'react-icons/pi';

import { Webview } from '@/renderer/common/Webview';
import { cn, IconButton, Spinner } from '@/renderer/ds';
import { persistedStoreApi } from '@/renderer/services/store';
import type { FleetTicketId } from '@/shared/types';

import {
  COLUMN_BADGE_COLORS,
  TICKET_PRIORITY_COLORS,
  TICKET_PRIORITY_LABELS,
} from './fleet-constants';
import { FleetTicketArtifactsTab } from './FleetTicketArtifactsTab';
import { FleetTicketOverviewTab } from './FleetTicketOverviewTab';
import { FleetTicketPlanTab } from './FleetTicketPlanTab';
import { $fleetPipeline, $fleetTasks, $fleetTickets, fleetApi } from './state';

type TicketTab = 'Chat' | 'Overview' | 'Plan' | 'Artifacts';
const TABS: TicketTab[] = ['Chat', 'Overview', 'Plan', 'Artifacts'];

export const FleetTicketDetail = memo(({ ticketId }: { ticketId: FleetTicketId }) => {
  const tickets = useStore($fleetTickets);
  const tasks = useStore($fleetTasks);
  const pipeline = useStore($fleetPipeline);
  const store = useStore(persistedStoreApi.$atom);
  const ticket = tickets[ticketId];
  const [activeTab, setActiveTab] = useState<TicketTab>('Chat');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');

  const currentColumn = useMemo(() => {
    if (!ticket?.columnId || !pipeline) {
      return undefined;
    }
    return pipeline.columns.find((c) => c.id === ticket.columnId);
  }, [ticket, pipeline]);

  const activeTask = useMemo(() => {
    if (!ticket?.supervisorTaskId) {
      return undefined;
    }
    const t = tasks[ticket.supervisorTaskId];
    return t?.status.type === 'running' || t?.status.type === 'starting' ? t : undefined;
  }, [ticket, tasks]);

  const supervisorUiUrl = useMemo(() => {
    if (!ticket?.supervisorTaskId) {
      return undefined;
    }
    const task = tasks[ticket.supervisorTaskId];
    // Only use the URL when the sandbox is actively running — the omniagents
    // server inside the container must be alive for the UI to load.
    if (task?.status.type !== 'running') {
      return undefined;
    }
    const baseUrl = task.status.data.uiUrl;
    if (!baseUrl) {
      return undefined;
    }
    const url = new URL(baseUrl, window.location.origin);
    if (ticket.supervisorSessionId) {
      url.searchParams.set('session', ticket.supervisorSessionId);
    }
    const theme = store.theme ?? 'tokyo-night';
    if (theme !== 'default') {
      url.searchParams.set('theme', theme);
    }
    url.searchParams.set('minimal', 'true');
    return url.toString();
  }, [ticket, tasks, store.theme]);

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

  // Auto-start the sandbox (without sending a prompt) so the web UI loads
  const infraStarted = useRef(false);
  useEffect(() => {
    if (activeTab !== 'Chat') {
      return;
    }
    const status = ticket?.supervisorStatus;
    const hasRunningTask = !!activeTask;
    if (!hasRunningTask && (!status || status === 'idle') && !infraStarted.current) {
      infraStarted.current = true;
      void fleetApi.ensureSupervisorInfra(ticketId);
    }
  }, [activeTab, ticket?.supervisorStatus, activeTask, ticketId]);

  const handleStartSupervisor = useCallback(() => {
    fleetApi.startSupervisor(ticketId);
  }, [ticketId]);

  const handleStopSupervisor = useCallback(() => {
    fleetApi.stopSupervisor(ticketId);
  }, [ticketId]);

  const handleResetSession = useCallback(() => {
    fleetApi.resetSupervisorSession(ticketId);
  }, [ticketId]);

  const handleDelete = useCallback(() => {
    fleetApi.removeTicket(ticketId);
  }, [ticketId]);

  const tabHandlers = useMemo(
    () => Object.fromEntries(TABS.map((t) => [t, () => setActiveTab(t)])) as Record<TicketTab, () => void>,
    []
  );

  if (!ticket) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-fg-muted text-sm">Ticket not found</p>
      </div>
    );
  }

  const supervisorStatus = ticket.supervisorStatus;
  const isRunning = supervisorStatus === 'running';
  const isWaiting = supervisorStatus === 'waiting';
  const isError = supervisorStatus === 'error';
  const isIdle = !supervisorStatus || supervisorStatus === 'idle';

  return (
    <div className="flex flex-col w-full h-full">
      {/* Single compact header: back + title + badges + status + actions */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-border shrink-0">
        <IconButton aria-label="Back" icon={<PiArrowLeftBold />} size="sm" onClick={handleBack} />

        {/* Title (editable) + inline badges */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {editingTitle ? (
            <input
              type="text"
              value={editTitle}
              onChange={handleEditTitleChange}
              onBlur={handleSaveTitle}
              onKeyDown={handleTitleKeyDown}
              autoFocus
              className="flex-1 min-w-0 rounded-md border border-accent-500 bg-surface px-2 py-0.5 text-sm font-semibold text-fg focus:outline-none"
            />
          ) : (
            <button
              onClick={handleStartEditTitle}
              className="flex items-center gap-1.5 min-w-0 group/title cursor-pointer"
            >
              <span className="text-sm font-semibold text-fg truncate">{ticket.title}</span>
              <PiPencilSimpleBold
                size={12}
                className="shrink-0 text-fg-muted opacity-0 group-hover/title:opacity-100 transition-opacity"
              />
            </button>
          )}

          {currentColumn && (
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
                COLUMN_BADGE_COLORS[currentColumn.id] ?? 'text-fg-muted bg-fg-muted/10'
              )}
            >
              {currentColumn.label}
            </span>
          )}
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
              TICKET_PRIORITY_COLORS[ticket.priority]
            )}
          >
            {TICKET_PRIORITY_LABELS[ticket.priority]}
          </span>

          {/* Inline supervisor status */}
          {isRunning && (
            <span className="flex items-center gap-1 text-[10px] text-green-400 font-medium shrink-0">
              <PiArrowsClockwiseBold size={10} className="animate-spin" />
              Running
            </span>
          )}
          {isWaiting && (
            <span className="flex items-center gap-1 text-[10px] text-blue-400 font-medium shrink-0">
              <span className="size-1.5 rounded-full bg-blue-400" />
              Waiting
            </span>
          )}
          {isError && (
            <span className="flex items-center gap-1 text-[10px] text-red-400 font-medium shrink-0">
              <span className="size-1.5 rounded-full bg-red-400" />
              Error
            </span>
          )}
        </div>

        {/* Actions */}
        {activeTask && (
          <IconButton
            aria-label="New Chat"
            icon={<PiPlusBold />}
            size="sm"
            onClick={handleResetSession}
          />
        )}
        {activeTask && (
          <IconButton
            aria-label="Open Sandbox"
            icon={<PiMonitorBold />}
            size="sm"
            onClick={handleOpenSandbox}
          />
        )}
        {isIdle && (
          <IconButton aria-label="Start Supervisor" icon={<PiPlayFill />} size="sm" onClick={handleStartSupervisor} />
        )}
        {isError && (
          <IconButton aria-label="Retry" icon={<PiPlayFill />} size="sm" onClick={handleStartSupervisor} />
        )}
        {(isRunning || isWaiting) && (
          <IconButton aria-label="Stop Supervisor" icon={<PiStopFill />} size="sm" onClick={handleStopSupervisor} />
        )}
        <IconButton aria-label="Delete ticket" icon={<PiTrashBold />} size="sm" onClick={handleDelete} />
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 px-4 py-1.5 border-b border-surface-border shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={tabHandlers[tab]}
            className="relative px-3 py-1 text-xs font-medium rounded-md cursor-pointer select-none transition-colors"
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

      {/* Tab content */}
      {activeTab === 'Chat' && (
        <div className="flex-1 min-h-0 relative">
          {supervisorUiUrl ? (
            <Webview src={supervisorUiUrl} showUnavailable={false} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              {isRunning ? (
                <>
                  <Spinner size="md" />
                  <p className="text-sm text-fg-muted">Loading chat interface...</p>
                </>
              ) : (
                <p className="text-sm text-fg-muted">
                  {isWaiting ? 'Supervisor is waiting — click play to resume.' : 'Start the supervisor to begin chatting.'}
                </p>
              )}
            </div>
          )}
        </div>
      )}
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
