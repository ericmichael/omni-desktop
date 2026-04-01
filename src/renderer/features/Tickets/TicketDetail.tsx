import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { memo, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PiArrowsClockwiseBold,
  PiArrowsInBold,
  PiArrowsOutBold,
  PiCaretDownBold,
  PiChatCircleBold,
  PiDotsThreeBold,
  PiCheckCircleBold,
  PiCodeBold,
  PiDotsSixVerticalBold,
  PiGitBranchBold,
  PiMonitorBold,
  PiPencilSimpleBold,
  PiPlayFill,
  PiPlusBold,
  PiRobotBold,
  PiStopFill,
  PiTrashBold,
  PiWarningCircleBold,
  PiXBold,
} from 'react-icons/pi';

import { CodeSplitLayout } from '@/renderer/common/CodeSplitLayout';
import { Webview } from '@/renderer/common/Webview';
import { Button, cn, IconButton, Spinner } from '@/renderer/ds';
import { FloatingWidget } from '@/renderer/features/Omni/FloatingWidget';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import { buildSandboxLabel, isCustomSandbox } from '@/renderer/omniagents-ui/sandbox-label';
import { $initiatives } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitRepoInfo, TicketId, TicketPhase, TicketResolution } from '@/shared/types';

import { COLUMN_BADGE_COLORS, PHASE_LABELS, RESOLUTION_COLORS, RESOLUTION_LABELS, TICKET_PRIORITY_COLORS, TICKET_PRIORITY_LABELS } from './ticket-constants';
import { TicketArtifactsTab } from './TicketArtifactsTab';
import { TicketOverviewTab } from './TicketOverviewTab';
import { TicketPRTab } from './TicketPRTab';
import { $pipeline, $tasks, $tickets, ticketApi } from './state';

type TicketTab = 'Chat' | 'Overview' | 'PR' | 'Artifacts';
const TABS: TicketTab[] = ['Chat', 'Overview', 'PR', 'Artifacts'];

type DragHandleProps = {
  attributes: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  listeners: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
};

type TicketDetailProps = {
  ticketId: TicketId;
  compact?: boolean;
  onClose?: () => void;
  dragHandleProps?: DragHandleProps;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
};

