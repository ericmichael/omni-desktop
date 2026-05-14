import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArchiveRegular,
  CalendarCheckmark20Regular,
  CheckmarkCircle20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  ErrorCircle16Regular,
  MailInbox20Regular,
  Open16Regular,
  Pin20Filled,
  Play20Filled,
  Warning16Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import {
  groupRiskSignalsForHome,
  isMilestonePinned,
  isProjectPinned,
  milestoneProgress,
  projectOpenTicketCount,
  rankFocusForMilestone,
  rankFocusForProject,
} from '@/lib/home-rollup';
import { detectRisks, type RiskSignal } from '@/lib/risk-signals';
import { computeShippedDigest, localBoundaries, type ShippedItem } from '@/lib/shipped-digest';
import { dayName, isReviewDue } from '@/lib/weekly-review';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Caption1Strong,
  IconButton,
  ProgressBar,
  Subtitle2,
  Title3,
} from '@/renderer/ds';
import { $activeInbox } from '@/renderer/features/Inbox/state';
import { $milestones, milestoneApi } from '@/renderer/features/Initiatives/state';
import { persistedStoreApi } from '@/renderer/services/store';
import { DEFAULT_PIPELINE } from '@/shared/pipeline-defaults';
import { isActivePhase } from '@/shared/ticket-phase';
import type { ColumnId, Milestone, Project, ProjectId, Ticket } from '@/shared/types';

import { ticketApi } from './state';
import { WeekPlanDialog } from './WeekPlanDialog';

const DAY_MS = 24 * 60 * 60 * 1000;

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
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
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
  },
  headerTitle: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 0',
    minWidth: 0,
    gap: '4px',
  },

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

  /* Section shell */
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
  sectionEmpty: {
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '12px',
    paddingBottom: '12px',
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    fontSize: tokens.fontSizeBase200,
  },

  /* Pinned card */
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '12px',
    paddingBottom: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
  },
  cardTitleBlock: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  cardTitleRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    minWidth: 0,
  },
  cardTitle: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: tokens.fontWeightSemibold,
  },
  cardPercent: {
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
    color: tokens.colorNeutralForeground3,
  },
  cardMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  projectTag: {
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  ownerKind: {
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
  },
  progress: { width: '100%' },

  /* Next-up row inside card */
  nextUp: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  nextUpLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    flexShrink: 0,
  },
  nextUpBtn: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    padding: 0,
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    ':hover': { color: tokens.colorBrandForeground1 },
  },

  /* Risk strip */
  riskStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },

  /* Card footer affordances */
  cardFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '4px',
    marginTop: '2px',
  },

  /* Inbox strip */
  inboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '8px',
    paddingBottom: '8px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  inboxText: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  showAllToggle: {
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
  shippedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    width: '100%',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '8px',
    paddingBottom: '8px',
    textAlign: 'left',
    border: 'none',
    backgroundColor: 'transparent',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
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
              filled
                ? used >= limit
                  ? styles.wipSlotFull
                  : styles.wipSlotFilled
                : styles.wipSlotEmpty
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
    children,
  }: {
    icon: React.ReactNode;
    title: string;
    count?: number;
    children: React.ReactNode;
  }) => {
    const styles = useStyles();
    return (
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionIcon}>{icon}</span>
          <Caption1Strong className={styles.sectionTitle}>{title}</Caption1Strong>
          {count !== undefined && count > 0 && <Caption1>({count})</Caption1>}
        </div>
        {children}
      </div>
    );
  }
);
Section.displayName = 'Section';

/* ---------- Risk strip ---------- */

const RiskStrip = memo(
  ({ signals, hasInFlight }: { signals: RiskSignal[]; hasInFlight: boolean }) => {
    const styles = useStyles();

    let selfBlocked = 0;
    let stalled = 0;
    for (const s of signals) {
      if (s.kind === 'self_blocked') {
        selfBlocked++;
      } else if (s.kind === 'stalled_ticket') {
        stalled++;
      }
    }

    if (!hasInFlight && selfBlocked === 0 && stalled === 0) {
      return null;
    }

    return (
      <div className={styles.riskStrip}>
        {hasInFlight && (
          <Badge color="green">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: tokens.colorPaletteGreenForeground1,
                }}
              />
              in flight
            </span>
          </Badge>
        )}
        {selfBlocked > 0 && (
          <Badge color="blue">
            <Warning16Regular style={{ width: 12, height: 12, marginRight: 4 }} />
            {selfBlocked} needs input
          </Badge>
        )}
        {stalled > 0 && (
          <Badge color="yellow">
            <ErrorCircle16Regular style={{ width: 12, height: 12, marginRight: 4 }} />
            {stalled} stalled
          </Badge>
        )}
      </div>
    );
  }
);
RiskStrip.displayName = 'RiskStrip';

