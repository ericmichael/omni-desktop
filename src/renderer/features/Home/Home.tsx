import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import {
  Add20Regular,
  ArrowSync20Regular,
  Chat20Regular,
  CheckmarkCircle16Regular,
  Dismiss16Regular,
  ErrorCircle16Regular,
  Folder16Regular,
  History20Regular,
  Lightbulb20Regular,
  MailInbox20Regular,
  Open16Regular,
  Pin20Filled,
  Pin20Regular,
  Play20Filled,
  Search20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { isProjectPinned, projectOpenTicketCount, rankFocusForProject } from '@/lib/home-rollup';
import { doneColumnIds } from '@/lib/pipeline-category';
import { computeShippedDigest, localBoundaries } from '@/lib/shipped-digest';
import { ATTENTION_LABELS, type AttentionReason, groupTasks } from '@/lib/task-attention';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Caption1Strong,
  IconButton,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Title3,
} from '@/renderer/ds';
import { codeApi } from '@/renderer/features/Code/state';
import { useRecentConversations } from '@/renderer/features/Code/use-recent-conversations';
import { $commandPaletteOpen } from '@/renderer/features/CommandPalette/CommandPalette';
import { $quickCaptureOpen } from '@/renderer/features/Inbox/QuickCapture';
import { $activeInbox, goToInbox } from '@/renderer/features/Inbox/state';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { ProjectCreateDialog } from '@/renderer/features/Projects/ProjectCreateDialog';
import { goToRoutine } from '@/renderer/features/ScheduledTasks/state';
import { ticketApi } from '@/renderer/features/Tickets/state';
import { PHASE_COLORS, PHASE_LABELS } from '@/renderer/features/Tickets/ticket-constants';
import { $columnActivity } from '@/renderer/services/column-activity';
import { persistedStoreApi } from '@/renderer/services/store';
import { $glassEnabled } from '@/renderer/theme/use-glass';
import { DEFAULT_PIPELINE } from '@/shared/pipeline-defaults';
import { isActivePhase } from '@/shared/ticket-phase';
import type {
  ActivityEvent,
  ChatConversation,
  CodeTab,
  ColumnId,
  Pipeline,
  Project,
  ProjectId,
  Ticket,
} from '@/shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;

const ATTENTION_COLORS: Record<AttentionReason, 'red' | 'yellow' | 'blue'> = {
  error: 'red',
  gate: 'yellow',
  agent_done: 'blue',
};

