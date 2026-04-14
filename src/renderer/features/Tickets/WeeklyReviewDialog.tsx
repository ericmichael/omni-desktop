import { makeStyles, mergeClasses, shorthands,tokens } from '@fluentui/react-components';
import { CheckmarkCircle20Filled, Stop20Filled } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import { daysRemaining as inboxDaysRemaining } from '@/lib/inbox-expiry';
import { AnimatedDialog, Badge, Button, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/renderer/ds';
import { $activeInbox } from '@/renderer/features/Inbox/state';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { APPETITE_COLORS, APPETITE_LABELS, PHASE_COLORS, PHASE_LABELS } from '@/renderer/features/Tickets/ticket-constants';
import { persistedStoreApi } from '@/renderer/services/store';
import { isActivePhase } from '@/shared/ticket-phase';
import type { InboxItem, Ticket } from '@/shared/types';

const useStyles = makeStyles({
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS, paddingTop: '32px', paddingBottom: '32px', textAlign: 'center' },
  emptyText: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase300 },
  emptySub: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  list: { display: 'flex', flexDirection: 'column', gap: '4px' },
  listHint: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground2, marginBottom: tokens.spacingVerticalS },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusLarge,
  },
  rowBordered: {
    borderRadius: tokens.borderRadiusXLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    paddingTop: '10px',
    paddingBottom: '10px',
  },
  rowInteractive: {
    width: '100%',
    textAlign: 'left',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  rowContent: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, gap: '2px' },
  rowTitle: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowSub: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  rowMeta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  checkIcon: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  stopIcon: { marginRight: '4px' },
  doneState: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalL, paddingTop: '32px', paddingBottom: '32px', textAlign: 'center' },
  doneTilde: { fontSize: '36px' },
  doneContent: { display: 'flex', flexDirection: 'column', gap: '4px' },
  doneTitle: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightMedium },
  doneSub: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground2 },
  stepIndicator: { display: 'flex', alignItems: 'center', gap: '4px', marginBottom: tokens.spacingVerticalL },
  stepBar: { height: '4px', flex: '1 1 0', borderRadius: '9999px', transitionProperty: 'background-color', transitionDuration: '150ms' },
  stepBarActive: { backgroundColor: tokens.colorBrandStroke1 },
  stepBarInactive: { backgroundColor: tokens.colorNeutralBackground3 },
  stepTitle: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightMedium, color: tokens.colorNeutralForeground1, marginBottom: tokens.spacingVerticalM },
  footerBetween: { justifyContent: 'space-between' },
  urgentText: { color: tokens.colorPaletteYellowForeground1 },
  subtleText: { color: tokens.colorNeutralForeground3 },
  expiryLabel: { fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightMedium, flexShrink: 0 },
});

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
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const projectMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of store.projects) {
m[p.id] = p.label;
}
    return m;
  }, [store.projects]);

  if (tickets.length === 0) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.emptyText}>No tickets completed this week.</p>
        <p className={styles.emptySub}>That is OK — quality over quantity.</p>
      </div>
    );
  }

  return (
    <div className={styles.list}>
      <p className={styles.listHint}>
        {tickets.length} ticket{tickets.length !== 1 ? 's' : ''} shipped. Nice work.
      </p>
      {tickets.map((ticket) => (
        <div key={ticket.id} className={styles.row}>
          <CheckmarkCircle20Filled style={{ width: 16, height: 16 }} className={styles.checkIcon} />
          <div className={styles.rowContent}>
            <span className={styles.rowTitle}>{ticket.title}</span>
            <span className={styles.rowSub}>{projectMap[ticket.projectId] ?? ''}</span>
          </div>
          {ticket.shaping?.appetite && (
            <Badge color={APPETITE_COLORS[ticket.shaping.appetite]}>{APPETITE_LABELS[ticket.shaping.appetite]}</Badge>
          )}
        </div>
      ))}
    </div>
  );
});
CompletedStep.displayName = 'CompletedStep';

/* ---------- Step: Active Work ---------- */