/* ---------- Pinned milestone card ---------- */

const MilestoneCard = memo(
  ({
    milestone,
    projectLabel,
    tickets,
    nextUp,
    risks,
    hasInFlight,
  }: {
    milestone: Milestone;
    projectLabel: string;
    tickets: Ticket[];
    nextUp: Ticket | null;
    risks: RiskSignal[];
    hasInFlight: boolean;
  }) => {
    const styles = useStyles();
    const progress = useMemo(() => milestoneProgress(milestone, tickets), [milestone, tickets]);
    const pct = Math.round(progress.pct * 100);
    const now = Date.now();
    const dueDays =
      milestone.dueDate !== undefined ? Math.ceil((milestone.dueDate - now) / DAY_MS) : null;
    const deadlineLabel =
      dueDays === null
        ? null
        : dueDays < 0
          ? `${Math.abs(dueDays)}d overdue`
          : dueDays === 0
            ? 'due today'
            : `due in ${dueDays}d`;

    const handleNextUpClick = useCallback(() => {
      if (nextUp) {
        ticketApi.goToTicket(nextUp.id);
      }
    }, [nextUp]);

    const handleStart = useCallback(() => {
      if (nextUp) {
        void ticketApi.startSupervisor(nextUp.id);
      }
    }, [nextUp]);

    const handleOpen = useCallback(() => {
      ticketApi.goToMilestone(milestone.id, milestone.projectId);
    }, [milestone.id, milestone.projectId]);

    const handleUnpin = useCallback(() => {
      void milestoneApi.updateMilestone(milestone.id, { pinnedAt: undefined });
    }, [milestone.id]);

    return (
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleBlock}>
            <div className={styles.cardTitleRow}>
              <Body1 className={styles.cardTitle}>{milestone.title}</Body1>
              <Caption1 className={styles.cardPercent}>{pct}%</Caption1>
            </div>
            <div className={styles.cardMeta}>
              <span className={styles.ownerKind}>Milestone</span>
              {projectLabel && <span className={styles.projectTag}>{projectLabel}</span>}
              <span>
                {progress.resolved}/{progress.total}
              </span>
              {deadlineLabel && <span>· {deadlineLabel}</span>}
            </div>
          </div>
          <IconButton aria-label="Unpin milestone" icon={<Pin20Filled />} size="sm" onClick={handleUnpin} />
        </div>

        <ProgressBar
          value={progress.pct}
          color={pct === 100 ? 'success' : 'brand'}
          className={styles.progress}
        />

        {nextUp ? (
          <div className={styles.nextUp}>
            <span className={styles.nextUpLabel}>Next:</span>
            <button type="button" className={styles.nextUpBtn} onClick={handleNextUpClick}>
              {nextUp.title}
            </button>
            <Button size="sm" leftIcon={<Play20Filled />} onClick={handleStart}>
              Start
            </Button>
          </div>
        ) : (
          <Caption1 className={styles.nextUpLabel}>No open tickets.</Caption1>
        )}

        <RiskStrip signals={risks} hasInFlight={hasInFlight} />

        <div className={styles.cardFooter}>
          <Button size="sm" variant="ghost" leftIcon={<Open16Regular />} onClick={handleOpen}>
            Open milestone
          </Button>
        </div>
      </div>
    );
  }
);
MilestoneCard.displayName = 'MilestoneCard';

/* ---------- Pinned project card ---------- */