/** Shared focus ring for Home's hand-rolled interactive rows. */
const FOCUS_VISIBLE = {
  ':focus-visible': {
    outlineWidth: '2px',
    outlineStyle: 'solid',
    outlineColor: tokens.colorBrandStroke1,
    outlineOffset: '-2px',
  },
} as const;

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  rootGlass: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  scroll: { flex: '1 1 0', minHeight: 0, overflowY: 'auto' },
  /* Main column always; the feed rail joins at ≥1200px once it has content. */
  layout: {
    display: 'flex',
    justifyContent: 'center',
    columnGap: '48px',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '32px',
    paddingBottom: '48px',
  },
  main: {
    width: '100%',
    maxWidth: '720px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '28px',
  },
  rail: {
    width: '300px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '28px',
  },

  /* ── Greeting ── */
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
  statusSentence: {
    color: tokens.colorNeutralForeground2,
  },
  statusLink: {
    border: 'none',
    backgroundColor: 'transparent',
    padding: 0,
    cursor: 'pointer',
    font: 'inherit',
    color: tokens.colorBrandForeground1,
    ':hover': { textDecorationLine: 'underline' },
    ...FOCUS_VISIBLE,
  },

  /* ── Jump box + quick actions ── */
  jumpRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  jumpBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    paddingLeft: '14px',
    paddingRight: '14px',
    paddingTop: '10px',
    paddingBottom: '10px',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
    cursor: 'pointer',
    textAlign: 'left',
    ':hover': { ...shorthands.borderColor(tokens.colorNeutralStroke1Hover), color: tokens.colorNeutralForeground2 },
    ...FOCUS_VISIBLE,
  },
  jumpBoxLabel: { flex: '1 1 0', minWidth: 0 },
  jumpBoxKbd: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: '1px 5px',
  },
  quickActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },

  /* ── Section shell ── */
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
  sectionIcon: { color: tokens.colorNeutralForeground3, display: 'inline-flex' },
  sectionTitle: {
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: tokens.colorNeutralForeground2,
  },
  sectionMeta: { color: tokens.colorNeutralForeground3 },

  /* ── Rows (needs-you, running, continue) ── */
  taskRow: {
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
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ...FOCUS_VISIBLE,
  },
  taskRowMain: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  taskRowTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
  },
  taskRowSub: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowTime: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },

  /* ── This week ── */
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '10px',
    paddingLeft: '16px',
    paddingRight: '16px',
  },
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
  cardTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: tokens.fontWeightSemibold,
  },
  cardMeta: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
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
    ...FOCUS_VISIBLE,
  },
  cardFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '4px',
    marginTop: '2px',
  },

  /* Pin suggestions (projects exist, none pinned) */
  pinSuggestions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingLeft: '8px',
    paddingRight: '8px',
    paddingBottom: '8px',
  },
  pinSuggestionHint: {
    paddingLeft: '8px',
    paddingTop: '8px',
    paddingBottom: '6px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  pinSuggestionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: '8px',
    paddingRight: '8px',
    paddingTop: '6px',
    paddingBottom: '6px',
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  pinSuggestionLabel: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  pinSuggestionMeta: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },

  /* Recent (unpinned) projects — quiet inline links under the cards */
  recentProjects: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: '16px',
    rowGap: '4px',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '4px',
  },
  recentProjectLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    border: 'none',
    backgroundColor: 'transparent',
    padding: 0,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    ':hover': { color: tokens.colorNeutralForeground1 },
    ...FOCUS_VISIBLE,
  },

  /* ── While you were away ── */
  feedDay: {
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '10px',
    paddingBottom: '2px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: tokens.fontWeightSemibold,
  },
  feedRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    paddingLeft: '16px',
    paddingRight: '16px',
    paddingTop: '6px',
    paddingBottom: '6px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ...FOCUS_VISIBLE,
  },
  feedIcon: { flexShrink: 0, marginTop: '2px', display: 'inline-flex' },
  feedIconOk: { color: tokens.colorPaletteGreenForeground1 },
  feedIconFail: { color: tokens.colorPaletteRedForeground1 },
  feedMain: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  feedTitle: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  feedOutcome: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },

  /* ── Growth hint ── */
  hint: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '12px 16px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px dashed ${tokens.colorNeutralStroke1}`,
    color: tokens.colorNeutralForeground2,
  },
  hintIcon: { flexShrink: 0, marginTop: '2px', color: tokens.colorNeutralForeground3 },
  hintBody: { flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' },
  hintText: { fontSize: tokens.fontSizeBase300 },
  hintActions: { display: 'flex', alignItems: 'center', gap: '8px' },
});

/* ---------- Time helpers ---------- */

/** Re-render once a minute so the greeting and relative ages stay fresh. */
const useNowMinute = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
};

const greetingWord = (now: number): string => {
  const hour = new Date(now).getHours();
  if (hour < 5) {
    return 'Good evening';
  }
  if (hour < 12) {
    return 'Good morning';
  }
  if (hour < 18) {
    return 'Good afternoon';
  }
  return 'Good evening';
};

