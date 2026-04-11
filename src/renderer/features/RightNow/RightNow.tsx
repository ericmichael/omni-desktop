import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import { CalendarCheckmark20Regular, Flash20Filled, MailInbox20Regular, Warning20Regular } from '@fluentui/react-icons';

import { isReviewDue, dayName } from '@/lib/weekly-review';
import { Badge, Body1, Button, Caption1, Caption1Strong, Card, CounterBadge, ProgressBar, Subtitle2, Title3 } from '@/renderer/ds';
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

/* ---------- Styles ---------- */

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: tokens.colorNeutralBackground1 },
  scroll: { flex: '1 1 0', minHeight: 0, overflowY: 'auto' },
  container: {
    maxWidth: '672px',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '32px',
    paddingBottom: '32px',
    display: 'flex',
    flexDirection: 'column',
    gap: '32px',
  },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },

  /* WIP Gauge */
  wipRow: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  wipCount: { fontSize: '30px', fontWeight: tokens.fontWeightBold, color: tokens.colorNeutralForeground1, fontVariantNumeric: 'tabular-nums' },
  wipLimit: { fontSize: '18px', color: tokens.colorNeutralForeground3 },
  wipBar: { display: 'flex', gap: '6px', marginTop: '8px' },
  wipSlot: { height: '8px', flex: '1 1 0', borderRadius: '9999px', transitionProperty: 'background-color', transitionDuration: '150ms' },
  wipSlotEmpty: { backgroundColor: tokens.colorNeutralBackground3 },
  wipSlotFilled: { backgroundColor: tokens.colorBrandBackground },
  wipSlotFull: { backgroundColor: tokens.colorPaletteYellowForeground1 },

  /* Review banner */
  reviewBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2,
    cursor: 'pointer',
    border: 'none',
    textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorBrandBackground2Hover },
  },
  reviewIcon: { flexShrink: 0, color: tokens.colorBrandForeground1 },
  reviewText: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, gap: '2px' },

  /* Rows */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    width: '100%',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '10px',
    paddingBottom: '10px',
    textAlign: 'left',
    border: 'none',
    backgroundColor: 'transparent',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':active': { backgroundColor: tokens.colorSubtleBackgroundPressed },
  },
  rowContent: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, gap: '2px' },
  rowMeta: { display: 'flex', alignItems: 'center', gap: '8px' },
  dot: { width: '10px', height: '10px', borderRadius: '9999px', flexShrink: 0 },
  dotActive: { backgroundColor: tokens.colorPaletteGreenForeground1 },
  dotIdle: { backgroundColor: tokens.colorNeutralForeground3, opacity: 0.3 },
  urgent: { color: tokens.colorPaletteYellowForeground1 },

  /* Section */
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '8px',
    paddingBottom: '8px',
  },
  sectionIcon: { color: tokens.colorNeutralForeground3 },

  /* Empty state */
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
    paddingTop: '48px',
    paddingBottom: '48px',
    textAlign: 'center',
  },
  emptyTilde: { fontSize: '36px', opacity: 0.3 },
});

/* ---------- WIP Gauge ---------- */

const WipGauge = memo(({ used, limit }: { used: number; limit: number }) => {
  const styles = useStyles();
  const slots = Array.from({ length: limit }, (_, i) => i < used);

  return (
    <div>
      <div className={styles.wipRow}>
        <span className={styles.wipCount}>{used}</span>
        <span className={styles.wipLimit}>/ {limit}</span>
        <Caption1>WIP slots used</Caption1>
      </div>
      <div className={styles.wipBar}>
        {slots.map((filled, i) => (
          <div
            key={i}
            className={mergeClasses(
              styles.wipSlot,
              filled ? (used >= limit ? styles.wipSlotFull : styles.wipSlotFilled) : styles.wipSlotEmpty
            )}
          />
        ))}
      </div>
      {used >= limit && (
        <Caption1 style={{ color: tokens.colorPaletteYellowForeground1, marginTop: 8, display: 'block' }}>
          All slots full — finish or stop something before starting new work.
        </Caption1>
      )}
    </div>
  );
});
WipGauge.displayName = 'WipGauge';

/* ---------- Active Ticket Row ---------- */

const ActiveTicketRow = memo(({ ticket }: { ticket: Ticket }) => {
  const styles = useStyles();
  const phase = ticket.phase;
  const isRunning = phase != null && isActivePhase(phase);

  const handleClick = useCallback(() => {
    openTicketInCode(ticket.id);
  }, [ticket.id]);

  const store = useStore(persistedStoreApi.$atom);
  const projectLabel = useMemo(
    () => store.projects.find((p) => p.id === ticket.projectId)?.label ?? '',
    [store.projects, ticket.projectId]
  );

  return (
    <button onClick={handleClick} className={styles.row}>
      <div className={mergeClasses(styles.dot, isRunning ? styles.dotActive : styles.dotIdle)} />
      <div className={styles.rowContent}>
        <Body1>{ticket.title}</Body1>
        <div className={styles.rowMeta}>
          {projectLabel && <Caption1>{projectLabel}</Caption1>}
          {phase && PHASE_LABELS[phase] && (
            <Badge color={PHASE_COLORS[phase] ?? 'default'}>{PHASE_LABELS[phase]}</Badge>
          )}
        </div>
      </div>
      {ticket.shaping?.appetite && (
        <Badge color={APPETITE_COLORS[ticket.shaping.appetite]}>{APPETITE_LABELS[ticket.shaping.appetite]}</Badge>
      )}
    </button>
  );
});
ActiveTicketRow.displayName = 'ActiveTicketRow';