const ProjectCard = memo(
  ({
    project,
    openCount,
    nextUp,
    risks,
    hasInFlight,
  }: {
    project: Project;
    openCount: number;
    nextUp: Ticket | null;
    risks: RiskSignal[];
    hasInFlight: boolean;
  }) => {
    const styles = useStyles();
    const now = Date.now();
    const dueDays =
      project.dueDate !== undefined ? Math.ceil((project.dueDate - now) / DAY_MS) : null;
    const deadlineLabel =
      dueDays === null
        ? null
        : dueDays < 0
          ? `${Math.abs(dueDays)}d overdue`
          : dueDays === 0
            ? 'due today'
            : `due in ${dueDays}d`;

    const handleNextUpClick = useCallback(() => {
      if (nextUp) {
        ticketApi.goToTicket(nextUp.id);
      }
    }, [nextUp]);

    const handleStart = useCallback(() => {
      if (nextUp) {
        void ticketApi.startSupervisor(nextUp.id);
      }
    }, [nextUp]);

    const handleOpen = useCallback(() => {
      ticketApi.goToProject(project.id);
    }, [project.id]);

    const handleUnpin = useCallback(() => {
      void ticketApi.updateProject(project.id, { pinnedAt: undefined });
    }, [project.id]);

    return (
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleBlock}>
            <div className={styles.cardTitleRow}>
              <Body1 className={styles.cardTitle}>{project.label}</Body1>
            </div>
            <div className={styles.cardMeta}>
              <span className={styles.ownerKind}>Project</span>
              <span>
                {openCount} open ticket{openCount === 1 ? '' : 's'}
              </span>
              {deadlineLabel && <span>· {deadlineLabel}</span>}
            </div>
          </div>
          <IconButton aria-label="Unpin project" icon={<Pin20Filled />} size="sm" onClick={handleUnpin} />
        </div>

        {nextUp ? (
          <div className={styles.nextUp}>
            <span className={styles.nextUpLabel}>Next:</span>
            <button type="button" className={styles.nextUpBtn} onClick={handleNextUpClick}>
              {nextUp.title}
            </button>
            <Button size="sm" leftIcon={<Play20Filled />} onClick={handleStart}>
              Start
            </Button>
          </div>
        ) : (
          <Caption1 className={styles.nextUpLabel}>No open tickets in this project.</Caption1>
        )}

        <RiskStrip signals={risks} hasInFlight={hasInFlight} />

        <div className={styles.cardFooter}>
          <Button size="sm" variant="ghost" leftIcon={<Open16Regular />} onClick={handleOpen}>
            Open project
          </Button>
        </div>
      </div>
    );
  }
);
ProjectCard.displayName = 'ProjectCard';

/* ---------- Inbox strip ---------- */

const InboxStripRow = memo(({ signal }: { signal: RiskSignal }) => {
  const styles = useStyles();

  const handleClick = useCallback(() => {
    if (signal.action.kind === 'open_inbox_item') {
      ticketApi.goToInbox(signal.action.inboxItemId);
    }
  }, [signal]);

  return (
    <button type="button" className={styles.inboxRow} onClick={handleClick}>
      <MailInbox20Regular />
      <span className={styles.inboxText}>{signal.title}</span>
      {signal.detail && (
        <Caption1
          style={{
            color:
              signal.severity === 'high'
                ? tokens.colorPaletteYellowForeground1
                : tokens.colorNeutralForeground3,
          }}
        >
          {signal.detail}
        </Caption1>
      )}
    </button>
  );
});
InboxStripRow.displayName = 'InboxStripRow';

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
      <button type="button" className={styles.shippedRow} onClick={handleClick}>
        <CheckmarkCircle20Regular style={{ width: 16, height: 16 }} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 0' }}>
          <Body1
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </Body1>
          <Caption1>
            {projectLabel && (
              <span style={{ color: tokens.colorNeutralForeground2, marginRight: 6 }}>
                {projectLabel} ·
              </span>
            )}
            {subtitle}
          </Caption1>
        </div>
      </button>
    );
  }
);
ShippedRow.displayName = 'ShippedRow';

/* ---------- Main dashboard ---------- */