const relTime = (ts: number, now: number): string => {
  const delta = now - ts;
  if (delta < 60_000) {
    return 'just now';
  }
  if (delta < 60 * 60_000) {
    return `${Math.floor(delta / 60_000)}m ago`;
  }
  if (delta < DAY_MS) {
    return `${Math.floor(delta / (60 * 60_000))}h ago`;
  }
  const days = Math.floor(delta / DAY_MS);
  if (days < 14) {
    return `${days}d ago`;
  }
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const feedDayLabel = (ts: number, now: number): string => {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ts >= startOfToday) {
    return 'Today';
  }
  if (ts >= startOfToday - DAY_MS) {
    return 'Yesterday';
  }
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

const timeOfDay = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/* ---------- Wide-rail media query (feed moves to a right rail ≥1200px) ---------- */

const RAIL_MQ = '(min-width: 1200px)';
const subscribeRailMQ = (cb: () => void) => {
  const mql = window.matchMedia(RAIL_MQ);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
};
const getIsRailWide = () => window.matchMedia(RAIL_MQ).matches;
const getIsRailWideServer = () => false;

/* ---------- Section shell ---------- */

const Section = memo(
  ({
    icon,
    title,
    meta,
    actions,
    children,
  }: {
    icon: React.ReactNode;
    title: string;
    meta?: string;
    actions?: React.ReactNode;
    children: React.ReactNode;
  }) => {
    const styles = useStyles();
    return (
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionIcon}>{icon}</span>
          <Caption1Strong className={styles.sectionTitle}>{title}</Caption1Strong>
          {meta && <Caption1 className={styles.sectionMeta}>{meta}</Caption1>}
          <div style={{ flex: '1 1 0' }} />
          {actions}
        </div>
        {children}
      </div>
    );
  }
);
Section.displayName = 'Section';

/* ---------- Generic actor row (needs-you + running, all actor kinds) ---------- */

const ActorRow = memo(
  ({ title, sub, badge, onOpen }: { title: string; sub?: string; badge: React.ReactNode; onOpen: () => void }) => {
    const styles = useStyles();
    return (
      <button type="button" className={styles.taskRow} onClick={onOpen}>
        <div className={styles.taskRowMain}>
          <span className={styles.taskRowTitle}>{title}</span>
          {sub && <span className={styles.taskRowSub}>{sub}</span>}
        </div>
        {badge}
      </button>
    );
  }
);
ActorRow.displayName = 'ActorRow';

/* ---------- Continue row ---------- */

const ContinueRow = memo(({ conversation, now }: { conversation: ChatConversation; now: number }) => {
  const styles = useStyles();
  const handleOpen = useCallback(() => {
    void codeApi.addTabForConversation(conversation);
    persistedStoreApi.setKey('layoutMode', 'chat');
  }, [conversation]);
  return (
    <button type="button" className={styles.taskRow} onClick={handleOpen}>
      <div className={styles.taskRowMain}>
        <span className={styles.taskRowTitle}>{conversation.title}</span>
      </div>
      <span className={styles.rowTime}>{relTime(conversation.lastActiveAt, now)}</span>
    </button>
  );
});
ContinueRow.displayName = 'ContinueRow';

/* ---------- Pinned project card ---------- */

const ProjectCard = memo(
  ({
    project,
    openCount,
    runningCount,
    nextUp,
  }: {
    project: Project;
    openCount: number;
    runningCount: number;
    nextUp: Ticket | null;
  }) => {
    const styles = useStyles();
    const now = Date.now();
    const dueDays = project.dueDate !== undefined ? Math.ceil((project.dueDate - now) / DAY_MS) : null;
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
        ticketApi.requestStartSupervisor(nextUp.id);
      }
    }, [nextUp]);

    const handleOpen = useCallback(() => {
      ticketApi.goToProject(project.id);
    }, [project.id]);

    const handleUnpin = useCallback(() => {
      void ticketApi.updateProject(project.id, { pinnedAt: null });
    }, [project.id]);

    return (
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleBlock}>
            <Body1 className={styles.cardTitle}>{project.label}</Body1>
            <div className={styles.cardMeta}>
              <span>
                {openCount} open task{openCount === 1 ? '' : 's'}
              </span>
              {deadlineLabel && <span>· {deadlineLabel}</span>}
              {runningCount > 0 && <Badge color="blue">{runningCount} running</Badge>}
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
          <Caption1 className={styles.nextUpLabel}>No open tasks in this project.</Caption1>
        )}

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

/* ---------- Feed row ---------- */