export const TicketDetail = memo(({ ticketId, compact, onClose, dragHandleProps, isExpanded, onToggleExpand }: TicketDetailProps) => {
  const tickets = useStore($tickets);
  const tasks = useStore($tasks);
  const pipeline = useStore($pipeline);
  const initiatives = useStore($initiatives);
  const store = useStore(persistedStoreApi.$atom);
  const ticket = tickets[ticketId];
  const initiative = ticket?.initiativeId ? initiatives[ticket.initiativeId] : undefined;
  const project = useMemo(
    () => store.projects.find((p) => p.id === ticket?.projectId) ?? null,
    [store.projects, ticket?.projectId]
  );
  const sandboxLabel = useMemo(
    () => (store.sandboxEnabled ? buildSandboxLabel(store.sandboxVariant, { custom: isCustomSandbox(project?.sandbox) }) : undefined),
    [store.sandboxEnabled, store.sandboxVariant, project?.sandbox]
  );
  const [activeTab, setActiveTab] = useState<TicketTab>('Chat');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);
  const [editingBranch, setEditingBranch] = useState(false);
  const [editBranch, setEditBranch] = useState('');

  const currentColumn = useMemo(() => {
    if (!ticket?.columnId || !pipeline) {
      return undefined;
    }
    return pipeline.columns.find((c) => c.id === ticket.columnId);
  }, [ticket, pipeline]);

  // Find the task for this ticket — prefer supervisorTaskId, fall back to scanning by ticketId
  const supervisorTask = useMemo(() => {
    if (ticket?.supervisorTaskId && tasks[ticket.supervisorTaskId]) {
      return tasks[ticket.supervisorTaskId];
    }
    return Object.values(tasks).find((t) => t.ticketId === ticketId);
  }, [ticket, tasks, ticketId]);

  const activeTask = useMemo(() => {
    if (!supervisorTask) return undefined;
    const { type } = supervisorTask.status;
    return type === 'running' || type === 'connecting' || type === 'starting' ? supervisorTask : undefined;
  }, [supervisorTask]);

  const runningData = supervisorTask?.status.type === 'running' || supervisorTask?.status.type === 'connecting' ? supervisorTask.status.data : undefined;
  const isContainerLive = supervisorTask?.status.type === 'running' || supervisorTask?.status.type === 'connecting' || supervisorTask?.status.type === 'starting';

  const theme = store.theme ?? 'tokyo-night';

  useEffect(() => {
    if (!project?.workspaceDir) {
      setGitInfo(null);
      return;
    }
    ticketApi.checkGitRepo(project.workspaceDir).then((info) => {
      setGitInfo(info);
    });
  }, [project?.workspaceDir]);

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
      void ticketApi.updateTicket(ticketId, { title: trimmed });
    }
    setEditingTitle(false);
  }, [editTitle, ticket, ticketId]);

  const handleStartEditBranch = useCallback(() => {
    if (!ticket) return;
    setEditBranch(ticket.branch ?? '');
    setEditingBranch(true);
  }, [ticket]);

  const handleCancelEditBranch = useCallback(() => {
    setEditingBranch(false);
  }, []);

  const handleSaveBranch = useCallback(() => {
    if (!ticket) return;
    void ticketApi.updateTicket(ticketId, {
      branch: editBranch || undefined,
    });
    setEditingBranch(false);
  }, [editBranch, ticket, ticketId]);

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

  // Auto-start the sandbox (without sending a prompt) so the web UI loads.
  // Skip in compact/deck mode — don't spin up sandboxes for every visible column.
  const infraStarted = useRef(false);
  useEffect(() => {
    if (compact || activeTab !== 'Chat') {
      return;
    }
    const phase = ticket?.phase;
    const hasRunningTask = !!activeTask;
    if (!hasRunningTask && (!phase || phase === 'idle') && !infraStarted.current) {
      infraStarted.current = true;
      void ticketApi.ensureSupervisorInfra(ticketId);
    }
  }, [compact, activeTab, ticket?.phase, activeTask, ticketId]);

  const handleStartSupervisor = useCallback(() => {
    ticketApi.startSupervisor(ticketId);
  }, [ticketId]);

  const handleOpenManual = useCallback(() => {
    ticketApi.ensureSupervisorInfra(ticketId);
  }, [ticketId]);

  const handleStopSupervisor = useCallback(() => {
    ticketApi.stopSupervisor(ticketId);
  }, [ticketId]);

  const handleResetSession = useCallback(() => {
    ticketApi.resetSupervisorSession(ticketId);
  }, [ticketId]);

  const handleDelete = useCallback(() => {
    ticketApi.removeTicket(ticketId);
  }, [ticketId]);

  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const columnMenuRef = useRef<HTMLDivElement>(null);

  const handleColumnBadgeClick = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    setColumnMenuOpen((prev) => !prev);
  }, []);

  const handleMoveToColumn = useCallback(
    (columnId: string) => {
      ticketApi.moveTicketToColumn(ticketId, columnId);
      setColumnMenuOpen(false);
    },
    [ticketId]
  );

  // Close column menu on outside click
  useEffect(() => {
    if (!columnMenuOpen) {
return;
}
    const handleClickOutside = (e: Event) => {
      if (columnMenuRef.current && !columnMenuRef.current.contains(e.target as Node)) {
        setColumnMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [columnMenuOpen]);

  const [resolveMenuOpen, setResolveMenuOpen] = useState(false);
  const resolveMenuRef = useRef<HTMLDivElement>(null);

  const isTerminalColumn = useMemo(() => {
    if (!pipeline || !ticket) return false;
    const terminalId = pipeline.columns[pipeline.columns.length - 1]?.id;
    return ticket.columnId === terminalId;
  }, [pipeline, ticket]);

  const handleResolveClick = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    setResolveMenuOpen((prev) => !prev);
  }, []);

  const handleResolve = useCallback(
    (resolution: TicketResolution) => {
      ticketApi.resolveTicket(ticketId, resolution);
      setResolveMenuOpen(false);
    },
    [ticketId]
  );

  useEffect(() => {
    if (!resolveMenuOpen) return;
    const handleClickOutside = (e: Event) => {
      if (resolveMenuRef.current && !resolveMenuRef.current.contains(e.target as Node)) {
        setResolveMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [resolveMenuOpen]);

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
  const showTabs = true;

  return (
    <div className="flex flex-col w-full h-full">
      {/* Header — includes phase indicator + actions in compact mode */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface-border shrink-0">
        {dragHandleProps && (
          <button
            type="button"
            className="inline-flex items-center justify-center size-7 rounded-md text-fg-muted hover:text-fg hover:bg-white/5 cursor-grab active:cursor-grabbing"
            {...dragHandleProps.attributes}
            {...dragHandleProps.listeners}
            aria-label="Reorder"
          >
            <PiDotsSixVerticalBold size={14} />
          </button>
        )}

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm font-semibold text-fg truncate">{project?.label ?? 'Workspace'}</span>
        </div>

        {/* Compact phase indicator — replaces ModeBar row */}
        {compact && <CompactPhaseIndicator phase={phase} isContainerLive={!!isContainerLive} onStart={handleStartSupervisor} onOpenManual={handleOpenManual} onStop={handleStopSupervisor} onReset={handleResetSession} />}

        {onToggleExpand && (
          <IconButton
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            icon={isExpanded ? <PiArrowsInBold /> : <PiArrowsOutBold />}
            size="sm"
            onClick={onToggleExpand}
          />
        )}
        {!compact && <IconButton aria-label="Delete ticket" icon={<PiTrashBold />} size="sm" onClick={handleDelete} />}
        {onClose && <IconButton aria-label="Close" icon={<PiXBold />} size="sm" onClick={onClose} />}
      </div>

      {/* Ticket banner */}
      <div className="flex items-center gap-2 px-3 py-1 border-b border-surface-border bg-surface-raised/50 shrink-0">
        {editingTitle ? (
          <input
            type="text"
            value={editTitle}
            onChange={handleEditTitleChange}
            onBlur={handleSaveTitle}
            onKeyDown={handleTitleKeyDown}
            autoFocus
            className="flex-1 min-w-0 rounded-md border border-accent-500 bg-surface px-2 py-0.5 text-xs text-fg focus:outline-none"
          />
        ) : (
          <button
            onClick={handleStartEditTitle}
            className="flex items-center gap-1 min-w-0 group/title cursor-pointer"
          >
            <span className="text-xs text-fg-muted truncate">{ticket.title}</span>
            <PiPencilSimpleBold
              size={10}
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
        {!compact && (
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
              TICKET_PRIORITY_COLORS[ticket.priority]
            )}
          >
            {TICKET_PRIORITY_LABELS[ticket.priority]}
          </span>
        )}
        {!compact && ticket.resolution && (
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
              RESOLUTION_COLORS[ticket.resolution]
            )}
          >
            {RESOLUTION_LABELS[ticket.resolution]}
          </span>
        )}
        {!compact && !ticket.resolution && !isTerminalColumn && (
          <div className="relative shrink-0" ref={resolveMenuRef}>
            <button
              type="button"
              aria-label="Ticket menu"
              title="Ticket menu"
              onClick={handleResolveClick}
              className="inline-flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-white/5 hover:text-fg transition-colors"
            >
              <PiDotsThreeBold size={14} />
            </button>
            {resolveMenuOpen && (
              <div className="absolute top-full right-0 mt-1 z-50 min-w-[140px] rounded-md border border-surface-border bg-surface shadow-lg py-1">
                {(['completed', 'wont_do', 'duplicate', 'cancelled'] as TicketResolution[]).map((res) => (
                  <button
                    key={res}
                    type="button"
                    onClick={() => handleResolve(res)}
                    className="w-full text-left px-3 py-1.5 text-xs text-fg hover:bg-surface-hover cursor-pointer transition-colors"
                  >
                    {RESOLUTION_LABELS[res]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!compact && initiative && !initiative.isDefault && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 text-sky-400 bg-sky-400/10">
            {initiative.title}
          </span>
        )}
        {!compact && gitInfo?.isGitRepo && (
          <button
            type="button"
            onClick={handleStartEditBranch}
            className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 text-purple-400 bg-purple-400/10 hover:brightness-125 transition-all"
          >
            <PiGitBranchBold size={10} />
            {ticket.branch || initiative?.branch || 'Set branch'}
            {!ticket.branch && initiative?.branch ? ' (inherited)' : ''}
            <PiPencilSimpleBold size={10} />
          </button>
        )}
      </div>

      {editingBranch && gitInfo?.isGitRepo && (
        <div className="flex items-center gap-3 px-3 py-2 border-b border-surface-border bg-surface-raised/30 shrink-0 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-fg-subtle">Branch</label>
            <select
              value={editBranch}
              onChange={(e) => setEditBranch(e.target.value)}
              className="rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent-500"
            >
              <option value="">{initiative?.branch ? `Inherit from initiative (${initiative.branch})` : 'None'}</option>
              {gitInfo.branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </div>
          <span className="text-xs text-fg-muted">
            Tickets with a branch open in an isolated workspace.
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSaveBranch}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancelEditBranch}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Tab bar — hidden in compact mode when idle */}
      {showTabs && (
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
                  layoutId={`ticket-tab-indicator-${ticketId}`}
                  className="absolute inset-0 bg-white/10 rounded-md"
                  transition={{ type: 'spring', duration: 0.3, bounce: 0.15 }}
                />
              )}
              <span className="relative z-10">{tab}</span>
            </button>
          ))}
        </div>
      )}

      {/* Tab content */}
      {activeTab === 'Chat' && (
        <TicketChatTab
          ticketId={ticketId}
          compact={compact}
          phase={phase}
          supervisorUiUrl={supervisorUiUrl}
          codeServerUrl={codeServerUrl}
          noVncUrl={noVncUrl}
          isContainerLive={!!isContainerLive}
          hasActiveTask={!!activeTask}
          onStart={handleStartSupervisor}
          onOpenManual={handleOpenManual}
          onStop={handleStopSupervisor}
          onReset={handleResetSession}
          sandboxLabel={sandboxLabel}
        />
      )}
      {activeTab === 'Overview' && (
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          <TicketOverviewTab ticket={ticket} />
        </div>
      )}
      {activeTab === 'PR' && (
        <div className="flex-1 min-h-0">
          <TicketPRTab ticketId={ticketId} />
        </div>
      )}
      {activeTab === 'Artifacts' && (
        <div className="flex-1 min-h-0">
          <TicketArtifactsTab ticketId={ticketId} />
        </div>
      )}
    </div>
  );
});
TicketDetail.displayName = 'TicketDetail';

// --- Mode bar: shows current session mode + contextual actions ---

// --- Compact phase indicator (inline in header for deck mode) ---

const CompactPhaseIndicator = memo(
  ({ phase, isContainerLive, onStart, onOpenManual, onStop, onReset }: { phase: TicketPhase | undefined; isContainerLive: boolean; onStart: () => void; onOpenManual: () => void; onStop: () => void; onReset: () => void }) => {
    const isAutonomous = phase === 'running' || phase === 'continuing';
    const isProvisioning = phase === 'provisioning' || phase === 'connecting' || phase === 'session_creating';
    const isRetrying = phase === 'retrying';
    const isAwaitingInput = phase === 'awaiting_input';
    const isError = phase === 'error';
    const isCompleted = phase === 'completed';
    const isManual = isContainerLive && !isAutonomous && !isProvisioning && !isRetrying && !isError && !isCompleted && !isAwaitingInput;

    if (isAutonomous) {
      return (
        <div className="flex items-center gap-1.5 shrink-0">
          <PiArrowsClockwiseBold size={10} className="text-green-400 animate-spin" />
          <span className="text-[10px] text-green-400 font-medium">Working</span>
          <IconButton aria-label="Stop" icon={<PiStopFill size={10} />} size="sm" onClick={onStop} />
        </div>
      );
    }
    if (isProvisioning) {
      return (
        <div className="flex items-center gap-1.5 shrink-0">
          <Spinner size="sm" />
        </div>
      );
    }
    if (isAwaitingInput) {
      return (
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="size-1.5 rounded-full bg-blue-400 animate-pulse" />
          <span className="text-[10px] text-blue-400 font-medium">Needs input</span>
          <IconButton aria-label="Stop" icon={<PiStopFill size={10} />} size="sm" onClick={onStop} />
        </div>
      );
    }
    if (isRetrying) {
      return (
        <div className="flex items-center gap-1.5 shrink-0">
          <PiArrowsClockwiseBold size={10} className="text-yellow-400 animate-spin" />
          <span className="text-[10px] text-yellow-400 font-medium">Retrying</span>
          <IconButton aria-label="Stop" icon={<PiStopFill size={10} />} size="sm" onClick={onStop} />
        </div>
      );
    }
    if (isError) {
      return (
        <div className="flex items-center gap-1.5 shrink-0">
          <PiWarningCircleBold size={12} className="text-red-400" />
          <IconButton aria-label="New session" icon={<PiPlusBold size={10} />} size="sm" onClick={onReset} />
          <Button size="sm" leftIcon={<PiPlayFill size={10} />} onClick={onStart}>
            Retry
          </Button>
        </div>
      );
    }
    if (isCompleted) {
      return (
        <div className="flex items-center gap-1.5 shrink-0">
          <PiCheckCircleBold size={12} className="text-green-400" />
          <span className="text-[10px] text-green-400 font-medium">Done</span>
          <IconButton aria-label="New session" icon={<PiPlusBold size={10} />} size="sm" onClick={onReset} />
        </div>
      );
    }
    if (isManual) {
      return (
        <div className="flex items-center gap-1.5 shrink-0">
          <IconButton aria-label="New session" icon={<PiPlusBold size={10} />} size="sm" onClick={onReset} />
          <Button size="sm" leftIcon={<PiPlayFill size={10} />} onClick={onStart}>
            Autopilot
          </Button>
        </div>
      );
    }
    // Idle — nothing running
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <Button size="sm" variant="ghost" onClick={onOpenManual}>
          Chat
        </Button>
        <Button size="sm" leftIcon={<PiPlayFill size={10} />} onClick={onStart}>
          Autopilot
        </Button>
      </div>
    );
  }
);
CompactPhaseIndicator.displayName = 'CompactPhaseIndicator';

// --- ModeBar (full-width, used in non-compact/focus mode) ---

type ModeBarProps = {
  phase: TicketPhase | undefined;
  isContainerLive: boolean;
  hasActiveTask: boolean;
  onStart: () => void;
  onOpenManual: () => void;
  onStop: () => void;
  onReset: () => void;
};

const ModeBar = memo(({ phase, isContainerLive, hasActiveTask, onStart, onOpenManual, onStop, onReset }: ModeBarProps) => {
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
        </div>
      )}

      {/* Manual session — workspace open, no agent running */}
      {isManual && !isCompleted && !isAwaitingInput && (
        <div className="flex items-center gap-2 flex-1">
          <div className="flex-1" />
          <IconButton aria-label="New session" icon={<PiPlusBold />} size="sm" onClick={onReset} />
          <Button size="sm" leftIcon={<PiPlayFill size={12} />} onClick={onStart}>
            Autopilot
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
          <IconButton aria-label="New session" icon={<PiPlusBold />} size="sm" onClick={onReset} />
          <Button size="sm" leftIcon={<PiPlayFill size={12} />} onClick={onStart}>
            Run Again
          </Button>
        </div>
      )}

      {/* Idle — not started yet */}
      {!isContainerLive && !isProvisioning && !isError && !isCompleted && (
        <div className="flex items-center gap-2 flex-1">
          <span className="text-xs text-fg-muted">Ready to start</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={onOpenManual}>
            Chat
          </Button>
          <Button size="sm" leftIcon={<PiPlayFill size={12} />} onClick={onStart}>
            Autopilot
          </Button>
        </div>
      )}
    </div>
  );
});
ModeBar.displayName = 'ModeBar';

