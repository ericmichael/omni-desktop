import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import {
  PiArrowLeftBold,
  PiArrowsClockwiseBold,
  PiCheckCircleBold,
  PiCodeBold,
  PiMonitorBold,
  PiPencilSimpleBold,
  PiPlayFill,
  PiPlusBold,
  PiStopFill,
  PiTrashFill,
  PiXCircleBold,
} from 'react-icons/pi';

import { Button, cn, Heading, IconButton } from '@/renderer/ds';
import type { FleetChecklistItem, FleetColumn, FleetColumnId, FleetPhase, FleetTicketId } from '@/shared/types';

import {
  COLUMN_BADGE_COLORS,
  PHASE_STATUS_COLORS,
  PHASE_STATUS_LABELS,
  TICKET_PRIORITY_COLORS,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_COLORS,
  TICKET_STATUS_LABELS,
} from './fleet-constants';
import { FleetTaskCard } from './FleetTaskCard';
import { $fleetPipeline, $fleetTasks, $fleetTickets, fleetApi } from './state';

function checklistToMarkdown(columns: FleetColumn[], checklist: Record<string, FleetChecklistItem[]>): string {
  return columns
    .map((col) => {
      const items = checklist[col.id] ?? [];
      const lines = items.map((item) => `- [${item.completed ? 'x' : ' '}] ${item.text}`);
      return `## ${col.label}\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

function markdownToChecklist(md: string, columns: FleetColumn[]): Record<string, FleetChecklistItem[]> {
  const result: Record<string, FleetChecklistItem[]> = {};
  for (const col of columns) {
    result[col.id] = [];
  }

  const labelToId = new Map<string, string>();
  for (const col of columns) {
    labelToId.set(col.label.trim().toLowerCase(), col.id);
  }

  let currentColId: string | null = null;
  for (const line of md.split('\n')) {
    const headingMatch = /^## (.+)$/.exec(line);
    if (headingMatch) {
      const label = (headingMatch[1] ?? '').trim().toLowerCase();
      currentColId = labelToId.get(label) ?? null;
      continue;
    }

    if (!currentColId) {
      continue;
    }

    const itemMatch = /^- \[([ xX])\] (.+)$/.exec(line);
    if (itemMatch) {
      result[currentColId]?.push({
        id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: (itemMatch[2] ?? '').trim(),
        completed: itemMatch[1] !== ' ',
      });
      continue;
    }

    const bareMatch = /^- (.+)$/.exec(line);
    if (bareMatch) {
      result[currentColId]?.push({
        id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: (bareMatch[1] ?? '').trim(),
        completed: false,
      });
    }
  }

  return result;
}

export const FleetTicketDetail = memo(({ ticketId }: { ticketId: FleetTicketId }) => {
  const tickets = useStore($fleetTickets);
  const tasks = useStore($fleetTasks);
  const pipeline = useStore($fleetPipeline);
  const ticket = tickets[ticketId];
  const [rejectNote, setRejectNote] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [newChecklistText, setNewChecklistText] = useState<Record<string, string>>({});
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editingDescription, setEditingDescription] = useState(false);
  const [editDescription, setEditDescription] = useState('');
  const [editingChecklistMd, setEditingChecklistMd] = useState(false);
  const [checklistMd, setChecklistMd] = useState('');

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

  const blockerTickets = useMemo(() => {
    if (!ticket) {
      return [];
    }
    return ticket.blockedBy.flatMap((id) => {
      const t = tickets[id];
      return t ? [t] : [];
    });
  }, [ticket, tickets]);

  const linkedTask = useMemo(() => {
    if (!ticket?.taskId) {
      return undefined;
    }
    return tasks[ticket.taskId];
  }, [ticket, tasks]);

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

  // All pipeline columns for checklist editing, current column sorted first
  const checklistColumns = useMemo(() => {
    if (!pipeline || !ticket) {
      return [];
    }
    const currentColId = ticket.columnId;
    const ordered = [...pipeline.columns];
    if (currentColId) {
      ordered.sort((a, b) => {
        if (a.id === currentColId) {
          return -1;
        }
        if (b.id === currentColId) {
          return 1;
        }
        return 0;
      });
    }
    return ordered;
  }, [pipeline, ticket]);

  const columnLookup = useMemo(() => {
    if (!pipeline) {
      return {};
    }
    const map: Record<string, string> = {};
    for (const col of pipeline.columns) {
      map[col.id] = col.label;
    }
    return map;
  }, [pipeline]);

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

  // Inline description editing
  const handleStartEditDescription = useCallback(() => {
    if (ticket) {
      setEditDescription(ticket.description);
      setEditingDescription(true);
    }
  }, [ticket]);

  const handleEditDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditDescription(e.target.value);
  }, []);

  const handleSaveDescription = useCallback(() => {
    if (ticket && editDescription !== ticket.description) {
      void fleetApi.updateTicket(ticketId, { description: editDescription });
    }
    setEditingDescription(false);
  }, [editDescription, ticket, ticketId]);

  const handleDescriptionKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setEditingDescription(false);
    }
  }, []);

  const handleCancelEditDescription = useCallback(() => {
    setEditingDescription(false);
  }, []);

  const hasChecklist = useMemo(() => {
    if (!ticket) {
      return false;
    }
    return Object.values(ticket.checklist).some((items) => items.length > 0);
  }, [ticket]);

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

  // Checklist
  const handleToggleChecklistItem = useCallback(
    (columnId: string, itemId: string) => {
      fleetApi.toggleChecklistItem(ticketId, columnId, itemId);
    },
    [ticketId]
  );

  const handleNewChecklistTextChange = useCallback((columnId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    setNewChecklistText((prev) => ({ ...prev, [columnId]: e.target.value }));
  }, []);

  const handleAddChecklistItem = useCallback(
    (columnId: string) => {
      if (!ticket) {
        return;
      }
      const text = (newChecklistText[columnId] ?? '').trim();
      if (!text) {
        return;
      }
      const newItem: FleetChecklistItem = {
        id: `chk-${Date.now()}`,
        text,
        completed: false,
      };
      const existing = ticket.checklist[columnId] ?? [];
      fleetApi.updateChecklist(ticketId, columnId, [...existing, newItem]);
      setNewChecklistText((prev) => ({ ...prev, [columnId]: '' }));
    },
    [ticketId, ticket, newChecklistText]
  );

  const handleChecklistKeyDown = useCallback(
    (columnId: string, e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleAddChecklistItem(columnId);
      }
    },
    [handleAddChecklistItem]
  );

  const handleRejectKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleReject();
      }
    },
    [handleReject]
  );

  const handleRemoveChecklistItem = useCallback(
    (columnId: string, itemId: string) => {
      if (!ticket) {
        return;
      }
      const existing = ticket.checklist[columnId] ?? [];
      fleetApi.updateChecklist(
        ticketId,
        columnId,
        existing.filter((item) => item.id !== itemId)
      );
    },
    [ticketId, ticket]
  );

  // Markdown checklist editing
  const handleStartEditChecklistMd = useCallback(() => {
    if (ticket && pipeline) {
      setChecklistMd(checklistToMarkdown(pipeline.columns, ticket.checklist));
      setEditingChecklistMd(true);
    }
  }, [ticket, pipeline]);

  const handleChecklistMdChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setChecklistMd(e.target.value);
  }, []);

  const handleSaveChecklistMd = useCallback(() => {
    if (!pipeline) {
      return;
    }
    const parsed = markdownToChecklist(checklistMd, pipeline.columns);
    for (const col of pipeline.columns) {
      const items = parsed[col.id] ?? [];
      void fleetApi.updateChecklist(ticketId, col.id, items);
    }
    setEditingChecklistMd(false);
  }, [checklistMd, pipeline, ticketId]);

  const handleCancelChecklistMd = useCallback(() => {
    setEditingChecklistMd(false);
  }, []);

  if (!ticket) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-fg-muted text-sm">Ticket not found</p>
      </div>
    );
  }

  const hasColumnId = ticket.columnId !== null;
  const showLegacyLoop = !hasColumnId && ticket.loopEnabled && ticket.loopStatus;
  const showPhaseControls = hasColumnId && currentColumn && currentColumn.maxIterations > 0;
  const showGateActions = hasColumnId && currentColumn?.requiresApproval && currentPhase?.status === 'completed';

  return (
    <div className="flex flex-col w-full h-full overflow-y-auto">
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
            {/* Column badge or legacy status */}
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
            {currentPhase && (
              <span
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                  PHASE_STATUS_COLORS[currentPhase.status]
                )}
              >
                {PHASE_STATUS_LABELS[currentPhase.status]}
              </span>
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

      {/* Active Sandbox Banner */}
      {activeTask && (
        <button
          onClick={handleOpenSandbox}
          className="flex items-center gap-3 px-6 py-3 border-b border-surface-border bg-green-500/10 hover:bg-green-500/15 transition-colors cursor-pointer shrink-0"
        >
          <div className="size-2.5 rounded-full bg-green-400 animate-pulse" />
          <PiMonitorBold size={16} className="text-green-400" />
          <span className="text-sm font-medium text-green-400">
            {activeTask.status.type === 'running' ? 'Sandbox Running' : 'Sandbox Starting...'}
          </span>
          <span className="text-sm text-fg-muted">— Click to open sandbox UI</span>
        </button>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="flex flex-col gap-6 max-w-2xl">
          {/* Description */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 group/desc">
              <span className="text-sm font-medium text-fg">Description</span>
              {!editingDescription && (
                <IconButton
                  aria-label="Edit description"
                  icon={<PiPencilSimpleBold />}
                  size="sm"
                  onClick={handleStartEditDescription}
                  className="opacity-0 group-hover/desc:opacity-100 transition-opacity"
                />
              )}
            </div>
            {editingDescription ? (
              <div className="flex flex-col gap-2">
                <textarea
                  value={editDescription}
                  onChange={handleEditDescriptionChange}
                  onKeyDown={handleDescriptionKeyDown}
                  autoFocus
                  rows={5}
                  className="w-full rounded-md border border-accent-500 bg-surface px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none resize-y"
                  placeholder="Ticket description..."
                />
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={handleSaveDescription}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleCancelEditDescription}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : ticket.description ? (
              <p className="text-sm text-fg-muted whitespace-pre-wrap">{ticket.description}</p>
            ) : (
              <p className="text-sm text-fg-subtle italic">No description</p>
            )}
          </div>

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

          {/* Per-Column Checklist Editor */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-fg">Checklists</span>
              <IconButton
                aria-label="Edit as Markdown"
                icon={<PiCodeBold />}
                size="sm"
                onClick={editingChecklistMd ? handleCancelChecklistMd : handleStartEditChecklistMd}
                className={editingChecklistMd ? 'text-accent-500' : ''}
              />
            </div>
            {editingChecklistMd ? (
              <div className="flex flex-col gap-2">
                <textarea
                  value={checklistMd}
                  onChange={handleChecklistMdChange}
                  autoFocus
                  rows={16}
                  className="w-full rounded-md border border-accent-500 bg-surface px-3 py-2 text-sm text-fg font-mono placeholder:text-fg-muted/50 focus:outline-none resize-y"
                />
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={handleSaveChecklistMd}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleCancelChecklistMd}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              checklistColumns.map((col) => (
                <ChecklistColumnSection
                  key={col.id}
                  columnId={col.id}
                  columnLabel={col.label}
                  items={ticket.checklist[col.id] ?? []}
                  isCurrent={col.id === ticket.columnId}
                  newText={newChecklistText[col.id] ?? ''}
                  onToggle={handleToggleChecklistItem}
                  onRemove={handleRemoveChecklistItem}
                  onNewTextChange={handleNewChecklistTextChange}
                  onAdd={handleAddChecklistItem}
                  onKeyDown={handleChecklistKeyDown}
                />
              ))
            )}
          </div>

          {/* Phase Controls */}
          {showPhaseControls && currentPhase && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-fg">Phase Controls</span>
              <div className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface-overlay/50 p-3">
                {currentPhase.loop.status === 'running' && (
                  <>
                    <PiArrowsClockwiseBold size={16} className="text-green-400 animate-spin" />
                    <span className="text-sm text-fg">
                      Iteration {currentPhase.loop.currentIteration}/{currentPhase.loop.maxIterations}
                    </span>
                    <IconButton aria-label="Stop phase" icon={<PiStopFill />} size="sm" onClick={handleStopPhase} />
                  </>
                )}
                {currentPhase.status === 'pending' && (
                  <Button size="sm" onClick={handleStartPhase}>
                    <PiPlayFill size={12} className="mr-1" />
                    Start Phase
                  </Button>
                )}
                {(currentPhase.status === 'blocked' || currentPhase.loop.status === 'stopped') &&
                  currentPhase.status !== 'completed' && (
                    <Button size="sm" onClick={handleResumePhase}>
                      <PiArrowsClockwiseBold size={12} className="mr-1" />
                      Resume Phase
                    </Button>
                  )}
                {currentPhase.status === 'completed' && !showGateActions && (
                  <span className="text-sm text-fg-muted">Phase completed</span>
                )}
              </div>
            </div>
          )}

          {/* Gate Actions */}
          {showGateActions && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-fg">Approval Gate</span>
              <div className="flex flex-col gap-2 rounded-lg border border-surface-border bg-surface-overlay/50 p-3">
                <p className="text-sm text-fg-muted">This column requires approval before advancing.</p>
                {!showRejectInput ? (
                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={handleApprove}>
                      <PiCheckCircleBold size={12} className="mr-1" />
                      Approve
                    </Button>
                    <Button size="sm" variant="ghost" onClick={handleShowReject}>
                      <PiXCircleBold size={12} className="mr-1" />
                      Reject
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <input
                      type="text"
                      value={rejectNote}
                      onChange={handleRejectNoteChange}
                      placeholder="Rejection reason (required)..."
                      className="w-full rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
                      onKeyDown={handleRejectKeyDown}
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={handleReject} isDisabled={!rejectNote.trim()}>
                        Reject
                      </Button>
                      <Button size="sm" variant="ghost" onClick={handleCancelReject}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Legacy Loop Status (pre-migration compat) */}
          {showLegacyLoop && (
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

          {/* Linked Task (legacy) or phase task */}
          {(phaseTask ?? linkedTask) && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-fg">{phaseTask ? 'Current Phase Task' : 'Linked Task'}</span>
              <FleetTaskCard task={(phaseTask ?? linkedTask)!} />
            </div>
          )}

          {/* Phase Timeline */}
          {ticket.phases.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-fg">Phase History</span>
              <div className="flex flex-col gap-0">
                {ticket.phases.map((phase) => (
                  <PhaseTimelineItem
                    key={phase.id}
                    phase={phase}
                    columnLabel={columnLookup[phase.columnId] ?? phase.columnId}
                    isCurrent={phase.id === ticket.currentPhaseId}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
FleetTicketDetail.displayName = 'FleetTicketDetail';

// --- Sub-components ---

const ChecklistItemRow = memo(
  ({
    item,
    onToggle,
    onRemove,
  }: {
    item: FleetChecklistItem;
    onToggle: (id: string) => void;
    onRemove: (id: string) => void;
  }) => {
    const handleToggle = useCallback(() => {
      onToggle(item.id);
    }, [item.id, onToggle]);

    const handleRemove = useCallback(() => {
      onRemove(item.id);
    }, [item.id, onRemove]);

    return (
      <div className="flex items-center gap-2 group">
        <button
          onClick={handleToggle}
          className={cn(
            'size-4 rounded border shrink-0 flex items-center justify-center cursor-pointer transition-colors',
            item.completed
              ? 'bg-accent-500 border-accent-500 text-white'
              : 'border-surface-border hover:border-accent-500'
          )}
        >
          {item.completed && <PiCheckCircleBold size={10} />}
        </button>
        <span className={cn('flex-1 text-sm', item.completed ? 'text-fg-muted line-through' : 'text-fg')}>
          {item.text}
        </span>
        <IconButton
          aria-label="Remove item"
          icon={<PiTrashFill />}
          size="sm"
          onClick={handleRemove}
          className="opacity-0 group-hover:opacity-100 transition-opacity"
        />
      </div>
    );
  }
);
ChecklistItemRow.displayName = 'ChecklistItemRow';

const ChecklistColumnSection = memo(
  ({
    columnId,
    columnLabel,
    items,
    isCurrent,
    newText,
    onToggle,
    onRemove,
    onNewTextChange,
    onAdd,
    onKeyDown,
  }: {
    columnId: FleetColumnId;
    columnLabel: string;
    items: FleetChecklistItem[];
    isCurrent: boolean;
    newText: string;
    onToggle: (columnId: string, itemId: string) => void;
    onRemove: (columnId: string, itemId: string) => void;
    onNewTextChange: (columnId: string, e: React.ChangeEvent<HTMLInputElement>) => void;
    onAdd: (columnId: string) => void;
    onKeyDown: (columnId: string, e: React.KeyboardEvent) => void;
  }) => {
    const completedCount = items.filter((i) => i.completed).length;

    const handleToggle = useCallback(
      (itemId: string) => {
        onToggle(columnId, itemId);
      },
      [columnId, onToggle]
    );

    const handleRemove = useCallback(
      (itemId: string) => {
        onRemove(columnId, itemId);
      },
      [columnId, onRemove]
    );

    const handleTextChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        onNewTextChange(columnId, e);
      },
      [columnId, onNewTextChange]
    );

    const handleAdd = useCallback(() => {
      onAdd(columnId);
    }, [columnId, onAdd]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        onKeyDown(columnId, e);
      },
      [columnId, onKeyDown]
    );

    return (
      <div
        className={cn(
          'rounded-lg border p-3',
          isCurrent ? 'border-accent-500/50 bg-accent-500/5' : 'border-surface-border bg-surface-overlay/30'
        )}
      >
        <div className="flex items-center gap-2 mb-2">
          <span
            className={cn(
              'text-xs px-1.5 py-0.5 rounded-full font-medium',
              COLUMN_BADGE_COLORS[columnId] ?? 'text-fg-muted bg-fg-muted/10'
            )}
          >
            {columnLabel}
          </span>
          <span className="text-[10px] text-fg-muted">
            {completedCount}/{items.length}
          </span>
          {isCurrent && <span className="text-[10px] text-accent-500 font-medium">Current</span>}
        </div>
        {items.length > 0 && (
          <div className="flex flex-col gap-1 mb-2">
            {items.map((item) => (
              <ChecklistItemRow key={item.id} item={item} onToggle={handleToggle} onRemove={handleRemove} />
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newText}
            onChange={handleTextChange}
            placeholder="Add checklist item..."
            className="flex-1 rounded-md border border-surface-border bg-surface px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500"
            onKeyDown={handleKeyDown}
          />
          <IconButton
            aria-label="Add item"
            icon={<PiPlusBold />}
            size="sm"
            onClick={handleAdd}
            isDisabled={!newText.trim()}
          />
        </div>
      </div>
    );
  }
);
ChecklistColumnSection.displayName = 'ChecklistColumnSection';

const SENTINEL_COLORS: Record<string, string> = {
  BLOCKED: 'text-orange-400 bg-orange-400/10',
  TESTS_FAILING: 'text-red-400 bg-red-400/10',
  REJECTED: 'text-red-400 bg-red-400/10',
  CHECKLIST_COMPLETE: 'text-blue-400 bg-blue-400/10',
  NEEDS_REVIEW: 'text-yellow-400 bg-yellow-400/10',
};

const PhaseRunItem = memo(
  ({ taskId, index, total, sentinel }: { taskId: string; index: number; total: number; sentinel?: string }) => {
    const tasks = useStore($fleetTasks);
    const task = tasks[taskId];

    const statusLabel = task?.status.type ?? 'unknown';
    const statusColor =
      statusLabel === 'exited'
        ? 'text-fg-muted'
        : statusLabel === 'error'
          ? 'text-red-400'
          : statusLabel === 'running'
            ? 'text-green-400'
            : 'text-fg-subtle';

    const handleClick = useCallback(() => {
      fleetApi.goToTask(taskId);
    }, [taskId]);

    const label = total > 1 ? `Iteration ${index + 1} of ${total}` : 'View session';

    return (
      <button
        type="button"
        onClick={handleClick}
        className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-raised cursor-pointer text-left w-full"
      >
        <span className="text-xs text-fg shrink-0">{label}</span>
        <div className="flex-1" />
        {sentinel && (
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
              SENTINEL_COLORS[sentinel] ?? 'text-fg-muted bg-fg-muted/10'
            )}
          >
            {sentinel}
          </span>
        )}
        <span className={cn('text-[10px] shrink-0', statusColor)}>{statusLabel}</span>
      </button>
    );
  }
);
PhaseRunItem.displayName = 'PhaseRunItem';

const PhaseTimelineItem = memo(
  ({ phase, columnLabel, isCurrent }: { phase: FleetPhase; columnLabel: string; isCurrent: boolean }) => {
    const [expanded, setExpanded] = useState(false);
    const hasTasks = phase.taskIds.length > 0;

    const toggleExpanded = useCallback(() => {
      setExpanded((prev) => !prev);
    }, []);

    const formattedEntry = useMemo(() => {
      return new Date(phase.enteredAt).toLocaleString();
    }, [phase.enteredAt]);

    const formattedExit = useMemo(() => {
      if (!phase.exitedAt) {
        return null;
      }
      return new Date(phase.exitedAt).toLocaleString();
    }, [phase.exitedAt]);

    return (
      <div
        className={cn(
          'flex flex-col border-l-2 transition-colors',
          isCurrent ? 'border-l-accent-500 bg-accent-500/5' : 'border-l-surface-border'
        )}
      >
        <div
          role={hasTasks ? 'button' : undefined}
          tabIndex={hasTasks ? 0 : undefined}
          onClick={hasTasks ? toggleExpanded : undefined}
          className={cn('flex gap-3 py-2 pl-3 pr-2', hasTasks && 'cursor-pointer hover:bg-surface-raised')}
        >
          <div className="flex flex-col flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-fg">{columnLabel}</span>
              {phase.attempt > 1 && <span className="text-[10px] text-fg-subtle">Attempt #{phase.attempt}</span>}
              <span
                className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', PHASE_STATUS_COLORS[phase.status])}
              >
                {PHASE_STATUS_LABELS[phase.status]}
              </span>
              <div className="flex-1" />
              {hasTasks && (
                <span className="text-[10px] text-fg-subtle">
                  {phase.taskIds.length} {phase.taskIds.length === 1 ? 'run' : 'runs'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-fg-subtle">
              <span>{formattedEntry}</span>
              {formattedExit && (
                <>
                  <span>-</span>
                  <span>{formattedExit}</span>
                </>
              )}
            </div>
            {phase.exitSentinel && (
              <span className="text-[10px] text-fg-muted mt-0.5">Sentinel: {phase.exitSentinel}</span>
            )}
            {phase.reviewNote && <p className="text-xs text-fg-muted mt-1 italic">&quot;{phase.reviewNote}&quot;</p>}
            {phase.loop.status === 'running' && (
              <span className="text-[10px] text-green-400 mt-0.5">
                Loop: {phase.loop.currentIteration}/{phase.loop.maxIterations}
              </span>
            )}
          </div>
        </div>
        {expanded && hasTasks && (
          <div className="flex flex-col gap-0.5 pl-4 pr-2 pb-2">
            {phase.taskIds.map((tid, i) => {
              const isLast = i === phase.taskIds.length - 1;
              const sentinel = isLast
                ? (phase.exitSentinel ?? (phase.status === 'blocked' ? 'BLOCKED' : undefined))
                : undefined;
              return <PhaseRunItem key={tid} taskId={tid} index={i} total={phase.taskIds.length} sentinel={sentinel} />;
            })}
          </div>
        )}
      </div>
    );
  }
);
PhaseTimelineItem.displayName = 'PhaseTimelineItem';