const FeedRow = memo(({ event }: { event: ActivityEvent }) => {
  const styles = useStyles();
  const handleOpen = useCallback(() => {
    if (event.link.type === 'ticket') {
      ticketApi.goToTicket(event.link.ticketId);
    } else {
      goToRoutine(event.link.taskId);
    }
  }, [event.link]);
  const failed = event.kind === 'run_failed';
  const verb = failed ? 'failed' : event.kind === 'routine_run_finished' ? 'Routine finished' : 'Agent finished';
  return (
    <button type="button" className={styles.feedRow} onClick={handleOpen}>
      <span className={mergeClasses(styles.feedIcon, failed ? styles.feedIconFail : styles.feedIconOk)}>
        {failed ? <ErrorCircle16Regular /> : <CheckmarkCircle16Regular />}
      </span>
      <div className={styles.feedMain}>
        <span className={styles.feedTitle}>{event.title}</span>
        <span className={styles.feedOutcome}>
          {failed ? `Failed${event.outcome ? ` — ${event.outcome}` : ''}` : (event.outcome ?? verb)}
        </span>
      </div>
      <span className={styles.rowTime}>{timeOfDay(event.at)}</span>
    </button>
  );
});
FeedRow.displayName = 'FeedRow';

/* ---------- Needs-you / running rollups ---------- */

type ActorEntry = { key: string; title: string; sub?: string; badge: React.ReactNode; onOpen: () => void };

const openColumn = (tabId: string) => {
  codeApi.setActiveTab(tabId);
  persistedStoreApi.setKey('layoutMode', 'chat');
};

/* ---------- Home ---------- */

/**
 * The rail's Home tab. Sections render iff their data exists — a chat-only
 * user sees a start page (greeting, jump box, recent conversations); the
 * dashboard sections (Needs you, This week, Running now, the activity feed)
 * materialize as projects, routines, and background runs come into being.
 * Never asks the user what kind of user they are.
 */
