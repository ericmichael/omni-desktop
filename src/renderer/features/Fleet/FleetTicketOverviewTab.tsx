import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiCaretDownBold, PiPencilSimpleBold } from 'react-icons/pi';

import { Button, cn, IconButton } from '@/renderer/ds';
import type { FleetPhase, FleetPipeline, FleetTicket } from '@/shared/types';

import { PHASE_STATUS_COLORS, PHASE_STATUS_LABELS, TICKET_STATUS_COLORS, TICKET_STATUS_LABELS } from './fleet-constants';
import { $fleetTasks, $fleetTickets, fleetApi } from './state';

type FleetTicketOverviewTabProps = {
  ticket: FleetTicket;
  pipeline: FleetPipeline | null;
};

export const FleetTicketOverviewTab = memo(({ ticket, pipeline }: FleetTicketOverviewTabProps) => {
  const tickets = useStore($fleetTickets);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editDescription, setEditDescription] = useState('');

  const blockerTickets = useMemo(() => {
    return ticket.blockedBy.flatMap((id) => {
      const t = tickets[id];
      return t ? [t] : [];
    });
  }, [ticket, tickets]);

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

  const handleStartEditDescription = useCallback(() => {
    setEditDescription(ticket.description);
    setEditingDescription(true);
  }, [ticket]);

  const handleEditDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditDescription(e.target.value);
  }, []);

  const handleSaveDescription = useCallback(() => {
    if (editDescription !== ticket.description) {
      void fleetApi.updateTicket(ticket.id, { description: editDescription });
    }
    setEditingDescription(false);
  }, [editDescription, ticket]);

  const handleDescriptionKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setEditingDescription(false);
    }
  }, []);

  const handleCancelEditDescription = useCallback(() => {
    setEditingDescription(false);
  }, []);

  return (
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

      {/* History */}
      {ticket.phases.length > 0 && <HistorySection ticket={ticket} columnLookup={columnLookup} />}
    </div>
  );
});
FleetTicketOverviewTab.displayName = 'FleetTicketOverviewTab';

// --- Sub-components ---

const HistorySection = memo(
  ({ ticket, columnLookup }: { ticket: FleetTicket; columnLookup: Record<string, string> }) => {
    const [expanded, setExpanded] = useState(false);

    const toggleExpanded = useCallback(() => {
      setExpanded((prev) => !prev);
    }, []);

    return (
      <div className="flex flex-col gap-0">
        <button
          type="button"
          onClick={toggleExpanded}
          className="flex items-center gap-1.5 text-sm font-medium text-fg-muted hover:text-fg transition-colors cursor-pointer"
        >
          <PiCaretDownBold size={12} className={cn('transition-transform', expanded ? '' : '-rotate-90')} />
          History
          <span className="text-[10px] text-fg-subtle">({ticket.phases.length})</span>
        </button>
        {expanded && (
          <div className="flex flex-col gap-0 mt-2">
            {ticket.phases.map((phase) => (
              <PhaseTimelineItem
                key={phase.id}
                phase={phase}
                columnLabel={columnLookup[phase.columnId] ?? phase.columnId}
                isCurrent={phase.id === ticket.currentPhaseId}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
);
HistorySection.displayName = 'HistorySection';

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
