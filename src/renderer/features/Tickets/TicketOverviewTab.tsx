import { useStore } from '@nanostores/react';
import { Edit, TriangleAlert, X } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import Markdown from 'react-markdown';

import { cn } from '@/renderer/ds/cn';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Textarea } from '@/renderer/ds/ui/textarea';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { $members } from '@/renderer/features/Teams/state';
import { AssigneePicker } from '@/renderer/features/Tickets/AssigneePicker';
import { persistedStoreApi } from '@/renderer/services/store';
import type { MilestoneId, Ticket, TicketPriority } from '@/shared/types';

import { $pipeline, $tickets, ticketApi } from './state';
import { getColumnColors, PHASE_LABELS } from './ticket-constants';
import { TicketDiscussion } from './TicketDiscussion';

type TicketOverviewTabProps = {
  ticket: Ticket;
  /** Panel context (Code deck): stack the rail under the description. */
  compact?: boolean;
};

export const TicketOverviewTab = memo(({ ticket, compact }: TicketOverviewTabProps) => {
  const tickets = useStore($tickets);
  const pipeline = useStore($pipeline);
  const milestones = useStore($milestones);
  const members = useStore($members);
  const residents = useStore(persistedStoreApi.$atom).residentAgents;
  const [editingDescription, setEditingDescription] = useState(false);
  const [editDescription, setEditDescription] = useState('');

  const projectMilestones = useMemo(
    () =>
      Object.values(milestones).filter(
        (m) => m.projectId === ticket.projectId && (m.status === 'active' || m.id === ticket.milestoneId)
      ),
    [milestones, ticket.projectId, ticket.milestoneId]
  );

  const blockerTickets = useMemo(() => {
    return ticket.blockedBy.flatMap((id) => {
      const t = tickets[id];
      return t ? [t] : [];
    });
  }, [ticket, tickets]);

  const availableBlockers = useMemo(() => {
    const blocked = new Set(ticket.blockedBy);
    return Object.values(tickets).filter(
      (t) => t.id !== ticket.id && t.projectId === ticket.projectId && !blocked.has(t.id)
    );
  }, [ticket, tickets]);

  const handleColumnChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (e.target.value) {
        void ticketApi.moveTicketToColumn(ticket.id, e.target.value);
      }
    },
    [ticket.id]
  );

  const handlePriorityChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      void ticketApi.updateTicket(ticket.id, { priority: e.target.value as TicketPriority });
    },
    [ticket.id]
  );

  const handleMilestoneChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      void ticketApi.moveTicketToMilestone(ticket.id, (e.target.value || undefined) as MilestoneId | undefined);
    },
    [ticket.id]
  );

  const handleAddBlocker = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const blockerId = e.target.value;
      if (!blockerId) {
        return;
      }
      void ticketApi.updateTicket(ticket.id, { blockedBy: [...ticket.blockedBy, blockerId] });
    },
    [ticket.id, ticket.blockedBy]
  );

  const handleRemoveBlocker = useCallback(
    (blockerId: string) => {
      void ticketApi.updateTicket(ticket.id, { blockedBy: ticket.blockedBy.filter((id) => id !== blockerId) });
    },
    [ticket.id, ticket.blockedBy]
  );

  const handleStartEditDescription = useCallback(() => {
    setEditDescription(ticket.description);
    setEditingDescription(true);
  }, [ticket]);

  const handleEditDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditDescription(e.target.value);
  }, []);

  const handleSaveDescription = useCallback(() => {
    if (editDescription !== ticket.description) {
      void ticketApi.updateTicket(ticket.id, { description: editDescription });
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

  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const handleFinalizeCleanup = useCallback(async () => {
    setCleanupBusy(true);
    setCleanupError(null);
    try {
      const ok = await ticketApi.finalizeTicketCleanup(ticket.id);
      if (!ok) {
        setCleanupError('Worktree still has uncommitted changes. Commit or discard them first.');
      }
    } finally {
      setCleanupBusy(false);
    }
  }, [ticket.id]);

  return (
    <div className={cn('flex w-full min-w-0 max-w-none flex-col gap-8', compact && 'max-w-2xl')}>
      <aside
        className={cn('grid grid-cols-2 gap-4 rounded-xl border bg-card p-4', compact && 'grid-cols-1')}
        aria-label="Task properties"
      >
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</span>
          {pipeline && (
            <Select value={ticket.columnId ?? ''} onChange={handleColumnChange} className="w-full">
              {pipeline.columns.map((col) => (
                <option key={col.id} value={col.id}>
                  {col.label}
                </option>
              ))}
            </Select>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Priority</span>
          <Select value={ticket.priority} onChange={handlePriorityChange} className="w-full">
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Milestone</span>
          <Select value={ticket.milestoneId ?? ''} onChange={handleMilestoneChange} className="w-full">
            <option value="">No milestone</option>
            {projectMilestones.map((milestone) => (
              <option key={milestone.id} value={milestone.id}>
                {milestone.title || 'Untitled milestone'}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Assignee</span>
          {members.length > 0 || residents.some((agent) => agent.enabled) ? (
            <AssigneePicker ticketId={ticket.id} assignee={ticket.assignee} />
          ) : (
            <span className="text-sm text-muted-foreground">Unassigned</span>
          )}
        </div>
      </aside>

      {/* ── Main column: the ticket's content ── */}
      <div className="flex-1 min-w-0 flex flex-col gap-8 [@media(max-width:760px)]:w-full [@media(max-width:760px)]:flex-none">
        {ticket.cleanupPending && ticket.worktreePath && (
          <div className="flex flex-col gap-2 rounded-lg border border-warning bg-warning/10 p-4 text-warning">
            <div className="flex items-center gap-1.5 font-semibold">
              <TriangleAlert />
              Worktree has uncommitted changes — cleanup deferred
            </div>
            <div className="text-sm">
              This task is complete, but its worktree still has unsaved work. Commit or discard the changes, then click
              below to remove the worktree.
            </div>
            <div className="font-mono text-xs text-muted-foreground break-all">{ticket.worktreePath}</div>
            {cleanupError && (
              <div className="text-sm" role="alert">
                {cleanupError}
              </div>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={handleFinalizeCleanup} disabled={cleanupBusy}>
                {cleanupBusy ? 'Cleaning up…' : 'Clean up worktree'}
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-col min-w-0 max-w-full gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes</span>
            {!editingDescription && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Edit description"
                onClick={handleStartEditDescription}
              >
                <Edit />
              </Button>
            )}
          </div>
          {editingDescription ? (
            <div className="flex flex-col min-w-0 max-w-full gap-2">
              <Textarea
                value={editDescription}
                onChange={handleEditDescriptionChange}
                onKeyDown={handleDescriptionKeyDown}
                autoFocus
                rows={5}
                placeholder="Add notes, details, or a checklist..."
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
            <div
              className={`prose prose-sm max-w-none dark:prose-invert ${'min-w-0 max-w-full wrap-anywhere text-sm text-muted-foreground'} prose-code:before:content-none prose-code:after:content-none [&_code]:rounded [&_code]:bg-card [&_code]:px-1.5 [&_code]:py-0.5 [&_pre]:rounded-lg [&_pre]:bg-card [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_pre_code]:py-0`}
            >
              <Markdown>{ticket.description}</Markdown>
            </div>
          ) : (
            <Button
              variant="ghost"
              onClick={handleStartEditDescription}
              className="text-sm text-muted-foreground italic text-left cursor-pointer transition-colors duration-150 bg-transparent border-0 hover:text-muted-foreground"
            >
              Add notes or details
            </Button>
          )}
        </div>

        <div className="flex flex-col min-w-0 max-w-full gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Activity</span>
          <TicketDiscussion ticket={ticket} />
        </div>
      </div>

      <details className="rounded-xl border px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
          Dependencies and technical details
        </summary>
        <aside className={cn('mt-4 grid gap-5 sm:grid-cols-2', compact && 'grid-cols-1')} aria-label="Task details">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Dependencies</span>
            {blockerTickets.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {blockerTickets.map((blocker) => (
                  <div key={blocker.id} className="flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className={getColumnColors(blocker.columnId ?? 'backlog').badgeClassName}
                    >
                      {blocker.columnId ?? 'backlog'}
                    </Badge>
                    <span className="text-sm text-muted-foreground flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {blocker.title}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove blocker ${blocker.title}`}
                      onClick={() => handleRemoveBlocker(blocker.id)}
                    >
                      <X />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {availableBlockers.length > 0 && (
              <Select value="" onChange={handleAddBlocker} className="w-full">
                <option value="">Add dependency...</option>
                {availableBlockers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </Select>
            )}
            {blockerTickets.length === 0 && availableBlockers.length === 0 && (
              <p className="text-xs text-muted-foreground">No tasks available to block on</p>
            )}
          </div>

          {/* Autopilot status — hidden entirely when idle; raw phase values never
             render (PHASE_LABELS holds the human wording). */}
          {(ticket.autopilot || (ticket.phase && ticket.phase !== 'idle')) && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Omni</span>
              <div className="text-xs text-muted-foreground">
                {ticket.autopilot && <p>On</p>}
                {ticket.phase && ticket.phase !== 'idle' && PHASE_LABELS[ticket.phase] && (
                  <p>{PHASE_LABELS[ticket.phase]}</p>
                )}
              </div>
            </div>
          )}

          {ticket.tokenUsage && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Token Usage</span>
              <div className="flex flex-col gap-y-0.5 text-xs text-muted-foreground">
                <span>In: {ticket.tokenUsage.inputTokens.toLocaleString()}</span>
                <span>Out: {ticket.tokenUsage.outputTokens.toLocaleString()}</span>
                <span>Total: {ticket.tokenUsage.totalTokens.toLocaleString()}</span>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Details</span>
            <div className="flex flex-col gap-y-0.5 text-xs text-muted-foreground">
              <span>Created {new Date(ticket.createdAt).toLocaleDateString()}</span>
              <span>Updated {new Date(ticket.updatedAt).toLocaleDateString()}</span>
            </div>
          </div>
        </aside>
      </details>
    </div>
  );
});
TicketOverviewTab.displayName = 'TicketOverviewTab';