// --- Chat tab content ---

type MainView = 'agent' | 'code' | 'vnc';

type ChatTabProps = {
  ticketId: TicketId;
  compact?: boolean;
  phase: TicketPhase | undefined;
  supervisorUiUrl: string | undefined;
  codeServerUrl: string | undefined;
  noVncUrl: string | undefined;
  isContainerLive: boolean;
  hasActiveTask: boolean;
  onStart: () => void;
  onOpenManual: () => void;
  onStop: () => void;
  onReset: () => void;
  sandboxLabel?: string;
};

const TicketChatTab = memo(
  ({
    compact: chatCompact,
    phase,
    supervisorUiUrl,
    codeServerUrl,
    noVncUrl,
    isContainerLive,
    hasActiveTask,
    onStart,
    onOpenManual,
    onStop,
    onReset,
    sandboxLabel,
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
    const isSupervisorMain = mainView === 'agent' && !!supervisorUiUrl;
    const isSupervisorSplit = splitSrc === supervisorUiUrl;

    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {!chatCompact && (
          <ModeBar
            phase={phase}
            isContainerLive={isContainerLive}
            hasActiveTask={hasActiveTask}
            onStart={onStart}
            onOpenManual={onOpenManual}
            onStop={onStop}
            onReset={onReset}
          />
        )}
        <div className="flex-1 min-h-0 relative">
          {showWebview ? (
            <div className="h-full relative">
              {splitSrc && mainSrc ? (
                <CodeSplitLayout
                  codeServerSrc={mainSrc}
                  uiSrc={splitSrc}
                  codeServerMode={isSupervisorMain ? 'omniagents' : 'webview'}
                  uiMode={isSupervisorSplit ? 'omniagents' : 'webview'}
                  sandboxLabel={sandboxLabel}
                />
              ) : isSupervisorMain ? (
                <OmniAgentsApp key={supervisorUiUrl} uiUrl={mainSrc ?? supervisorUiUrl} sandboxLabel={sandboxLabel} />
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
          ) : phase && phase !== 'idle' && phase !== 'completed' ? (
            <div className="w-full h-full flex items-center justify-center">
              <div className="inline-flex items-center gap-2 rounded-full bg-surface-raised px-4 py-2">
                <Spinner size="sm" />
                <span className="text-sm text-fg-muted">Connecting…</span>
              </div>
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-sm text-fg-subtle">Start a run to begin working on this ticket</span>
            </div>
          )}
        </div>
      </div>
    );
  }
);
TicketChatTab.displayName = 'TicketChatTab';