const ActiveStep = memo(({ tickets }: { tickets: Ticket[] }) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const projectMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of store.projects) {
m[p.id] = p.label;
}
    return m;
  }, [store.projects]);

  const handleStop = useCallback((ticketId: string) => {
    void ticketApi.stopSupervisor(ticketId);
  }, []);

  if (tickets.length === 0) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.emptyText}>No active tickets.</p>
        <p className={styles.emptySub}>Your plate is clear.</p>
      </div>
    );
  }

  return (
    <div className={styles.list}>
      <p className={styles.listHint}>
        Review your {tickets.length} active ticket{tickets.length !== 1 ? 's' : ''}. Stop anything
        that is stale or no longer relevant.
      </p>
      {tickets.map((ticket) => (
        <div key={ticket.id} className={mergeClasses(styles.row, styles.rowBordered)}>
          <div className={styles.rowContent}>
            <span className={styles.rowTitle}>{ticket.title}</span>
            <div className={styles.rowMeta}>
              <span className={styles.rowSub}>{projectMap[ticket.projectId] ?? ''}</span>
              {ticket.phase && PHASE_LABELS[ticket.phase] && (
                <Badge color={PHASE_COLORS[ticket.phase] ?? 'default'}>{PHASE_LABELS[ticket.phase]}</Badge>
              )}
            </div>
          </div>
          <Button size="sm" variant="destructive" onClick={() => handleStop(ticket.id)}>
            <Stop20Filled style={{ width: 12, height: 12 }} className={styles.stopIcon} />
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
  const styles = useStyles();
  const now = Date.now();

  const handleNavigate = useCallback(() => {
    persistedStoreApi.setKey('layoutMode', 'projects');
  }, []);

  if (items.length === 0) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.emptyText}>Inbox is empty.</p>
        <p className={styles.emptySub}>Nothing to triage.</p>
      </div>
    );
  }

  return (
    <div className={styles.list}>
      <p className={styles.listHint}>
        {items.length} item{items.length !== 1 ? 's' : ''} in your inbox. Shape and commit, or let them expire.
      </p>
      {items.map((item) => {
        const days = inboxDaysRemaining(item.createdAt, now);
        const isUrgent = days <= 1;
        const isShaped = item.status === 'shaped';
        return (
          <button
            key={item.id}
            onClick={handleNavigate}
            className={mergeClasses(styles.row, styles.rowBordered, styles.rowInteractive)}
          >
            <div className={styles.rowContent}>
              <span className={styles.rowTitle}>{item.title || 'Untitled'}</span>
              <span className={styles.rowSub}>
                {isShaped ? 'Shaped — ready to commit' : 'Needs shaping'}
              </span>
            </div>
            <span className={mergeClasses(styles.expiryLabel, isUrgent ? styles.urgentText : styles.subtleText)}>
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
  ({ completedCount, activeCount, inboxCount }: { completedCount: number; activeCount: number; inboxCount: number }) => {
    const styles = useStyles();
    return (
    <div className={styles.doneState}>
      <span className={styles.doneTilde}>~</span>
      <div className={styles.doneContent}>
        <p className={styles.doneTitle}>Weekly review done.</p>
        <p className={styles.doneSub}>
          {completedCount} shipped, {activeCount} in flight, {inboxCount} in inbox.
        </p>
      </div>
    </div>
    );
  }
);
DoneStep.displayName = 'DoneStep';

/* ---------- Main Dialog ---------- */

type WeeklyReviewDialogProps = {
  open: boolean;
  onClose: () => void;
};

export const WeeklyReviewDialog = memo(({ open, onClose }: WeeklyReviewDialogProps) => {
  const styles = useStyles();
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

  const activeInbox = useStore($activeInbox);
  const openInboxItems = useMemo(
    () => {
      const now = Date.now();
      return [...activeInbox].sort(
        (a, b) => inboxDaysRemaining(a.createdAt, now) - inboxDaysRemaining(b.createdAt, now)
      );
    },
    [activeInbox]
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
          <div className={styles.stepIndicator}>
            {STEPS.map((s, i) => (
              <div
                key={s}
                className={mergeClasses(styles.stepBar, i <= stepIndex ? styles.stepBarActive : styles.stepBarInactive)}
              />
            ))}
          </div>
          <p className={styles.stepTitle}>{STEP_TITLES[step]}</p>

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
        <DialogFooter className={styles.footerBetween}>
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
