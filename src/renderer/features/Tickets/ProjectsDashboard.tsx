import { makeStyles, mergeClasses, tokens, shorthands } from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';
import {
  CalendarCheckmark20Regular,
  Flash20Filled,
  Warning20Regular,
  CheckmarkCircle20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
} from '@fluentui/react-icons';

import { focusHeader, rankFocus, type FocusItem } from '@/lib/focus-ranker';
import { detectRisks, type RiskSeverity, type RiskSignal } from '@/lib/risk-signals';
import { computeShippedDigest, localBoundaries, type ShippedItem } from '@/lib/shipped-digest';
import { dayName, isReviewDue } from '@/lib/weekly-review';
import { Badge, Body1, Button, Caption1, Caption1Strong, Subtitle2, Title3 } from '@/renderer/ds';
import { $activeInbox } from '@/renderer/features/Inbox/state';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { openTicketInCode } from '@/renderer/services/navigation';
import { persistedStoreApi } from '@/renderer/services/store';
import { DEFAULT_PIPELINE } from '@/shared/pipeline-defaults';
import { isActivePhase } from '@/shared/ticket-phase';
import type { ColumnId } from '@/shared/types';

import { PHASE_COLORS, PHASE_LABELS } from './ticket-constants';
import { $wipDialogPendingTicket, ticketApi } from './state';
import { WeeklyReviewDialog } from './WeeklyReviewDialog';

/* ---------- Styles ---------- */

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  scroll: { flex: '1 1 0', minHeight: 0, overflowY: 'auto' },
  container: {
    maxWidth: '720px',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '32px',
    paddingBottom: '48px',
    display: 'flex',
    flexDirection: 'column',
    gap: '28px',
  },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },

  /* WIP gauge */
  wipRow: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  wipCount: {
    fontSize: '30px',
    fontWeight: tokens.fontWeightBold,
    color: tokens.colorNeutralForeground1,
    fontVariantNumeric: 'tabular-nums',
  },
  wipLimit: { fontSize: '18px', color: tokens.colorNeutralForeground3 },
  wipBar: { display: 'flex', gap: '6px', marginTop: '8px' },
  wipSlot: {
    height: '8px',
    flex: '1 1 0',
    borderRadius: '9999px',
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
  },
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
    border: 'none',
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorBrandBackground2Hover },
  },
  reviewText: { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, gap: '2px' },
  reviewIcon: { flexShrink: 0, color: tokens.colorBrandForeground1 },

  /* Section */
  section: { display: 'flex', flexDirection: 'column', gap: '6px' },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '4px',
    paddingBottom: '4px',
  },
  sectionIcon: { color: tokens.colorNeutralForeground3 },
  sectionTitle: {
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: tokens.colorNeutralForeground2,
  },
  sectionLead: {
    paddingLeft: '16px',
    paddingRight: '16px',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
  },
  sectionEmpty: {
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '12px',
    paddingBottom: '12px',
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    fontSize: tokens.fontSizeBase200,
  },

  /* Row */
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
  rowTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  projectTag: {
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightSemibold,
    ':after': {
      content: '"·"',
      marginLeft: '8px',
      color: tokens.colorNeutralForeground4,
      fontWeight: tokens.fontWeightRegular,
    },
  },
  rowRank: {
    flexShrink: 0,
    width: '20px',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  dot: { width: '10px', height: '10px', borderRadius: '9999px', flexShrink: 0 },
  dotActive: { backgroundColor: tokens.colorPaletteGreenForeground1 },
  dotIdle: { backgroundColor: tokens.colorNeutralForeground3, opacity: 0.3 },

  /* Risk severity dots */
  sevHigh: { backgroundColor: tokens.colorPaletteRedForeground1 },
  sevMedium: { backgroundColor: tokens.colorPaletteYellowForeground1 },
  sevLow: { backgroundColor: tokens.colorNeutralForeground3 },

  /* Shipped */
  shippedCounts: {
    display: 'flex',
    gap: '16px',
    paddingLeft: '16px',
    paddingRight: '16px',
    color: tokens.colorNeutralForeground2,
  },
  shippedToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '8px',
    paddingBottom: '8px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    ':hover': { color: tokens.colorNeutralForeground1 },
  },

  /* Empty */
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '16px',
    paddingTop: '64px',
    paddingBottom: '64px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
  },
  emptyTilde: { fontSize: '36px', opacity: 0.3 },
  emptyActions: { display: 'flex', gap: '8px' },
});

/* ---------- WIP gauge ---------- */

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
    </div>
  );
});
WipGauge.displayName = 'WipGauge';

