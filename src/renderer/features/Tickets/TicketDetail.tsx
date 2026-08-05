import { useStore } from '@nanostores/react';
import { Edit, Ellipsis, GitFork, GripVertical, Maximize2, MessageCircle, Minimize2, Play, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Switch } from '@/renderer/ds/ui/switch';
import { openTicketInCode } from '@/renderer/services/navigation';
import { persistedStoreApi } from '@/renderer/services/store';
import type { GitRepoInfo, TicketId, TicketPhase } from '@/shared/types';
import { firstSource } from '@/shared/types';

import { ProjectPageHeader } from './ProjectPageHeader';
import { $tickets, ticketApi } from './state';
import { TicketOverviewTab } from './TicketOverviewTab';
import { TicketResults } from './TicketResults';

type DragHandleProps = {
  attributes: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  listeners: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
};

type TicketDetailProps = {
  ticketId: TicketId;
  compact?: boolean;
  hideTitleBar?: boolean;
  onClose?: () => void;
  closeBehavior?: 'close' | 'back';
  dragHandleProps?: DragHandleProps;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
};

export const TicketDetail = memo(
  ({
    ticketId,
    compact,
    hideTitleBar = false,
    onClose,
    closeBehavior = 'close',
    dragHandleProps,
    isExpanded,
    onToggleExpand,
  }: TicketDetailProps) => {
    const tickets = useStore($tickets);
    const store = useStore(persistedStoreApi.$atom);
    const ticket = tickets[ticketId];
    const project = useMemo(
      () => store.projects.find((p) => p.id === ticket?.projectId) ?? null,
      [store.projects, ticket?.projectId]
    );
    const [editingTitle, setEditingTitle] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);
    const [editingBranch, setEditingBranch] = useState(false);
    const [editBranch, setEditBranch] = useState('');
    const [editUseWorktree, setEditUseWorktree] = useState(true);

    useEffect(() => {
      const s = firstSource(project);
      if (s?.kind !== 'local') {
        setGitInfo(null);
        return;
      }
      ticketApi.checkGitRepo(s.workspaceDir).then((info) => {
        setGitInfo(info);
      });
    }, [project]);

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
      if (!ticket) {
        return;
      }
      setEditBranch(ticket.branch ?? '');
      setEditUseWorktree(ticket.useWorktree ?? false);
      setEditingBranch(true);
    }, [ticket]);

    const handleCancelEditBranch = useCallback(() => {
      setEditingBranch(false);
    }, []);

    const handleSaveBranch = useCallback(() => {
      if (!ticket) {
        return;
      }
      // Direct mode: clear the branch too — a ticket running against the
      // project's working tree doesn't own one, and leaving a stale value
      // would make the UI claim a branch the supervisor isn't using.
      void ticketApi.updateTicket(ticketId, {
        useWorktree: editUseWorktree,
        branch: editUseWorktree ? editBranch || undefined : undefined,
      });
      setEditingBranch(false);
    }, [editBranch, editUseWorktree, ticket, ticketId]);

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

    const handleOpenChat = useCallback(() => {
      void openTicketInCode(ticketId);
    }, [ticketId]);

    const handleStartAutopilot = useCallback(() => {
      ticketApi.requestStartSupervisor(ticketId);
    }, [ticketId]);

    const handleArchive = useCallback(() => {
      void ticketApi.updateTicket(ticketId, { archivedAt: Date.now() });
    }, [ticketId]);

    const handleUnarchive = useCallback(() => {
      void ticketApi.updateTicket(ticketId, { archivedAt: undefined });
    }, [ticketId]);

    const handleBranchChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
      setEditBranch(event.target.value);
    }, []);

    // -------------------------------------------------------------------------
    // Flush-on-unmount.
    //
    // The parent keys this component on `ticketId`, so navigating to a
    // different ticket fully remounts us — edit buffers (`editTitle`,
    // `editBranch`) can never cross ticket boundaries. But a mid-edit user
    // who navigates away without pressing Enter or blurring the input would
    // otherwise lose that edit. On unmount we call the latest save closures,
    // which close over the current buffers AND the current `ticketId`, so
    // any pending title/branch change lands on the right ticket.
    //
    // The save handlers are already idempotent: `handleSaveTitle` no-ops when
    // trimmed/unchanged, and `handleSaveBranch` only fires when we're
    // actively in edit mode (guarded below). Safe to call unconditionally.
    // -------------------------------------------------------------------------
    const flushRef = useRef<() => void>(() => {});
    flushRef.current = () => {
      if (editingTitle) {
        handleSaveTitle();
      }
      if (editingBranch) {
        handleSaveBranch();
      }
    };
    useEffect(() => {
      return () => {
        flushRef.current();
      };
    }, []);

    if (!ticket) {
      return (
        <div className="flex items-center justify-center h-full">
          <span className="text-sm">Task not found</span>
        </div>
      );
    }

    const phase = ticket.phase;
    const taskMenu = !compact && (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Task menu">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {hideTitleBar && (
            <DropdownMenuItem onClick={handleStartEditTitle}>
              <Edit />
              Rename task
            </DropdownMenuItem>
          )}
          {gitInfo?.isGitRepo && (
            <DropdownMenuItem onClick={handleStartEditBranch}>
              <GitFork />
              Technical details
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {ticket.archivedAt ? (
            <DropdownMenuItem onClick={handleUnarchive}>Unarchive task</DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={handleArchive}>Archive task</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );

    return (
      <div className="flex flex-col w-full max-w-full min-w-0 h-full overflow-hidden">
        {!hideTitleBar &&
          (onClose && closeBehavior === 'back' && ticket.projectId ? (
            /* Project task context: the standard sub-page header — small
        ancestors-only breadcrumb (Project › Tasks) above the real,
        click-to-rename page title, with the ticket controls on the
        title row. */
            <ProjectPageHeader
              title={
                editingTitle ? (
                  <Input
                    aria-label="Task title"
                    className={`${'flex-1 min-w-0 p-0 border-0 bg-transparent text-2xl font-semibold leading-8 text-foreground font-inherit focus:outline-none'} h-auto`}
                    value={editTitle}
                    onChange={handleEditTitleChange}
                    onBlur={handleSaveTitle}
                    onKeyDown={handleTitleKeyDown}
                    autoFocus
                  />
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    className="flex items-center justify-start gap-2 w-full max-w-full min-w-0 overflow-hidden p-0 border-0 bg-transparent cursor-pointer text-left text-foreground [&:hover_>_.editIcon]:opacity-100"
                    onClick={handleStartEditTitle}
                    title="Rename task"
                  >
                    <span className="flex-1 min-w-0 text-2xl font-semibold leading-8 wrap-anywhere">
                      {ticket.title}
                    </span>
                    <Edit
                      className={cn(
                        'shrink-0 text-muted-foreground opacity-0 transition-opacity duration-100',
                        'editIcon'
                      )}
                    />
                  </Button>
                )
              }
              actions={
                <>
                  <PhaseStatus phase={phase} onChat={handleOpenChat} onAutopilot={handleStartAutopilot} />
                  {taskMenu}
                </>
              }
            />
          ) : (
            /* Panel context (Code deck side panel): compact single row. */
            <div
              className={cn(
                'flex items-center gap-2 pl-4 pr-2 pt-2 pb-2 shrink-0',
                !editingBranch && 'border-b border-border'
              )}
            >
              {dragHandleProps && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Reorder"
                  className="cursor-grab active:cursor-grabbing"
                  {...dragHandleProps.attributes}
                  {...dragHandleProps.listeners}
                >
                  <GripVertical />
                </Button>
              )}

              {editingTitle ? (
                <Input
                  type="text"
                  value={editTitle}
                  onChange={handleEditTitleChange}
                  onBlur={handleSaveTitle}
                  onKeyDown={handleTitleKeyDown}
                  autoFocus
                  className="flex-1 min-w-0"
                />
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleStartEditTitle}
                  className="min-w-0 flex-1 justify-start [&:hover_>_.editIcon]:opacity-100"
                >
                  <h2
                    className={cn(
                      'font-display text-lg font-semibold tracking-tight',
                      'overflow-hidden text-ellipsis whitespace-nowrap'
                    )}
                  >
                    {ticket.title}
                  </h2>
                  <Edit
                    className={cn(
                      'shrink-0 text-muted-foreground opacity-0 transition-opacity duration-100',
                      'editIcon'
                    )}
                  />
                </Button>
              )}

              <PhaseStatus phase={phase} onChat={handleOpenChat} onAutopilot={handleStartAutopilot} />
              {taskMenu}

              {onToggleExpand && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  onClick={onToggleExpand}
                >
                  {isExpanded ? <Minimize2 /> : <Maximize2 />}
                </Button>
              )}
              {onClose && closeBehavior === 'close' && (
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
                  <X />
                </Button>
              )}
            </div>
          ))}

        {/* Mobile: the TopAppBar owns back + title; this row carries the
                Omni actions (additional fields live under More details).
                Rename swaps the row for the title input. */}
        {hideTitleBar && (
          <div
            className={cn(
              'flex items-center flex-wrap gap-1 pl-4 pr-2 pt-1 pb-1 shrink-0',
              !editingBranch && 'border-b border-border'
            )}
          >
            {editingTitle ? (
              <Input
                type="text"
                value={editTitle}
                onChange={handleEditTitleChange}
                onBlur={handleSaveTitle}
                onKeyDown={handleTitleKeyDown}
                autoFocus
                className="flex-1 min-w-0"
              />
            ) : (
              <>
                <div className="flex-1" />
                <PhaseStatus phase={phase} onChat={handleOpenChat} onAutopilot={handleStartAutopilot} />
                {taskMenu}
              </>
            )}
          </div>
        )}

        {/* Branch edit (conditional) */}
        {editingBranch && gitInfo?.isGitRepo && (
          <div className="flex flex-col gap-2 pl-4 pr-4 pt-2 pb-2 border-b border-border bg-card shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium text-muted-foreground">Isolated worktree</span>
              <Switch
                checked={editUseWorktree}
                onCheckedChange={setEditUseWorktree}
                disabled={Boolean(ticket.worktreePath)}
              />
            </div>
            {editUseWorktree && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-medium text-muted-foreground">Branch</span>
                <Select value={editBranch} onChange={handleBranchChange}>
                  <option value="">None</option>
                  {gitInfo.branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <span className="text-xs text-muted-foreground text-foreground/80">
              {ticket.worktreePath
                ? 'Clean up the active worktree before switching modes.'
                : editUseWorktree
                  ? 'The agent works in its own branch + worktree, isolated from the main checkout.'
                  : 'The agent works directly in the project checkout. Only one direct-mode task can run at a time.'}
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

        <div className="flex-1 min-w-0 min-h-0 w-full max-w-full overflow-x-hidden overflow-y-auto p-5 sm:p-8">
          <div className="flex w-full max-w-4xl min-w-0 ml-auto mr-auto flex-col gap-8">
            <TicketOverviewTab ticket={ticket} compact={compact} />
            <TicketResults ticket={ticket} />
          </div>
        </div>
      </div>
    );
  }
);
TicketDetail.displayName = 'TicketDetail';

// --- Phase status (read-only badge + action buttons) ---

const PHASE_BADGE: Partial<Record<TicketPhase, { label: string }>> = {
  running: { label: 'Omni is working' },
  provisioning: { label: 'Starting' },
  connecting: { label: 'Starting' },
  session_creating: { label: 'Starting' },
  completed: { label: 'Ready to check' },
};

const PhaseStatus = memo(
  ({ phase, onChat, onAutopilot }: { phase: TicketPhase | undefined; onChat: () => void; onAutopilot: () => void }) => {
    const badge = phase ? PHASE_BADGE[phase] : undefined;
    if (phase === 'error') {
      return (
        <div className="flex items-center gap-1 shrink-0">
          <Badge variant="secondary">Needs attention</Badge>
          <Button size="sm" variant="ghost" onClick={onChat}>
            <MessageCircle />
            Ask Omni
          </Button>
          <Button size="sm" onClick={onAutopilot}>
            <Play />
            Try again
          </Button>
        </div>
      );
    }
    if (badge) {
      return (
        <div className="flex items-center gap-1 shrink-0">
          <Badge variant="secondary">{badge.label}</Badge>
        </div>
      );
    }

    // Idle — show action buttons
    return (
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" onClick={onChat}>
          <MessageCircle />
          Ask Omni
        </Button>
        <Button size="sm" onClick={onAutopilot}>
          <Play />
          Start task
        </Button>
      </div>
    );
  }
);
PhaseStatus.displayName = 'PhaseStatus';
