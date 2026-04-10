import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiCheckCircleFill, PiStopFill } from 'react-icons/pi';

import { daysRemaining } from '@/lib/inbox-expiry';
import { AnimatedDialog, Button, cn, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds';
import { APPETITE_COLORS, APPETITE_LABELS } from '@/renderer/features/Inbox/shaping-constants';
import { PHASE_COLORS, PHASE_LABELS } from '@/renderer/features/Tickets/ticket-constants';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { persistedStoreApi } from '@/renderer/services/store';
import { isActivePhase } from '@/shared/ticket-phase';
import type { InboxItem, Ticket } from '@/shared/types';

type Step = 'completed' | 'active' | 'inbox' | 'done';
const STEPS: Step[] = ['completed', 'active', 'inbox', 'done'];

const STEP_TITLES: Record<Step, string> = {
  completed: 'What shipped this week',
  active: 'Active work',
  inbox: 'Inbox triage',
  done: 'Review complete',
};

/* ---------- Step: Completed ---------- */

const CompletedStep = memo(({ tickets }: { tickets: Ticket[] }) => {
  const store = useStore(persistedStoreApi.$atom);
  const projectMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of store.projects) m[p.id] = p.label;
    return m;
  }, [store.projects]);

  if (tickets.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <p className="text-fg-muted text-sm">No tickets completed this week.</p>
        <p className="text-fg-subtle text-xs">That is OK — quality over quantity.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-fg-muted mb-2">
        {tickets.length} ticket{tickets.length !== 1 ? 's' : ''} shipped. Nice work.
      </p>
      {tickets.map((ticket) => (
        <div key={ticket.id} className="flex items-center gap-3 px-3 py-2 rounded-lg">
          <PiCheckCircleFill size={16} className="text-green-400 shrink-0" />
          <div className="flex flex-col flex-1 min-w-0 gap-0.5">
            <span className="text-sm text-fg truncate">{ticket.title}</span>
            <span className="text-xs text-fg-subtle">{projectMap[ticket.projectId] ?? ''}</span>
          </div>
          {ticket.shaping?.appetite && (
            <span className={cn('text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0', APPETITE_COLORS[ticket.shaping.appetite])}>
              {APPETITE_LABELS[ticket.shaping.appetite]}
            </span>
          )}
        </div>
      ))}
    </div>
  );
});
CompletedStep.displayName = 'CompletedStep';

/* ---------- Step: Active Work ---------- */

const ActiveStep = memo(({ tickets }: { tickets: Ticket[] }) => {
  const store = useStore(persistedStoreApi.$atom);
  const projectMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of store.projects) m[p.id] = p.label;
    return m;
  }, [store.projects]);

  const handleStop = useCallback((ticketId: string) => {
    void ticketApi.stopSupervisor(ticketId);
  }, []);

  if (tickets.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <p className="text-fg-muted text-sm">No active tickets.</p>
        <p className="text-fg-subtle text-xs">Your plate is clear.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-fg-muted mb-2">
        Review your {tickets.length} active ticket{tickets.length !== 1 ? 's' : ''}. Stop anything
        that is stale or no longer relevant.
      </p>
      {tickets.map((ticket) => (
        <div key={ticket.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-surface-border bg-surface">
          <div className="flex flex-col flex-1 min-w-0 gap-0.5">
            <span className="text-sm text-fg truncate">{ticket.title}</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-fg-subtle">{projectMap[ticket.projectId] ?? ''}</span>
              {ticket.phase && PHASE_LABELS[ticket.phase] && (
                <span className={cn('text-xs px-1.5 py-0.5 rounded-full font-medium', PHASE_COLORS[ticket.phase] ?? 'text-fg-muted bg-fg-muted/10')}>
                  {PHASE_LABELS[ticket.phase]}
                </span>
              )}
            </div>
          </div>
          <Button size="sm" variant="destructive" onClick={() => handleStop(ticket.id)}>
            <PiStopFill size={12} className="mr-1" />
            Stop
          </Button>
        </div>
      ))}
    </div>
  );
});
ActiveStep.displayName = 'ActiveStep';

/* ---------- Step: Inbox ---------- */