/* ---------- Section shell ---------- */

const Section = memo(
  ({
    icon,
    title,
    count,
    lead,
    children,
  }: {
    icon: React.ReactNode;
    title: string;
    count?: number;
    lead?: string;
    children: React.ReactNode;
  }) => {
    const styles = useStyles();
    return (
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionIcon}>{icon}</span>
          <Caption1Strong className={styles.sectionTitle}>{title}</Caption1Strong>
          {count != null && count > 0 && <Caption1>({count})</Caption1>}
        </div>
        {lead && <Caption1 className={styles.sectionLead}>{lead}</Caption1>}
        {children}
      </div>
    );
  }
);
Section.displayName = 'Section';

/* ---------- Focus row ---------- */

const FocusRow = memo(
  ({ item, index, projectLabel }: { item: FocusItem; index: number; projectLabel?: string }) => {
    const styles = useStyles();
    const ticket = item.ticket;
    const phase = ticket.phase;
    const running = phase != null && isActivePhase(phase);

    const handleClick = useCallback(() => {
      if (running) {
        void openTicketInCode(ticket.id);
      } else {
        ticketApi.goToTicket(ticket.id);
      }
    }, [running, ticket.id]);

    return (
      <button type="button" className={styles.row} onClick={handleClick}>
        <span className={styles.rowRank}>{index + 1}</span>
        <div className={mergeClasses(styles.dot, running ? styles.dotActive : styles.dotIdle)} />
        <div className={styles.rowContent}>
          <Body1 className={styles.rowTitle}>{ticket.title}</Body1>
          <div className={styles.rowMeta}>
            {projectLabel && <span className={styles.projectTag}>{projectLabel}</span>}
            <span>{item.reason}</span>
            {phase && PHASE_LABELS[phase] && phase !== 'idle' && (
              <Badge color={PHASE_COLORS[phase] ?? 'default'}>{PHASE_LABELS[phase]}</Badge>
            )}
          </div>
        </div>
      </button>
    );
  }
);
FocusRow.displayName = 'FocusRow';

/* ---------- Risk row ---------- */

const severityClass = (sev: RiskSeverity, styles: ReturnType<typeof useStyles>) => {
  if (sev === 'high') return styles.sevHigh;
  if (sev === 'medium') return styles.sevMedium;
  return styles.sevLow;
};

const RiskRow = memo(
  ({ signal, projectLabel }: { signal: RiskSignal; projectLabel?: string }) => {
  const styles = useStyles();

  const handleClick = useCallback(() => {
    const action = signal.action;
    switch (action.kind) {
      case 'open_ticket':
        ticketApi.goToTicket(action.ticketId);
        break;
      case 'open_milestone':
        ticketApi.goToMilestone(action.milestoneId, action.projectId);
        break;
      case 'open_inbox_item':
        ticketApi.goToInbox(action.inboxItemId);
        break;
      case 'open_project':
        ticketApi.goToProject(action.projectId);
        break;
      case 'open_wip_dialog': {
        // Surface the WIP dialog by nudging the pending-ticket atom.
        const firstActive = persistedStoreApi.$atom
          .get()
          .tickets.find((t) => t.phase != null && isActivePhase(t.phase));
        if (firstActive) {
          $wipDialogPendingTicket.set(firstActive);
        }
        break;
      }
    }
  }, [signal]);

  return (
    <button type="button" className={styles.row} onClick={handleClick}>
      <div className={mergeClasses(styles.dot, severityClass(signal.severity, styles))} />
      <div className={styles.rowContent}>
        <Body1 className={styles.rowTitle}>{signal.title}</Body1>
        <div className={styles.rowMeta}>
          {projectLabel && <span className={styles.projectTag}>{projectLabel}</span>}
          {signal.detail && <span>{signal.detail}</span>}
        </div>
      </div>
    </button>
  );
  }
);
RiskRow.displayName = 'RiskRow';

/* ---------- Shipped row ---------- */

const ShippedRow = memo(
  ({ item, projectLabel }: { item: ShippedItem; projectLabel?: string }) => {
    const styles = useStyles();

    const handleClick = useCallback(() => {
      if (item.kind === 'ticket') {
        ticketApi.goToTicket(item.ticket.id);
      } else {
        ticketApi.goToMilestone(item.milestone.id, item.milestone.projectId);
      }
    }, [item]);

    const title = item.kind === 'ticket' ? item.ticket.title : item.milestone.title;
    const subtitle = item.kind === 'ticket' ? 'Ticket shipped' : 'Milestone completed';

    return (
      <button type="button" className={styles.row} onClick={handleClick}>
        <div className={styles.rowContent}>
          <Body1 className={styles.rowTitle}>{title}</Body1>
          <div className={styles.rowMeta}>
            {projectLabel && <span className={styles.projectTag}>{projectLabel}</span>}
            <span>{subtitle}</span>
          </div>
        </div>
      </button>
    );
  }
);
ShippedRow.displayName = 'ShippedRow';

