import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  PiArrowLeftBold,
  PiArrowsClockwiseBold,
  PiChatCircleBold,
  PiCodeBold,
  PiMonitorBold,
  PiPencilSimpleBold,
  PiPlayFill,
  PiGitBranchBold,
  PiPlusBold,
  PiRobotBold,
  PiStopFill,
  PiTrashBold,
  PiWarningCircleBold,
  PiCaretDownBold,
  PiCheckCircleBold,
} from 'react-icons/pi';

import { CodeSplitLayout } from '@/renderer/common/CodeSplitLayout';
import { Webview } from '@/renderer/common/Webview';
import { Button, cn, IconButton, Spinner } from '@/renderer/ds';
import { FloatingWidget } from '@/renderer/features/Omni/FloatingWidget';
import { persistedStoreApi } from '@/renderer/services/store';
import type { FleetTicketId, TicketPhase } from '@/shared/types';

import { COLUMN_BADGE_COLORS, PHASE_LABELS, TICKET_PRIORITY_COLORS, TICKET_PRIORITY_LABELS } from './fleet-constants';
import { FleetTicketArtifactsTab } from './FleetTicketArtifactsTab';
import { FleetTicketOverviewTab } from './FleetTicketOverviewTab';
import { FleetTicketPRTab } from './FleetTicketPRTab';
import { $fleetPipeline, $fleetTasks, $fleetTickets, fleetApi } from './state';