/* ---------- Inbox Item Row ---------- */

const InboxItemRow = memo(({ item }: { item: InboxItem }) => {
  const styles = useStyles();
  const now = Date.now();
  const days = daysRemaining(item, now);
  const isUrgent = days <= 1;
  const isShaped = item.shaping != null;

  const handleClick = useCallback(() => {
    persistedStoreApi.setKey('layoutMode', 'projects');
    ticketApi.goToInbox(item.id);
  }, [item.id]);

  return (
    <button onClick={handleClick} className={styles.row}>
      <div className={styles.rowContent}>
        <Body1>{item.title}</Body1>
        <Caption1>{isShaped ? 'Shaped — ready to convert' : 'Needs shaping'}</Caption1>
      </div>
      <Caption1Strong className={isUrgent ? styles.urgent : undefined}>
        {days <= 0 ? 'Expiring today' : `${days}d left`}
      </Caption1Strong>
    </button>
  );
});
InboxItemRow.displayName = 'InboxItemRow';

/* ---------- Section ---------- */

const Section = memo(
  ({ icon, title, count, children }: { icon: React.ReactNode; title: string; count?: number; children: React.ReactNode }) => {
    const styles = useStyles();
    return (
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionIcon}>{icon}</span>
          <Caption1Strong style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</Caption1Strong>
          {count != null && count > 0 && <Caption1>({count})</Caption1>}
        </div>
        {children}
      </div>
    );
  }
);
Section.displayName = 'Section';

/* ---------- Main Component ---------- */

export const RightNow = memo(() => {
  const styles = useStyles();
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

  const activeTickets = useMemo(() => {
    return store.tickets
      .filter((t) => t.phase != null && isActivePhase(t.phase))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [store.tickets]);

  const openInboxItems = useMemo(() => {
    const now = Date.now();
    return Object.values(inboxItemsMap)
      .filter((i) => i.status === 'open')
      .sort((a, b) => daysRemaining(a, now) - daysRemaining(b, now));
  }, [inboxItemsMap]);

  const needsAttention = useMemo(() => {
    return store.tickets.filter((t) => t.phase === 'awaiting_input' || t.phase === 'error');
  }, [store.tickets]);

  const hasAnything = activeTickets.length > 0 || openInboxItems.length > 0 || needsAttention.length > 0;

  return (
    <div className={styles.root}>
      <div className={styles.scroll}>
        <div className={styles.container}>
          <div className={styles.header}>
            <Title3>Right Now</Title3>
            <Caption1>What needs your attention.</Caption1>
          </div>

          <WipGauge used={activeTickets.length} limit={wipLimit} />

          {reviewDue && (
            <button onClick={openReview} className={styles.reviewBanner}>
              <CalendarCheckmark20Regular className={styles.reviewIcon} />
              <div className={styles.reviewText}>
                <Body1 weight="semibold">
                  It is {dayName(store.weeklyReviewDay ?? 5)} — time for your weekly review
                </Body1>
                <Caption1>Reflect on what shipped, triage your inbox, and clear the decks.</Caption1>
              </div>
              <Button size="sm" onClick={openReview}>Start</Button>
            </button>
          )}

          {!hasAnything && !reviewDue && (
            <div className={styles.empty}>
              <span className={styles.emptyTilde}>~</span>
              <Body1>Nothing needs your attention right now.</Body1>
              <Caption1>Inbox items and active tickets will appear here.</Caption1>
            </div>
          )}

          {needsAttention.length > 0 && (
            <Section icon={<Warning20Regular style={{ width: 16, height: 16 }} />} title="Needs Attention" count={needsAttention.length}>
              {needsAttention.map((ticket) => (
                <ActiveTicketRow key={ticket.id} ticket={ticket} />
              ))}
            </Section>
          )}

          {activeTickets.length > 0 && (
            <Section icon={<Flash20Filled style={{ width: 16, height: 16 }} />} title="Active Work" count={activeTickets.length}>
              {activeTickets
                .filter((t) => t.phase !== 'awaiting_input' && t.phase !== 'error')
                .map((ticket) => (
                  <ActiveTicketRow key={ticket.id} ticket={ticket} />
                ))}
            </Section>
          )}

          {openInboxItems.length > 0 && (
            <Section icon={<MailInbox20Regular style={{ width: 16, height: 16 }} />} title="Inbox" count={openInboxItems.length}>
              {openInboxItems.map((item) => (
                <InboxItemRow key={item.id} item={item} />
              ))}
            </Section>
          )}
        </div>
      </div>
      <WeeklyReviewDialog open={reviewOpen} onClose={closeReview} />
    </div>
  );
});
RightNow.displayName = 'RightNow';