/* ---------- Focus section ---------- */

function focusLead(
  header: ReturnType<typeof focusHeader>
): string {
  switch (header.kind) {
    case 'in_flight':
      return `${header.activeCount} in flight — finish these first`;
    case 'start':
      return `${header.openSlots} ${header.openSlots === 1 ? 'slot' : 'slots'} open — start with these`;
    case 'shape_inbox':
      return `Nothing ready. ${header.shapedCount} inbox ${
        header.shapedCount === 1 ? 'item is' : 'items are'
      } shaped — commit one to a project.`;
    case 'empty':
      return 'No work queued.';
  }
}

/* ---------- Main dashboard ---------- */

export const ProjectsDashboard = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const milestones = useStore($milestones);
  const activeInbox = useStore($activeInbox);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [shippedExpanded, setShippedExpanded] = useState(false);

  const wipLimit = store.wipLimit ?? 3;

  const projectLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of store.projects) map[p.id] = p.label;
    return map;
  }, [store.projects]);

  // Read tickets from the persisted store — the canonical global list that
  // stays in sync via `store:changed`. The $tickets atom is project-scoped
  // scratch space that fetchTickets(projectId) wholesale replaces, so reading
  // from it would make the dashboard flicker to a single project as soon as
  // the user expands a node in the sidebar.
  const tickets = store.tickets;

  // Collect terminal (last) column IDs across every project. The rest of the
  // system treats "in the last kanban column" as done — the ranker and risk
  // detector must match that, otherwise cards dragged to Done still rank.
  const terminalColumnIds = useMemo<ReadonlySet<ColumnId>>(() => {
    const set = new Set<ColumnId>();
    for (const project of store.projects) {
      const columns = project.pipeline?.columns ?? DEFAULT_PIPELINE.columns;
      const last = columns[columns.length - 1];
      if (last) set.add(last.id);
    }
    return set;
  }, [store.projects]);

  const wipUsed = useMemo(
    () =>
      tickets.filter(
        (t) =>
          t.resolution === undefined &&
          !terminalColumnIds.has(t.columnId) &&
          t.phase != null &&
          isActivePhase(t.phase)
      ).length,
    [tickets, terminalColumnIds]
  );

  const reviewDue = useMemo(
    () => isReviewDue(store.weeklyReviewDay ?? 5, store.lastWeeklyReviewAt ?? null),
    [store.weeklyReviewDay, store.lastWeeklyReviewAt]
  );

  const now = Date.now();

  const ranked = useMemo(
    () => rankFocus({ tickets, milestones, terminalColumnIds, now, limit: 5 }),
    [tickets, milestones, terminalColumnIds, now]
  );

  const shapedInboxCount = useMemo(
    () => activeInbox.filter((i) => i.status === 'shaped').length,
    [activeInbox]
  );

  const header = useMemo(
    () => focusHeader({ ranked, wipUsed, wipLimit, shapedInboxCount }),
    [ranked, wipUsed, wipLimit, shapedInboxCount]
  );

  const risks = useMemo(
    () =>
      detectRisks({
        tickets,
        milestones: Object.values(milestones),
        inboxItems: activeInbox,
        projects: store.projects,
        terminalColumnIds,
        wipLimit,
        now,
      }),
    [tickets, milestones, activeInbox, store.projects, terminalColumnIds, wipLimit, now]
  );

  const shipped = useMemo(() => {
    const { startOfToday, startOfWeek } = localBoundaries(new Date(now));
    return computeShippedDigest({
      tickets,
      milestones: Object.values(milestones),
      startOfToday,
      startOfWeek,
    });
  }, [tickets, milestones, now]);

  const hasAnyContent =
    tickets.length > 0 || activeInbox.length > 0 || store.projects.length > 0;

  // Completely empty state — new user, nothing captured yet.
  if (!hasAnyContent) {
    return (
      <div className={styles.root}>
        <div className={styles.scroll}>
          <div className={styles.container}>
            <div className={styles.empty}>
              <span className={styles.emptyTilde}>~</span>
              <Body1>Nothing here yet.</Body1>
              <Caption1>Capture a thought or create your first project to get started.</Caption1>
              <div className={styles.emptyActions}>
                <Button size="sm" onClick={() => ticketApi.goToInbox()}>
                  Open inbox
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.scroll}>
        <div className={styles.container}>
          {/* Header */}
          <div className={styles.header}>
            <Title3>Home</Title3>
            <Caption1>What needs your attention.</Caption1>
          </div>

          {/* WIP gauge */}
          <WipGauge used={wipUsed} limit={wipLimit} />

          {/* Review banner */}
          {reviewDue && (
            <button type="button" onClick={() => setReviewOpen(true)} className={styles.reviewBanner}>
              <CalendarCheckmark20Regular className={styles.reviewIcon} />
              <div className={styles.reviewText}>
                <Subtitle2>
                  It is {dayName(store.weeklyReviewDay ?? 5)} — time for your weekly review
                </Subtitle2>
                <Caption1>Reflect on what shipped, triage your inbox, and clear the decks.</Caption1>
              </div>
              <Button size="sm" onClick={() => setReviewOpen(true)}>
                Start
              </Button>
            </button>
          )}

          {/* Focus */}
          <Section
            icon={<Flash20Filled style={{ width: 16, height: 16 }} />}
            title="Focus"
            lead={focusLead(header)}
          >
            {ranked.length === 0 ? null : (
              <>
                {ranked.map((item, i) => (
                  <FocusRow
                    key={item.ticket.id}
                    item={item}
                    index={i}
                    projectLabel={projectLabels[item.ticket.projectId]}
                  />
                ))}
              </>
            )}
          </Section>

          {/* At risk */}
          <Section
            icon={<Warning20Regular style={{ width: 16, height: 16 }} />}
            title="At risk"
            count={risks.length}
          >
            {risks.length === 0 ? (
              <div className={styles.sectionEmpty}>Nothing is drifting. Keep shipping.</div>
            ) : (
              risks.map((r) => (
                <RiskRow
                  key={r.id}
                  signal={r}
                  projectLabel={riskProjectLabel(r, tickets, projectLabels)}
                />
              ))
            )}
          </Section>

          {/* Shipped */}
          <Section
            icon={<CheckmarkCircle20Regular style={{ width: 16, height: 16 }} />}
            title="Shipped"
          >
            <div className={styles.shippedCounts}>
              <span>
                <Caption1Strong>{shipped.today.ticketCount + shipped.today.milestoneCount}</Caption1Strong>{' '}
                <Caption1>today</Caption1>
              </span>
              <span>
                <Caption1Strong>{shipped.week.ticketCount + shipped.week.milestoneCount}</Caption1Strong>{' '}
                <Caption1>this week</Caption1>
              </span>
            </div>
            {shipped.week.items.length === 0 ? (
              <div className={styles.sectionEmpty}>Nothing shipped yet this week.</div>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.shippedToggle}
                  onClick={() => setShippedExpanded((v) => !v)}
                >
                  {shippedExpanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                  <span>{shippedExpanded ? 'Hide details' : 'Show details'}</span>
                </button>
                {shippedExpanded && shipped.week.items.map((item) => {
                  const key = item.kind === 'ticket' ? `t:${item.ticket.id}` : `m:${item.milestone.id}`;
                  const projectId =
                    item.kind === 'ticket' ? item.ticket.projectId : item.milestone.projectId;
                  return (
                    <ShippedRow key={key} item={item} projectLabel={projectLabels[projectId]} />
                  );
                })}
              </>
            )}
          </Section>
        </div>
      </div>
      <WeeklyReviewDialog open={reviewOpen} onClose={() => setReviewOpen(false)} />
    </div>
  );
});
ProjectsDashboard.displayName = 'ProjectsDashboard';

/**
 * Resolve the project label for a risk signal. Signals keyed directly on a
 * project (quiet_project, milestone_*) carry the id; ticket-scoped signals
 * need a lookup through the ticket list. Inbox and WIP signals aren't
 * project-scoped and return undefined.
 */
function riskProjectLabel(
  signal: RiskSignal,
  tickets: readonly import('@/shared/types').Ticket[],
  labels: Record<string, string>
): string | undefined {
  const action = signal.action;
  switch (action.kind) {
    case 'open_ticket': {
      const ticket = tickets.find((t) => t.id === action.ticketId);
      return ticket ? labels[ticket.projectId] : undefined;
    }
    case 'open_milestone':
      return labels[action.projectId];
    case 'open_project':
      return labels[action.projectId];
    default:
      return undefined;
  }
}