type TicketTab = 'Chat' | 'Overview' | 'PR' | 'Artifacts';
const TABS: TicketTab[] = ['Chat', 'Overview', 'PR', 'Artifacts'];

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

  const supervisorTask = useMemo(() => {
    if (!ticket?.supervisorTaskId) {
      return undefined;
    }
    return tasks[ticket.supervisorTaskId];
  }, [ticket, tasks]);

  const runningData = supervisorTask?.status.type === 'running' ? supervisorTask.status.data : undefined;
  const isContainerLive = supervisorTask?.status.type === 'running' || supervisorTask?.status.type === 'starting';

  const theme = store.theme ?? 'tokyo-night';

  const supervisorUiUrl = useMemo(() => {
    const baseUrl = runningData?.uiUrl;
    if (!baseUrl) {
      return undefined;
    }
    const url = new URL(baseUrl, window.location.origin);
    if (ticket?.supervisorSessionId) {
      url.searchParams.set('session', ticket.supervisorSessionId);
    }
    if (theme !== 'default') {
      url.searchParams.set('theme', theme);
    }
    url.searchParams.set('minimal', 'true');
    return url.toString();
  }, [runningData, ticket?.supervisorSessionId, theme]);

  const codeServerUrl = useMemo(() => {
    const baseUrl = runningData?.codeServerUrl ?? supervisorTask?.lastUrls?.codeServerUrl;
    if (!baseUrl) {
      return undefined;
    }
    const url = new URL(baseUrl, window.location.origin);
    url.searchParams.set('folder', '/home/user/workspace');
    return url.toString();
  }, [runningData, supervisorTask?.lastUrls?.codeServerUrl]);

  const noVncUrl = runningData?.noVncUrl ?? supervisorTask?.lastUrls?.noVncUrl;

  const handleBack = useCallback(() => {
    if (ticket) {
      fleetApi.goToProject(ticket.projectId);
    } else {
      fleetApi.goToDashboard();
    }
  }, [ticket]);

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
    const phase = ticket?.phase;
    const hasRunningTask = !!activeTask;
    if (!hasRunningTask && (!phase || phase === 'idle') && !infraStarted.current) {
      infraStarted.current = true;
      void fleetApi.ensureSupervisorInfra(ticketId);
    }
  }, [activeTab, ticket?.phase, activeTask, ticketId]);

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

  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const columnMenuRef = useRef<HTMLDivElement>(null);

  const handleColumnBadgeClick = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    setColumnMenuOpen((prev) => !prev);
  }, []);

  const handleMoveToColumn = useCallback(
    (columnId: string) => {
      fleetApi.moveTicketToColumn(ticketId, columnId);
      setColumnMenuOpen(false);
    },
    [ticketId]
  );

  // Close column menu on outside click
  useEffect(() => {
    if (!columnMenuOpen) return;
    const handleClickOutside = (e: Event) => {
      if (columnMenuRef.current && !columnMenuRef.current.contains(e.target as Node)) {
        setColumnMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [columnMenuOpen]);

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

  const phase = ticket.phase;

  return (
    <div className="flex flex-col w-full h-full">
      {/* Header: back + title + metadata badges + delete */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-border shrink-0">
        <IconButton aria-label="Back" icon={<PiArrowLeftBold />} size="sm" onClick={handleBack} />

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
            <div className="relative shrink-0" ref={columnMenuRef}>
              <button
                onClick={handleColumnBadgeClick}
                className={cn(
                  'flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium cursor-pointer hover:brightness-125 transition-all',
                  COLUMN_BADGE_COLORS[currentColumn.id] ?? 'text-fg-muted bg-fg-muted/10'
                )}
              >
                {currentColumn.label}
                <PiCaretDownBold size={8} />
              </button>
              {columnMenuOpen && pipeline && (
                <div className="absolute top-full left-0 mt-1 z-50 min-w-[140px] rounded-md border border-surface-border bg-surface shadow-lg py-1">
                  {pipeline.columns.map((col) => (
                    <button
                      key={col.id}
                      onClick={() => handleMoveToColumn(col.id)}
                      disabled={col.id === currentColumn.id}
                      className={cn(
                        'w-full text-left px-3 py-1.5 text-xs transition-colors',
                        col.id === currentColumn.id
                          ? 'text-fg-muted cursor-default bg-surface-hover'
                          : 'text-fg hover:bg-surface-hover cursor-pointer'
                      )}
                    >
                      {col.label}
                      {col.gate && <span className="ml-1 text-[10px] text-fg-muted">(gated)</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
              TICKET_PRIORITY_COLORS[ticket.priority]
            )}
          >
            {TICKET_PRIORITY_LABELS[ticket.priority]}
          </span>

          {ticket.branch && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 text-purple-400 bg-purple-400/10">
              <PiGitBranchBold size={10} />
              {ticket.branch}
              {ticket.useWorktree && ' (worktree)'}
            </span>
          )}
        </div>

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
        <FleetTicketChatTab
          ticketId={ticketId}
          phase={phase}
          supervisorUiUrl={supervisorUiUrl}
          codeServerUrl={codeServerUrl}
          noVncUrl={noVncUrl}
          isContainerLive={!!isContainerLive}
          hasActiveTask={!!activeTask}
          onStart={handleStartSupervisor}
          onStop={handleStopSupervisor}
          onReset={handleResetSession}
        />
      )}
      {activeTab === 'Overview' && (
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          <FleetTicketOverviewTab ticket={ticket} />
        </div>
      )}
      {activeTab === 'PR' && (
        <div className="flex-1 min-h-0">
          <FleetTicketPRTab ticketId={ticketId} />
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

// --- Mode bar: shows current session mode + contextual actions ---

type ModeBarProps = {
  phase: TicketPhase | undefined;
  isContainerLive: boolean;
  hasActiveTask: boolean;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
};

const ModeBar = memo(({ phase, isContainerLive, hasActiveTask, onStart, onStop, onReset }: ModeBarProps) => {
  const isAutonomous = phase === 'running' || phase === 'continuing';
  const isProvisioning = phase === 'provisioning' || phase === 'connecting' || phase === 'session_creating';
  const isRetrying = phase === 'retrying';
  const isAwaitingInput = phase === 'awaiting_input';
  const isError = phase === 'error';
  const isCompleted = phase === 'completed';
  const isManual = isContainerLive && !isAutonomous && !isProvisioning && !isRetrying && !isError;

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-surface-border shrink-0 bg-surface-overlay/30">
      {/* Provisioning */}
      {isProvisioning && (
        <div className="flex items-center gap-2 flex-1">
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">{PHASE_LABELS[phase!] ?? 'Preparing...'}</span>
        </div>
      )}

      {/* Manual session */}
      {isManual && !isCompleted && !isAwaitingInput && (
        <div className="flex items-center gap-2 flex-1">
          <PiChatCircleBold size={14} className="text-fg-muted shrink-0" />
          <span className="text-xs text-fg-muted">Manual session</span>
          <div className="flex-1" />
          {hasActiveTask && (
            <IconButton aria-label="New session" icon={<PiPlusBold />} size="sm" onClick={onReset} />
          )}
          <Button size="sm" leftIcon={<PiPlayFill size={12} />} onClick={onStart}>
            Start Autonomous Run
          </Button>
        </div>
      )}

      {/* Autonomous running */}
      {isAutonomous && (
        <div className="flex items-center gap-2 flex-1">
          <PiRobotBold size={14} className="text-green-400 shrink-0" />
          <span className="text-xs text-green-400 font-medium">Autonomous</span>
          <PiArrowsClockwiseBold size={10} className="text-green-400 animate-spin" />
          <span className="text-xs text-fg-muted">{PHASE_LABELS[phase!] ?? 'Working...'}</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" leftIcon={<PiStopFill size={12} />} onClick={onStop}>
            Stop
          </Button>
        </div>
      )}

      {/* Awaiting input */}
      {isAwaitingInput && (
        <div className="flex items-center gap-2 flex-1">
          <PiRobotBold size={14} className="text-blue-400 shrink-0" />
          <span className="text-xs text-blue-400 font-medium">Autonomous</span>
          <span className="size-1.5 rounded-full bg-blue-400 animate-pulse" />
          <span className="text-xs text-fg-muted">Agent needs your input — type in the chat below</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" leftIcon={<PiStopFill size={12} />} onClick={onStop}>
            Stop
          </Button>
        </div>
      )}

      {/* Retrying */}
      {isRetrying && (
        <div className="flex items-center gap-2 flex-1">
          <PiRobotBold size={14} className="text-yellow-400 shrink-0" />
          <span className="text-xs text-yellow-400 font-medium">Autonomous</span>
          <PiArrowsClockwiseBold size={10} className="text-yellow-400 animate-spin" />
          <span className="text-xs text-fg-muted">Retrying...</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" leftIcon={<PiStopFill size={12} />} onClick={onStop}>
            Stop
          </Button>
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="flex items-center gap-2 flex-1">
          <PiWarningCircleBold size={14} className="text-red-400 shrink-0" />
          <span className="text-xs text-red-400 font-medium">Error</span>
          <span className="text-xs text-fg-muted">The autonomous run encountered an error</span>
          <div className="flex-1" />
          <Button size="sm" leftIcon={<PiPlayFill size={12} />} onClick={onStart}>
            Retry
          </Button>
        </div>
      )}

      {/* Completed */}
      {isCompleted && (
        <div className="flex items-center gap-2 flex-1">
          <PiCheckCircleBold size={14} className="text-green-400 shrink-0" />
          <span className="text-xs text-green-400 font-medium">Completed</span>
          <div className="flex-1" />
          {hasActiveTask && (
            <IconButton aria-label="New session" icon={<PiPlusBold />} size="sm" onClick={onReset} />
          )}
          <Button size="sm" leftIcon={<PiPlayFill size={12} />} onClick={onStart}>
            Run Again
          </Button>
        </div>
      )}

      {/* Not started yet (no container) */}
      {!isContainerLive && !isProvisioning && !isError && !isCompleted && (
        <div className="flex items-center gap-2 flex-1">
          <Spinner size="sm" />
          <span className="text-xs text-fg-muted">Starting workspace...</span>
        </div>
      )}
    </div>
  );
});
ModeBar.displayName = 'ModeBar';

// --- Chat tab content ---

type MainView = 'agent' | 'code' | 'vnc';

type ChatTabProps = {
  ticketId: FleetTicketId;
  phase: TicketPhase | undefined;
  supervisorUiUrl: string | undefined;
  codeServerUrl: string | undefined;
  noVncUrl: string | undefined;
  isContainerLive: boolean;
  hasActiveTask: boolean;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
};

const FleetTicketChatTab = memo(
  ({
    phase,
    supervisorUiUrl,
    codeServerUrl,
    noVncUrl,
    isContainerLive,
    hasActiveTask,
    onStart,
    onStop,
    onReset,
  }: ChatTabProps) => {
    const [mainView, setMainView] = useState<MainView>('agent');
    const [splitSrc, setSplitSrc] = useState<string | null>(null);

    const views = useMemo(
      () => [
        { key: 'agent' as const, label: 'Agent', icon: PiRobotBold, src: supervisorUiUrl },
        { key: 'code' as const, label: 'VS Code', icon: PiCodeBold, src: codeServerUrl },
        { key: 'vnc' as const, label: "Omni's PC", icon: PiMonitorBold, src: noVncUrl },
      ],
      [supervisorUiUrl, codeServerUrl, noVncUrl]
    );

    const switchTo = useCallback(
      (view: MainView) => {
        const src = views.find((v) => v.key === view)?.src;
        setSplitSrc((prev) => (prev && prev === src ? null : prev));
        setMainView(view);
      },
      [views]
    );

    const handleSetAgent = useCallback(() => switchTo('agent'), [switchTo]);
    const handleSetCode = useCallback(() => switchTo('code'), [switchTo]);
    const handleSetVnc = useCallback(() => switchTo('vnc'), [switchTo]);

    const setters: Record<MainView, () => void> = useMemo(
      () => ({ agent: handleSetAgent, code: handleSetCode, vnc: handleSetVnc }),
      [handleSetAgent, handleSetCode, handleSetVnc]
    );

    const handleToggleSplit = useCallback((src: string | undefined) => {
      if (!src) {
        return;
      }
      setSplitSrc((prev) => (prev === src ? null : src));
    }, []);

    const [overlayKey, setOverlayKey] = useState<string | null>(null);
    const handleOpenOverlay = useCallback((key: string) => () => setOverlayKey(key), []);
    const handleCloseOverlay = useCallback(() => setOverlayKey(null), []);

    const currentView = views.find((v) => v.key === mainView);
    const mainSrc = currentView?.src;
    const pills = views.filter((v) => v.key !== mainView && v.src);
    const showWebview = mainSrc && isContainerLive;

    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <ModeBar
          phase={phase}
          isContainerLive={isContainerLive}
          hasActiveTask={hasActiveTask}
          onStart={onStart}
          onStop={onStop}
          onReset={onReset}
        />
        <div className="flex-1 min-h-0 relative">
          {showWebview ? (
            <div className="h-full relative">
              {splitSrc && mainSrc ? (
                <CodeSplitLayout codeServerSrc={mainSrc} uiSrc={splitSrc} />
              ) : (
                <Webview src={mainSrc} showUnavailable={false} />
              )}
              {pills.map((pill, i) => (
                <FloatingWidget
                  key={pill.key}
                  src={pill.src!}
                  label={pill.label}
                  icon={pill.icon}
                  overlayOpen={overlayKey === pill.key}
                  onOpenOverlay={handleOpenOverlay(pill.key)}
                  onCloseOverlay={handleCloseOverlay}
                  onClick={setters[pill.key]}
                  className={i === 0 ? 'top-[82%]' : 'top-[88%]'}
                  defaultPreviewSize={pill.key === 'code' ? { width: 560, height: 380 } : undefined}
                  resizable
                  onToggleSplit={handleToggleSplit.bind(null, pill.src)}
                  splitOpen={splitSrc === pill.src}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <Spinner size="md" />
              <p className="text-sm text-fg-muted">Starting workspace...</p>
            </div>
          )}
        </div>
      </div>
    );
  }
);
FleetTicketChatTab.displayName = 'FleetTicketChatTab';