export const Home = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const milestonesMap = useStore($milestones);
  const activeInbox = useStore($activeInbox);
  const columnActivity = useStore($columnActivity);
  const isGlass = useStore($glassEnabled);
  const now = useNowMinute();
  const isRailWide = useSyncExternalStore(subscribeRailMQ, getIsRailWide, getIsRailWideServer);

  const [createOpen, setCreateOpen] = useState(false);

  const needsYouRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef<HTMLDivElement>(null);

  const handleNewProject = useCallback(() => setCreateOpen(true), []);
  const handleCloseCreate = useCallback(() => setCreateOpen(false), []);
  const handleCreated = useCallback((project: Project) => {
    ticketApi.goToProject(project.id);
  }, []);
  const handleOpenPalette = useCallback(() => $commandPaletteOpen.set(true), []);
  const handleNewChat = useCallback(() => {
    void codeApi.addTab();
    persistedStoreApi.setKey('layoutMode', 'chat');
  }, []);
  const handleCapture = useCallback(() => $quickCaptureOpen.set(true), []);
  const handleNewTask = useCallback((projectId: ProjectId) => {
    void ticketApi
      .addTicket({
        projectId,
        title: 'Untitled',
        description: '',
        priority: 'medium',
        blockedBy: [],
      })
      .then((ticket) => ticketApi.goToTicket(ticket.id));
  }, []);
  const handleGoInbox = useCallback(() => goToInbox(), []);
  const scrollToNeedsYou = useCallback(() => needsYouRef.current?.scrollIntoView({ block: 'start' }), []);
  const scrollToRunning = useCallback(() => runningRef.current?.scrollIntoView({ block: 'start' }), []);

  const tickets = useMemo(() => store.tickets.filter((ticket) => !ticket.archivedAt), [store.tickets]);
  const milestones = useMemo(() => Object.values(milestonesMap), [milestonesMap]);
  const projects = store.projects;
  const scheduledTasks = useMemo(() => store.scheduledTasks ?? [], [store.scheduledTasks]);
  const codeTabs = useMemo(() => store.codeTabs ?? [], [store.codeTabs]);
  const activityLog = useMemo(() => store.activityLog ?? [], [store.activityLog]);

  const { recent: recentConversations } = useRecentConversations(codeTabs);

  const pipelines = useMemo(() => {
    const map = new Map<ProjectId, Pipeline>();
    for (const project of projects) {
      map.set(project.id, project.pipeline ?? DEFAULT_PIPELINE);
    }
    return map;
  }, [projects]);
  const pipelineFor = useCallback((projectId: ProjectId) => pipelines.get(projectId), [pipelines]);

  const grouped = useMemo(() => groupTasks(tickets, pipelineFor), [tickets, pipelineFor]);

  const projectLabels = useMemo(() => {
    const map: Record<ProjectId, string> = {};
    for (const p of projects) {
      map[p.id] = p.label;
    }
    return map;
  }, [projects]);

  /** Label for a deck column: ticket title > project > 'Chat'. */
  const columnLabel = useCallback(
    (tab: CodeTab): string => {
      if (tab.ticketTitle) {
        return tab.ticketTitle;
      }
      if (tab.projectId) {
        return projectLabels[tab.projectId] ?? 'Session';
      }
      return 'Chat';
    },
    [projectLabels]
  );

  // ── Needs you: every actor kind, one list ──
  const needsYou = useMemo<ActorEntry[]>(() => {
    const entries: ActorEntry[] = [];
    for (const { ticket, reason } of grouped.needsYou) {
      entries.push({
        key: `t:${ticket.id}`,
        title: ticket.title,
        sub: projectLabels[ticket.projectId],
        badge: <Badge color={ATTENTION_COLORS[reason]}>{ATTENTION_LABELS[reason]}</Badge>,
        onOpen: () => ticketApi.goToTicket(ticket.id),
      });
    }
    for (const task of scheduledTasks) {
      if (task.history[0]?.status === 'waiting_for_approval') {
        entries.push({
          key: `r:${task.id}`,
          title: task.name,
          sub: 'Routine',
          badge: <Badge color="yellow">Needs approval</Badge>,
          onOpen: () => goToRoutine(task.id),
        });
      }
    }
    for (const tab of codeTabs) {
      // Routine columns are covered by the routine entry above.
      if (tab.routineId || !columnActivity[tab.id]?.pendingApproval) {
        continue;
      }
      entries.push({
        key: `c:${tab.id}`,
        title: columnLabel(tab),
        sub: 'Session',
        badge: <Badge color="yellow">Waiting for approval</Badge>,
        onOpen: () => openColumn(tab.id),
      });
    }
    return entries;
  }, [grouped.needsYou, scheduledTasks, codeTabs, columnActivity, columnLabel, projectLabels]);

  // ── Running now: tickets with an active phase, running routines, busy chat columns ──
  const running = useMemo<ActorEntry[]>(() => {
    const entries: ActorEntry[] = [];
    for (const ticket of tickets) {
      if (!ticket.resolution && ticket.phase !== undefined && isActivePhase(ticket.phase)) {
        entries.push({
          key: `t:${ticket.id}`,
          title: ticket.title,
          sub: projectLabels[ticket.projectId],
          badge:
            ticket.phase && PHASE_LABELS[ticket.phase] ? (
              <Badge color={PHASE_COLORS[ticket.phase] ?? 'default'}>{PHASE_LABELS[ticket.phase]}</Badge>
            ) : null,
          onOpen: () => ticketApi.goToTicket(ticket.id),
        });
      }
    }
    for (const task of scheduledTasks) {
      if (task.history[0]?.status === 'running') {
        entries.push({
          key: `r:${task.id}`,
          title: task.name,
          sub: 'Routine',
          badge: <Badge color="blue">Running</Badge>,
          onOpen: () => goToRoutine(task.id),
        });
      }
    }
    for (const tab of codeTabs) {
      // Ticket/routine columns are already represented by their own entries.
      if (tab.ticketId || tab.routineId || !columnActivity[tab.id]?.thinking) {
        continue;
      }
      entries.push({
        key: `c:${tab.id}`,
        title: columnLabel(tab),
        sub: 'Session',
        badge: <Badge color="blue">Working</Badge>,
        onOpen: () => openColumn(tab.id),
      });
    }
    return entries;
  }, [tickets, scheduledTasks, codeTabs, columnActivity, columnLabel, projectLabels]);

  // ── This week ──
  const pinnedProjects = useMemo(() => projects.filter((p) => isProjectPinned(p)), [projects]);
  const unpinnedProjects = useMemo(() => projects.filter((p) => !isProjectPinned(p)), [projects]);

  const terminalColumnIds = useMemo<ReadonlySet<ColumnId>>(() => {
    const set = new Set<ColumnId>();
    for (const pipeline of pipelines.values()) {
      for (const id of doneColumnIds(pipeline)) {
        set.add(id);
      }
    }
    return set;
  }, [pipelines]);

  const milestoneMapById = useMemo(() => {
    const m: Record<string, (typeof milestones)[number]> = {};
    for (const milestone of milestones) {
      m[milestone.id] = milestone;
    }
    return m;
  }, [milestones]);

  const pinCandidates = useMemo(() => {
    return unpinnedProjects
      .map((p) => ({
        project: p,
        open: projectOpenTicketCount({ project: p, tickets, terminalColumnIds }),
      }))
      .sort((a, b) => b.open - a.open)
      .slice(0, 4);
  }, [unpinnedProjects, tickets, terminalColumnIds]);

  const handlePinProject = useCallback((projectId: ProjectId) => {
    void ticketApi.updateProject(projectId, { pinnedAt: Date.now() });
  }, []);

  const handleOpenProject = useCallback((projectId: ProjectId) => {
    ticketApi.goToProject(projectId);
  }, []);

  const projectCardContext = useCallback(
    (project: Project) => {
      const focus = rankFocusForProject({
        project,
        tickets,
        milestones: milestoneMapById,
        terminalColumnIds,
        now: Date.now(),
      });
      const openCount = projectOpenTicketCount({ project, tickets, terminalColumnIds });
      const runningCount = tickets.filter(
        (t) => t.projectId === project.id && !t.resolution && t.phase !== undefined && isActivePhase(t.phase)
      ).length;
      return { nextUp: focus?.ticket ?? null, openCount, runningCount };
    },
    [tickets, milestoneMapById, terminalColumnIds]
  );

  const shipped = useMemo(() => {
    const { startOfToday, startOfWeek } = localBoundaries(new Date(now));
    return computeShippedDigest({ tickets, milestones, startOfToday, startOfWeek });
  }, [tickets, milestones, now]);

  // ── Greeting sentence: ranked fragments, max two, each a link when it can be ──
  const shippedWeekCount = shipped.week.ticketCount + shipped.week.milestoneCount;
  const fragments = useMemo(() => {
    const all: { key: string; text: string; onClick?: () => void }[] = [];
    if (needsYou.length > 0) {
      all.push({
        key: 'needs',
        text: `${needsYou.length} thing${needsYou.length === 1 ? ' needs' : 's need'} you`,
        onClick: scrollToNeedsYou,
      });
    }
    if (running.length > 0) {
      all.push({
        key: 'running',
        text: `${running.length} agent${running.length === 1 ? '' : 's'} running`,
        onClick: scrollToRunning,
      });
    }
    if (activeInbox.length > 0) {
      all.push({ key: 'inbox', text: `${activeInbox.length} in your inbox`, onClick: handleGoInbox });
    }
    if (shippedWeekCount > 0) {
      all.push({ key: 'shipped', text: `${shippedWeekCount} shipped this week` });
    }
    return all.slice(0, 2);
  }, [
    needsYou.length,
    running.length,
    activeInbox.length,
    shippedWeekCount,
    scrollToNeedsYou,
    scrollToRunning,
    handleGoInbox,
  ]);

  // ── Growth hint: one slot, first eligible undissmissed hint wins ──
  const dismissedHints = useMemo(() => store.dismissedHomeHints ?? [], [store.dismissedHomeHints]);
  const conversationCount = store.chatConversations?.length ?? 0;
  const hint = useMemo(() => {
    const hints: { id: string; text: string; cta: string; run: () => void }[] = [
      {
        id: 'make-project',
        text: 'Chats about the same work? A project keeps its files, docs, and tasks together — and agents can work inside it.',
        cta: 'Create a project',
        run: handleNewProject,
      },
      {
        id: 'try-routine',
        text: 'Doing something on a schedule? A routine runs it for you and reports back here.',
        cta: 'New routine',
        run: () => goToRoutine(),
      },
    ];
    const eligible = (id: string): boolean => {
      if (id === 'make-project') {
        return projects.length === 0 && conversationCount >= 5;
      }
      return (
        projects.length > 0 &&
        scheduledTasks.length === 0 &&
        (tickets.some((t) => t.resolution) || conversationCount >= 10)
      );
    };
    return hints.find((h) => eligible(h.id) && !dismissedHints.includes(h.id)) ?? null;
  }, [projects.length, conversationCount, scheduledTasks.length, tickets, dismissedHints, handleNewProject]);

  const handleDismissHint = useCallback(
    (id: string) => {
      persistedStoreApi.setKey('dismissedHomeHints', [...dismissedHints, id]);
    },
    [dismissedHints]
  );

  // ── Feed, grouped by day (log is newest-first) ──
  const feedGroups = useMemo(() => {
    const groups: { label: string; events: ActivityEvent[] }[] = [];
    for (const event of activityLog) {
      const label = feedDayLabel(event.at, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) {
        last.events.push(event);
      } else {
        groups.push({ label, events: [event] });
      }
    }
    return groups;
  }, [activityLog, now]);

  const feedSection = feedGroups.length > 0 && (
    <Section icon={<History20Regular style={{ width: 16, height: 16 }} />} title="While you were away">
      {feedGroups.map((group) => (
        <div key={group.label}>
          <div className={styles.feedDay}>{group.label}</div>
          {group.events.map((event) => (
            <FeedRow key={event.id} event={event} />
          ))}
        </div>
      ))}
    </Section>
  );

  return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
      <div className={styles.scroll}>
        <div className={styles.layout}>
          <div className={styles.main}>
            {/* Greeting */}
            <div className={styles.header}>
              <div className={styles.headerTitle}>
                <Title3>{greetingWord(now)}.</Title3>
                <Body1 className={styles.statusSentence}>
                  {fragments.length === 0
                    ? 'Pick up where you left off.'
                    : fragments.map((fragment, i) => (
                        <span key={fragment.key}>
                          {i > 0 && ' · '}
                          {fragment.onClick ? (
                            <button type="button" className={styles.statusLink} onClick={fragment.onClick}>
                              {fragment.text}
                            </button>
                          ) : (
                            fragment.text
                          )}
                          {i === fragments.length - 1 && '.'}
                        </span>
                      ))}
                </Body1>
              </div>
            </div>

            {/* Jump box + quick actions */}
            <div className={styles.jumpRow}>
              <button type="button" className={styles.jumpBox} onClick={handleOpenPalette}>
                <Search20Regular style={{ width: 18, height: 18, flexShrink: 0 }} />
                <span className={styles.jumpBoxLabel}>Search or jump to anything…</span>
                <span className={styles.jumpBoxKbd}>⌘K</span>
              </button>
              <div className={styles.quickActions}>
                <Button size="sm" leftIcon={<Chat20Regular />} onClick={handleNewChat}>
                  New chat
                </Button>
                <Button size="sm" variant="ghost" leftIcon={<MailInbox20Regular />} onClick={handleCapture}>
                  Capture
                </Button>
                {/* Task jargon stays hidden until the user has a project. */}
                {projects.length > 0 && (
                  <Menu positioning={{ position: 'below', align: 'start' }}>
                    <MenuTrigger disableButtonEnhancement>
                      <Button size="sm" variant="ghost" leftIcon={<Add20Regular />}>
                        New task
                      </Button>
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        {projects.map((p) => (
                          <MenuItem key={p.id} onClick={handleNewTask.bind(null, p.id)}>
                            {p.label}
                          </MenuItem>
                        ))}
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                )}
              </div>
            </div>

            {/* NEEDS YOU */}
            {needsYou.length > 0 && (
              <div ref={needsYouRef}>
                <Section
                  icon={<ErrorCircle16Regular style={{ width: 16, height: 16 }} />}
                  title="Needs you"
                  meta={`(${needsYou.length})`}
                >
                  {needsYou.map((entry) => (
                    <ActorRow
                      key={entry.key}
                      title={entry.title}
                      sub={entry.sub}
                      badge={entry.badge}
                      onOpen={entry.onOpen}
                    />
                  ))}
                </Section>
              </div>
            )}

            {/* CONTINUE */}
            {recentConversations.length > 0 && (
              <Section icon={<Chat20Regular style={{ width: 16, height: 16 }} />} title="Continue">
                {recentConversations.slice(0, 5).map((conversation) => (
                  <ContinueRow key={conversation.sessionId} conversation={conversation} now={now} />
                ))}
              </Section>
            )}

            {/* PINNED */}
            {pinnedProjects.length > 0 && (
              <Section
                icon={<Pin20Filled style={{ width: 16, height: 16 }} />}
                title="Pinned"
                meta={`(${pinnedProjects.length})`}
              >
                <div className={styles.cardGrid}>
                  {pinnedProjects.map((project) => {
                    const ctx = projectCardContext(project);
                    return (
                      <ProjectCard
                        key={project.id}
                        project={project}
                        openCount={ctx.openCount}
                        runningCount={ctx.runningCount}
                        nextUp={ctx.nextUp}
                      />
                    );
                  })}
                </div>
                {unpinnedProjects.length > 0 && (
                  <div className={styles.recentProjects}>
                    {unpinnedProjects.slice(0, 6).map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        className={styles.recentProjectLink}
                        onClick={handleOpenProject.bind(null, project.id)}
                      >
                        <Folder16Regular />
                        {project.label}
                      </button>
                    ))}
                  </div>
                )}
              </Section>
            )}

            {/* Pin suggestions — projects exist but none committed to. */}
            {pinnedProjects.length === 0 && pinCandidates.length > 0 && (
              <Section icon={<Pin20Regular style={{ width: 16, height: 16 }} />} title="Pinned">
                <div className={styles.pinSuggestions}>
                  <div className={styles.pinSuggestionHint}>
                    Pin the projects you&apos;re actively working on — they show up here.
                  </div>
                  {pinCandidates.map(({ project, open }) => (
                    <div key={project.id} className={styles.pinSuggestionRow}>
                      <span className={styles.pinSuggestionLabel}>{project.label}</span>
                      {open > 0 && <span className={styles.pinSuggestionMeta}>{open} open</span>}
                      <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<Pin20Regular />}
                        onClick={handlePinProject.bind(null, project.id)}
                      >
                        Pin
                      </Button>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* RUNNING NOW */}
            {running.length > 0 && (
              <div ref={runningRef}>
                <Section
                  icon={<ArrowSync20Regular style={{ width: 16, height: 16 }} />}
                  title="Running now"
                  meta={`(${running.length})`}
                >
                  {running.map((entry) => (
                    <ActorRow
                      key={entry.key}
                      title={entry.title}
                      sub={entry.sub}
                      badge={entry.badge}
                      onOpen={entry.onOpen}
                    />
                  ))}
                </Section>
              </div>
            )}

            {/* Feed inline when the viewport can't fit the rail. */}
            {!isRailWide && feedSection}

            {/* Growth hint — one slot, dismiss persists. */}
            {hint && (
              <div className={styles.hint}>
                <span className={styles.hintIcon}>
                  <Lightbulb20Regular />
                </span>
                <div className={styles.hintBody}>
                  <span className={styles.hintText}>{hint.text}</span>
                  <div className={styles.hintActions}>
                    <Button size="sm" onClick={hint.run}>
                      {hint.cta}
                    </Button>
                  </div>
                </div>
                <IconButton
                  aria-label="Dismiss suggestion"
                  icon={<Dismiss16Regular />}
                  size="sm"
                  onClick={handleDismissHint.bind(null, hint.id)}
                />
              </div>
            )}
          </div>

          {isRailWide && feedGroups.length > 0 && <div className={styles.rail}>{feedSection}</div>}
        </div>
      </div>
      <ProjectCreateDialog open={createOpen} onClose={handleCloseCreate} onCreated={handleCreated} />
    </div>
  );
});
Home.displayName = 'Home';
