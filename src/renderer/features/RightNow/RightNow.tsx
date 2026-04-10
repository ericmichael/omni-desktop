import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiCalendarCheckBold, PiLightningFill, PiTrayBold, PiWarningCircleBold } from 'react-icons/pi';

import { isReviewDue, dayName } from '@/lib/weekly-review';
import { Button, cn } from '@/renderer/ds';
import { $inboxItems } from '@/renderer/features/Inbox/state';
import { APPETITE_COLORS, APPETITE_LABELS } from '@/renderer/features/Inbox/shaping-constants';
import { openTicketInCode } from '@/renderer/services/navigation';
import { persistedStoreApi } from '@/renderer/services/store';
import { daysRemaining } from '@/lib/inbox-expiry';
import { isActivePhase } from '@/shared/ticket-phase';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { PHASE_COLORS, PHASE_LABELS } from '@/renderer/features/Tickets/ticket-constants';
import type { InboxItem, Ticket } from '@/shared/types';

import { WeeklyReviewDialog } from './WeeklyReviewDialog';

/* ---------- WIP Gauge ---------- */

const WipGauge = memo(({ used, limit }: { used: number; limit: number }) => {
  const slots = Array.from({ length: limit }, (_, i) => i < used);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold text-fg tabular-nums">{used}</span>
        <span className="text-lg text-fg-muted">/ {limit}</span>
        <span className="text-sm text-fg-subtle ml-1">WIP slots used</span>
      </div>
      <div className="flex gap-1.5">
        {slots.map((filled, i) => (
          <div
            key={i}
            className={cn(
              'h-2 flex-1 rounded-full transition-colors',
              filled
                ? used >= limit
                  ? 'bg-amber-400'
                  : 'bg-accent-500'
                : 'bg-surface-overlay'
            )}
          />
        ))}
      </div>
      {used >= limit && (
        <p className="text-xs text-amber-400">All slots full — finish or stop something before starting new work.</p>
      )}
    </div>
  );
});
WipGauge.displayName = 'WipGauge';

/* ---------- Active Ticket Row ---------- */

const ActiveTicketRow = memo(({ ticket }: { ticket: Ticket }) => {
  const phase = ticket.phase;
  const isRunning = phase != null && isActivePhase(phase);

  const handleClick = useCallback(() => {
    openTicketInCode(ticket.id);
  }, [ticket.id]);

  // Find project label
  const store = useStore(persistedStoreApi.$atom);
  const projectLabel = useMemo(
    () => store.projects.find((p) => p.id === ticket.projectId)?.label ?? '',
    [store.projects, ticket.projectId]
  );

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-3 w-full px-4 py-3 text-left transition-colors rounded-xl hover:bg-white/5 active:bg-white/10"
    >
      <div className="flex items-center gap-2 shrink-0">
        {isRunning ? (
          <span className="size-2.5 rounded-full bg-green-400 animate-pulse" />
        ) : (
          <span className="size-2.5 rounded-full bg-fg-subtle/30" />
        )}
      </div>
      <div className="flex flex-col flex-1 min-w-0 gap-0.5">
        <span className="text-sm font-medium text-fg truncate">{ticket.title}</span>
        <div className="flex items-center gap-2">
          {projectLabel && <span className="text-xs text-fg-subtle truncate">{projectLabel}</span>}
          {phase && PHASE_LABELS[phase] && (
            <span
              className={cn(
                'text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0',
                PHASE_COLORS[phase] ?? 'text-fg-muted bg-fg-muted/10'
              )}
            >
              {PHASE_LABELS[phase]}
            </span>
          )}
        </div>
      </div>
      {ticket.shaping?.appetite && (
        <span
          className={cn(
            'text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0',
            APPETITE_COLORS[ticket.shaping.appetite]
          )}
        >
          {APPETITE_LABELS[ticket.shaping.appetite]}
        </span>
      )}
    </button>
  );
});
ActiveTicketRow.displayName = 'ActiveTicketRow';

/* ---------- Inbox Item Row ---------- */

const InboxItemRow = memo(({ item }: { item: InboxItem }) => {
  const now = Date.now();
  const days = daysRemaining(item, now);
  const isUrgent = days <= 1;
  const isShaped = item.shaping != null;

  const handleClick = useCallback(() => {
    persistedStoreApi.setKey('layoutMode', 'projects');
    ticketApi.goToInbox(item.id);
  }, [item.id]);

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-3 w-full px-4 py-3 text-left transition-colors rounded-xl hover:bg-white/5 active:bg-white/10"
    >
      <div className="flex flex-col flex-1 min-w-0 gap-0.5">
        <span className="text-sm font-medium text-fg truncate">{item.title}</span>
        <div className="flex items-center gap-2">
          {isShaped ? (
            <span className="text-xs text-fg-subtle">Shaped — ready to convert</span>
          ) : (
            <span className="text-xs text-fg-subtle">Needs shaping</span>
          )}
        </div>
      </div>
      <span
        className={cn(
          'text-xs font-medium shrink-0',
          isUrgent ? 'text-amber-400' : 'text-fg-subtle'
        )}
      >
        {days <= 0 ? 'Expiring today' : `${days}d left`}
      </span>
    </button>
  );
});
InboxItemRow.displayName = 'InboxItemRow';