export const ProjectsDashboard = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const milestonesMap = useStore($milestones);
  const activeInbox = useStore($activeInbox);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [shippedExpanded, setShippedExpanded] = useState(false);

  const openReview = useCallback(() => setReviewOpen(true), []);
  const closeReview = useCallback(() => setReviewOpen(false), []);
  const toggleShipped = useCallback(() => setShippedExpanded((v) => !v), []);
  const goToInbox = useCallback(() => ticketApi.goToInbox(), []);

  const wipLimit = store.wipLimit ?? 3;

  const tickets = useMemo(
    () => store.tickets.filter((ticket) => !ticket.archivedAt),
    [store.tickets]
  );

  const milestones = useMemo(() => Object.values(milestonesMap), [milestonesMap]);

  const terminalColumnIds = useMemo<ReadonlySet<ColumnId>>(() => {
    const set = new Set<ColumnId>();
    for (const project of store.projects) {
      const columns = project.pipeline?.columns ?? DEFAULT_PIPELINE.columns;
      const last = columns[columns.length - 1];
      if (last) {
        set.add(last.id);
      }
    }
    return set;
  }, [store.projects]);

  const wipUsed = useMemo(
    () =>
      tickets.filter(
        (t) =>
          t.resolution === undefined &&
          !terminalColumnIds.has(t.columnId) &&
          t.phase !== undefined &&
          isActivePhase(t.phase)
      ).length,
    [tickets, terminalColumnIds]
  );

  const reviewDue = useMemo(
    () => isReviewDue(store.weeklyReviewDay ?? 1, store.lastWeeklyReviewAt ?? null),
    [store.weeklyReviewDay, store.lastWeeklyReviewAt]
  );

  const now = Date.now();

  const risks = useMemo(
    () =>
      detectRisks({
        tickets,
        milestones,
        inboxItems: activeInbox,
        projects: store.projects,
        terminalColumnIds,
        wipLimit,
        now,
      }),
    [tickets, milestones, activeInbox, store.projects, terminalColumnIds, wipLimit, now]
  );

  const grouped = useMemo(
    () => groupRiskSignalsForHome({ signals: risks, tickets }),
    [risks, tickets]
  );

  const milestoneMapById = useMemo(() => {
    const m: Record<string, Milestone> = {};
    for (const milestone of milestones) {
      m[milestone.id] = milestone;
    }
    return m;
  }, [milestones]);

  const projectLabels = useMemo(() => {
    const map: Record<ProjectId, string> = {};
    for (const p of store.projects) {
      map[p.id] = p.label;
    }
    return map;
  }, [store.projects]);

  const pinnedProjects = useMemo(
    () => store.projects.filter((p) => isProjectPinned(p)),
    [store.projects]
  );

  const pinnedMilestones = useMemo(
    () => milestones.filter((m) => isMilestonePinned(m) && m.status === 'active'),
    [milestones]
  );

  const totalPinned = pinnedProjects.length + pinnedMilestones.length;

  const projectCardContext = useCallback(
    (project: Project) => {
      const focus = rankFocusForProject({
        project,
        tickets,
        milestones: milestoneMapById,
        terminalColumnIds,
        now,
      });
      const projectTickets = tickets.filter((t) => t.projectId === project.id);
      const hasInFlight = projectTickets.some(
        (t) =>
          t.resolution === undefined &&
          !terminalColumnIds.has(t.columnId) &&
          t.phase !== undefined &&
          isActivePhase(t.phase)
      );
      const openCount = projectOpenTicketCount({ project, tickets, terminalColumnIds });
      return {
        nextUp: focus?.ticket ?? null,
        risks: grouped.byProject.get(project.id) ?? [],
        hasInFlight,
        openCount,
      };
    },
    [tickets, milestoneMapById, terminalColumnIds, now, grouped.byProject]
  );

  const milestoneCardContext = useCallback(
    (milestone: Milestone) => {
      const focus = rankFocusForMilestone({
        milestone,
        tickets,
        milestones: milestoneMapById,
        terminalColumnIds,
        now,
      });
      const milestoneTickets = tickets.filter((t) => t.milestoneId === milestone.id);
      const hasInFlight = milestoneTickets.some(
        (t) =>
          t.resolution === undefined &&
          !terminalColumnIds.has(t.columnId) &&
          t.phase !== undefined &&
          isActivePhase(t.phase)
      );
      return {
        nextUp: focus?.ticket ?? null,
        risks: grouped.byMilestone.get(milestone.id) ?? [],
        hasInFlight,
      };
    },
    [tickets, milestoneMapById, terminalColumnIds, now, grouped.byMilestone]
  );

  const shipped = useMemo(() => {
    const { startOfToday, startOfWeek } = localBoundaries(new Date(now));
    return computeShippedDigest({
      tickets,
      milestones,
      startOfToday,
      startOfWeek,
    });
  }, [tickets, milestones, now]);

  const hasAnyContent =
    tickets.length > 0 || activeInbox.length > 0 || store.projects.length > 0;

  if (!hasAnyContent) {
    return (
      <div className={styles.root}>
        <div className={styles.scroll}>
          <div className={styles.container}>
            <div className={styles.empty}>
              <span className={styles.emptyTilde}>~</span>
              <Body1>Nothing here yet.</Body1>
              <Caption1>Create a project or capture a thought to get started.</Caption1>
              <div className={styles.emptyActions}>
                <Button size="sm" onClick={goToInbox}>
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
            <div className={styles.headerTitle}>
              <Title3>Home</Title3>
              <Caption1>What you&apos;re focused on this week.</Caption1>
            </div>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<CalendarCheckmark20Regular />}
              onClick={openReview}
            >
              Plan week
            </Button>
          </div>

          {/* WIP gauge */}
          <WipGauge used={wipUsed} limit={wipLimit} />

          {/* Review banner (Monday) */}
          {reviewDue && (
            <button type="button" onClick={openReview} className={styles.reviewBanner}>
              <CalendarCheckmark20Regular className={styles.reviewIcon} />
              <div className={styles.reviewText}>
                <Subtitle2>
                  It&apos;s {dayName(store.weeklyReviewDay ?? 1)} — plan your week
                </Subtitle2>
                <Caption1>
                  Recap what you shipped and pin the projects or milestones you&apos;re committing to.
                </Caption1>
              </div>
              <Button size="sm" onClick={openReview}>
                Start
              </Button>
            </button>
          )}

          {/* THIS WEEK */}
          <Section
            icon={<Pin20Filled style={{ width: 16, height: 16 }} />}
            title="This week"
            count={totalPinned}
          >
            {totalPinned === 0 ? (
              <div className={styles.sectionEmpty}>
                Nothing pinned. Pin a project or milestone in the sidebar to focus on it here.
              </div>
            ) : (
              <>
                {pinnedProjects.map((project) => {
                  const ctx = projectCardContext(project);
                  return (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      openCount={ctx.openCount}
                      nextUp={ctx.nextUp}
                      risks={ctx.risks}
                      hasInFlight={ctx.hasInFlight}
                    />
                  );
                })}
                {pinnedMilestones.map((milestone) => {
                  const ctx = milestoneCardContext(milestone);
                  return (
                    <MilestoneCard
                      key={milestone.id}
                      milestone={milestone}
                      projectLabel={projectLabels[milestone.projectId] ?? ''}
                      tickets={tickets}
                      nextUp={ctx.nextUp}
                      risks={ctx.risks}
                      hasInFlight={ctx.hasInFlight}
                    />
                  );
                })}
              </>
            )}
          </Section>

          {/* Inbox strip */}
          {grouped.inbox.length > 0 && (
            <Section
              icon={<MailInbox20Regular style={{ width: 16, height: 16 }} />}
              title="Inbox"
              count={grouped.inbox.length}
            >
              {grouped.inbox.slice(0, 3).map((signal) => (
                <InboxStripRow key={signal.id} signal={signal} />
              ))}
              {grouped.inbox.length > 3 && (
                <button
                  type="button"
                  className={styles.showAllToggle}
                  onClick={goToInbox}
                >
                  <ChevronRight16Regular />
                  Show all in Inbox
                </button>
              )}
            </Section>
          )}

          {/* Shipped */}
          <Section
            icon={<ArchiveRegular style={{ width: 16, height: 16 }} />}
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
                  onClick={toggleShipped}
                >
                  {shippedExpanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                  <span>{shippedExpanded ? 'Hide details' : 'Show details'}</span>
                </button>
                {shippedExpanded &&
                  shipped.week.items.map((item) => {
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
      <WeekPlanDialog open={reviewOpen} onClose={closeReview} />
    </div>
  );
});
ProjectsDashboard.displayName = 'ProjectsDashboard';