const InboxStep = memo(({ items }: { items: InboxItem[] }) => {
  const now = Date.now();

  const handleNavigate = useCallback((itemId: string) => {
    persistedStoreApi.setKey('layoutMode', 'projects');
    ticketApi.goToInbox(itemId);
  }, []);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <p className="text-fg-muted text-sm">Inbox is empty.</p>
        <p className="text-fg-subtle text-xs">Nothing to triage.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-fg-muted mb-2">
        {items.length} item{items.length !== 1 ? 's' : ''} in your inbox. Shape and convert, or let them expire.
      </p>
      {items.map((item) => {
        const days = daysRemaining(item, now);
        const isUrgent = days <= 1;
        const isShaped = item.shaping != null;
        return (
          <button
            key={item.id}
            onClick={() => handleNavigate(item.id)}
            className="flex items-center gap-3 w-full px-3 py-2.5 text-left rounded-xl border border-surface-border bg-surface hover:bg-white/5 transition-colors"
          >
            <div className="flex flex-col flex-1 min-w-0 gap-0.5">
              <span className="text-sm text-fg truncate">{item.title}</span>
              <span className="text-xs text-fg-subtle">
                {isShaped ? 'Shaped — ready to convert' : 'Needs shaping'}
              </span>
            </div>
            <span className={cn('text-xs font-medium shrink-0', isUrgent ? 'text-amber-400' : 'text-fg-subtle')}>
              {days <= 0 ? 'Expiring today' : `${days}d left`}
            </span>
          </button>
        );
      })}
    </div>
  );
});
InboxStep.displayName = 'InboxStep';

/* ---------- Step: Done ---------- */

const DoneStep = memo(
  ({ completedCount, activeCount, inboxCount }: { completedCount: number; activeCount: number; inboxCount: number }) => (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <span className="text-4xl">~</span>
      <div className="flex flex-col gap-1">
        <p className="text-fg font-medium">Weekly review done.</p>
        <p className="text-sm text-fg-muted">
          {completedCount} shipped, {activeCount} in flight, {inboxCount} in inbox.
        </p>
      </div>
    </div>
  )
);
DoneStep.displayName = 'DoneStep';

/* ---------- Main Dialog ---------- */

type WeeklyReviewDialogProps = {
  open: boolean;
  onClose: () => void;
};

export const WeeklyReviewDialog = memo(({ open, onClose }: WeeklyReviewDialogProps) => {
  const store = useStore(persistedStoreApi.$atom);
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex]!;

  const weekAgo = useMemo(() => Date.now() - 7 * 24 * 60 * 60 * 1000, []);

  const completedTickets = useMemo(
    () => store.tickets.filter((t) => t.resolution === 'completed' && t.updatedAt >= weekAgo),
    [store.tickets, weekAgo]
  );

  const activeTickets = useMemo(
    () => store.tickets.filter((t) => t.phase != null && isActivePhase(t.phase)),
    [store.tickets]
  );

  const openInboxItems = useMemo(
    () =>
      store.inboxItems
        .filter((i) => i.status === 'open')
        .sort((a, b) => daysRemaining(a, Date.now()) - daysRemaining(b, Date.now())),
    [store.inboxItems]
  );

  const handleNext = useCallback(() => {
    if (stepIndex < STEPS.length - 1) {
      setStepIndex((i) => i + 1);
    }
  }, [stepIndex]);

  const handleBack = useCallback(() => {
    if (stepIndex > 0) {
      setStepIndex((i) => i - 1);
    }
  }, [stepIndex]);

  const handleFinish = useCallback(() => {
    persistedStoreApi.setKey('lastWeeklyReviewAt', Date.now());
    setStepIndex(0);
    onClose();
  }, [onClose]);

  const isLast = step === 'done';

  return (
    <AnimatedDialog open={open} onClose={onClose}>
      <DialogContent>
        <DialogHeader>Weekly Review</DialogHeader>
        <DialogBody>
          {/* Step indicator */}
          <div className="flex items-center gap-1 mb-4">
            {STEPS.map((s, i) => (
              <div
                key={s}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors',
                  i <= stepIndex ? 'bg-accent-500' : 'bg-surface-overlay'
                )}
              />
            ))}
          </div>
          <p className="text-sm font-medium text-fg mb-3">{STEP_TITLES[step]}</p>

          {step === 'completed' && <CompletedStep tickets={completedTickets} />}
          {step === 'active' && <ActiveStep tickets={activeTickets} />}
          {step === 'inbox' && <InboxStep items={openInboxItems} />}
          {step === 'done' && (
            <DoneStep
              completedCount={completedTickets.length}
              activeCount={activeTickets.length}
              inboxCount={openInboxItems.length}
            />
          )}
        </DialogBody>
        <DialogFooter className="justify-between">
          <div>
            {stepIndex > 0 && !isLast && (
              <Button size="sm" variant="ghost" onClick={handleBack}>
                Back
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {!isLast && (
              <Button size="sm" variant="ghost" onClick={onClose}>
                Skip
              </Button>
            )}
            {isLast ? (
              <Button size="sm" onClick={handleFinish}>
                Done
              </Button>
            ) : (
              <Button size="sm" onClick={handleNext}>
                Next
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </AnimatedDialog>
  );
});
WeeklyReviewDialog.displayName = 'WeeklyReviewDialog';