/* ---------- Section ---------- */

const Section = memo(
  ({
    icon,
    title,
    count,
    children,
  }: {
    icon: React.ReactNode;
    title: string;
    count?: number;
    children: React.ReactNode;
  }) => (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="text-fg-muted">{icon}</span>
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wider">{title}</span>
        {count != null && count > 0 && (
          <span className="text-xs text-fg-subtle">({count})</span>
        )}
      </div>
      {children}
    </div>
  )
);
Section.displayName = 'Section';

/* ---------- Main Component ---------- */

export const RightNow = memo(() => {
  const store = useStore(persistedStoreApi.$atom);
  const inboxItemsMap = useStore($inboxItems);
  const wipLimit = store.wipLimit ?? 3;
  const [reviewOpen, setReviewOpen] = useState(false);

  const reviewDue = useMemo(
    () => isReviewDue(store.weeklyReviewDay ?? 5, store.lastWeeklyReviewAt ?? null),
    [store.weeklyReviewDay, store.lastWeeklyReviewAt]
  );

  const openReview = useCallback(() => setReviewOpen(true), []);
  const closeReview = useCallback(() => setReviewOpen(false), []);

  // Active WIP tickets: tickets with an active phase, across all projects
  const activeTickets = useMemo(() => {
    return store.tickets
      .filter((t) => t.phase != null && isActivePhase(t.phase))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [store.tickets]);

  // Open inbox items, sorted by urgency (expiring soonest first)
  const openInboxItems = useMemo(() => {
    const now = Date.now();
    return Object.values(inboxItemsMap)
      .filter((i) => i.status === 'open')
      .sort((a, b) => daysRemaining(a, now) - daysRemaining(b, now));
  }, [inboxItemsMap]);

  // Tickets needing attention: awaiting input or errored
  const needsAttention = useMemo(() => {
    return store.tickets.filter(
      (t) => t.phase === 'awaiting_input' || t.phase === 'error'
    );
  }, [store.tickets]);

  const hasAnything = activeTickets.length > 0 || openInboxItems.length > 0 || needsAttention.length > 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-8 flex flex-col gap-8">
          {/* Header */}
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold text-fg tracking-tight">Right Now</h1>
            <p className="text-sm text-fg-muted">What needs your attention.</p>
          </div>

          {/* WIP Gauge */}
          <WipGauge used={activeTickets.length} limit={wipLimit} />

          {/* Weekly Review Banner */}
          {reviewDue && (
            <button
              onClick={openReview}
              className="flex items-center gap-3 px-4 py-3 rounded-xl border border-accent-600/30 bg-accent-600/10 hover:bg-accent-600/15 transition-colors text-left"
            >
              <PiCalendarCheckBold size={20} className="text-accent-400 shrink-0" />
              <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                <span className="text-sm font-medium text-fg">
                  It is {dayName(store.weeklyReviewDay ?? 5)} — time for your weekly review
                </span>
                <span className="text-xs text-fg-muted">
                  Reflect on what shipped, triage your inbox, and clear the decks.
                </span>
              </div>
              <Button size="sm" onClick={openReview}>
                Start
              </Button>
            </button>
          )}

          {!hasAnything && !reviewDue && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="text-4xl opacity-30">~</span>
              <p className="text-fg-muted text-sm">Nothing needs your attention right now.</p>
              <p className="text-fg-subtle text-xs">Inbox items and active tickets will appear here.</p>
            </div>
          )}

          {/* Needs Attention (awaiting input / errors) */}
          {needsAttention.length > 0 && (
            <Section
              icon={<PiWarningCircleBold size={16} />}
              title="Needs Attention"
              count={needsAttention.length}
            >
              <div className="flex flex-col">
                {needsAttention.map((ticket) => (
                  <ActiveTicketRow key={ticket.id} ticket={ticket} />
                ))}
              </div>
            </Section>
          )}

          {/* Active Work */}
          {activeTickets.length > 0 && (
            <Section
              icon={<PiLightningFill size={16} />}
              title="Active Work"
              count={activeTickets.length}
            >
              <div className="flex flex-col">
                {activeTickets
                  .filter((t) => t.phase !== 'awaiting_input' && t.phase !== 'error')
                  .map((ticket) => (
                    <ActiveTicketRow key={ticket.id} ticket={ticket} />
                  ))}
              </div>
            </Section>
          )}

          {/* Inbox */}
          {openInboxItems.length > 0 && (
            <Section
              icon={<PiTrayBold size={16} />}
              title="Inbox"
              count={openInboxItems.length}
            >
              <div className="flex flex-col">
                {openInboxItems.map((item) => (
                  <InboxItemRow key={item.id} item={item} />
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
      <WeeklyReviewDialog open={reviewOpen} onClose={closeReview} />
    </div>
  );
});
RightNow.displayName = 'RightNow';
