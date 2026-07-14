import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import {
  Add16Regular,
  Board20Regular,
  CalendarLtr16Regular,
  Chat20Regular,
  DocumentMultiple20Regular,
  DocumentText16Regular,
  Edit20Regular,
  Flag16Regular,
  Globe16Regular,
  Link16Regular,
  MoreHorizontal16Regular,
  MoreHorizontal20Regular,
  Notebook20Regular,
  Open16Regular,
  Pin20Filled,
  Pin20Regular,
  Play20Filled,
  Pulse20Regular,
  Settings20Regular,
  TextDescription20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';

import { milestoneProgress, rankFocusForProject } from '@/lib/home-rollup';
import { doneColumnIds } from '@/lib/pipeline-category';
import { sourceLabel, sourceLocation } from '@/lib/source-label';
import {
  AnimatedDialog,
  Badge,
  Button,
  Caption1,
  Caption1Strong,
  DialogBody,
  DialogContent,
  DialogHeader,
  IconButton,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@/renderer/ds';
import { $milestones } from '@/renderer/features/Initiatives/state';
import { $pages, pageApi } from '@/renderer/features/Pages/state';
import { AddSourceDialog } from '@/renderer/features/Projects/AddSourceDialog';
import { CredentialStatus } from '@/renderer/features/Projects/CredentialStatus';
import { EditSourceDialog } from '@/renderer/features/Projects/EditSourceDialog';
import { SourceDetailDialog } from '@/renderer/features/Projects/SourceDetailDialog';
import { GitCredentialDialog } from '@/renderer/features/SettingsModal/GitCredentialDialog';
import { openTicketInCode } from '@/renderer/services/navigation';
import { persistedStoreApi } from '@/renderer/services/store';
import { DEFAULT_PIPELINE } from '@/shared/pipeline-defaults';
import { isActivePhase } from '@/shared/ticket-phase';
import type { ColumnId, Milestone, Page, ProjectId, Ticket } from '@/shared/types';

import { MilestoneForm } from './MilestoneForm';
import { $tickets, ticketApi } from './state';
import { PHASE_COLORS, PHASE_LABELS, PRIORITY_DOT_COLORS, TICKET_PRIORITY_LABELS } from './ticket-constants';
import { openProjectBoard } from './WorkItemsList';

/** Root-level pages shown on Home before "View all" points at the Pages tab. */
const HOME_PAGE_LIMIT = 6;

const useStyles = makeStyles({
  root: {
    height: '100%',
    overflowY: 'auto',
  },
  container: {
    maxWidth: '1040px',
    marginLeft: 'auto',
    marginRight: 'auto',
    paddingLeft: '24px',
    paddingRight: '24px',
    paddingTop: '40px',
    paddingBottom: '64px',
    display: 'flex',
    flexDirection: 'column',
    gap: '32px',
  },

  /* ── Hero: the project's identity — big title, pin, due (Basecamp-style).
     The shell's small name row is hidden on Home so this is the only place
     the name renders. ── */
  hero: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  heroTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  heroTitleBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flex: '0 1 auto',
    minWidth: 0,
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    ':hover > .editIcon': { opacity: 1 },
  },
  heroSpacer: {
    flex: '1 1 0',
  },
  heroTitleText: {
    fontSize: tokens.fontSizeHero800,
    fontWeight: tokens.fontWeightBold,
    lineHeight: tokens.lineHeightHero800,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  heroTitleInput: {
    flex: '1 1 0',
    minWidth: 0,
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    fontSize: tokens.fontSizeHero800,
    fontWeight: tokens.fontWeightBold,
    lineHeight: tokens.lineHeightHero800,
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit',
    ':focus': { outline: 'none' },
  },
  heroEditIcon: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
  },
  heroPinActive: {
    color: tokens.colorBrandForeground1,
  },
  heroMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForeground3,
  },
  heroDueOverdue: {
    color: tokens.colorPaletteRedForeground1,
  },

  /* ── Card grid: each section is a titled card, two-up on wide windows. ── */
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    columnGap: '24px',
    rowGap: '28px',
    alignItems: 'start',
    '@media (max-width: 900px)': {
      gridTemplateColumns: '1fr',
    },
  },

  /* Section shell — header above a bordered card (the Basecamp idiom). */
  section: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingLeft: '2px',
  },
  sectionIcon: { color: tokens.colorNeutralForeground3, display: 'inline-flex' },
  sectionTitle: {
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: tokens.colorNeutralForeground2,
  },
  sectionSpacer: { flex: '1 1 0' },
  card: {
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  sectionEmpty: {
    padding: '4px 8px 8px',
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    fontSize: tokens.fontSizeBase200,
  },

  /* Board preview — column names + open counts; the card is the click
     target and jumps straight to the kanban board. */
  boardPreview: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    width: '100%',
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
  },
  boardColRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  boardColLabel: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },

  /* Context preview — the card itself is the click target. */
  contextCard: {
    position: 'relative',
    maxHeight: '320px',
    overflow: 'hidden',
    cursor: 'pointer',
    textAlign: 'left',
    width: '100%',
    display: 'block',
    padding: '4px',
    border: 'none',
    backgroundColor: 'transparent',
  },
  contextFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '56px',
    background: `linear-gradient(to bottom, transparent, ${tokens.colorNeutralBackground2})`,
    pointerEvents: 'none',
  },
  contextMarkdown: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  contextEmpty: {
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    fontSize: tokens.fontSizeBase300,
  },

  /* Generic row */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: '8px',
    paddingRight: '8px',
    paddingTop: '6px',
    paddingBottom: '6px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    width: '100%',
    textAlign: 'left',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  rowStatic: {
    cursor: 'default',
    ':hover': { backgroundColor: 'transparent' },
  },
  rowIcon: { flexShrink: 0, color: tokens.colorNeutralForeground3, display: 'inline-flex' },
  rowTitle: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
  },
  rowMeta: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  emojiIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    fontSize: '0.8125rem',
    lineHeight: 1,
    flexShrink: 0,
  },

  /* Tasks grouped under milestones (Basecamp's to-do-lists shape); the
     group list scrolls inside the card. */
  tasksScroll: {
    maxHeight: '320px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  groupHeading: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    width: '100%',
    textAlign: 'left',
    cursor: 'pointer',
    marginTop: '6px',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  groupHeadingStatic: {
    cursor: 'default',
    ':hover': { backgroundColor: 'transparent' },
  },
  groupTitle: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  groupCount: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  rowIndent: {
    paddingLeft: '28px',
  },
  priorityDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },

  /* Next-up strip — one surface level above the card it sits in. */
  nextUp: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  nextUpLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    flexShrink: 0,
  },
  nextUpBtn: {
    flex: '1 1 0',
    minWidth: 0,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    padding: 0,
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
    ':hover': { color: tokens.colorBrandForeground1 },
  },

  /* Source row */
  sourceMain: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  sourceMount: {
    fontSize: tokens.fontSizeBase300,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sourceLoc: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

/* ---------- Section shell ---------- */

const Section = memo(
  ({
    icon,
    title,
    actions,
    children,
  }: {
    icon: React.ReactNode;
    title: string;
    actions?: React.ReactNode;
    children: React.ReactNode;
  }) => {
    const styles = useStyles();
    return (
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionIcon}>{icon}</span>
          <Caption1Strong className={styles.sectionTitle}>{title}</Caption1Strong>
          <div className={styles.sectionSpacer} />
          {actions}
        </div>
        <div className={styles.card}>{children}</div>
      </div>
    );
  }
);
Section.displayName = 'Section';

/* ---------- Hero ---------- */

const DAY_MS = 24 * 60 * 60 * 1000;

const ProjectHero = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);

  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState('');

  const handleStartRename = useCallback(() => {
    if (project) {
      setEditName(project.label);
      setEditingName(true);
    }
  }, [project]);

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditName(e.target.value);
  }, []);

  const handleSaveName = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && project && trimmed !== project.label) {
      void ticketApi.renameProject(projectId, trimmed);
    }
    setEditingName(false);
  }, [editName, project, projectId]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSaveName();
      } else if (e.key === 'Escape') {
        setEditingName(false);
      }
    },
    [handleSaveName]
  );

  const handleTogglePin = useCallback(() => {
    if (project) {
      void ticketApi.updateProject(projectId, { pinnedAt: project.pinnedAt != null ? null : Date.now() });
    }
  }, [project, projectId]);

  const handleOpenSettings = useCallback(() => {
    ticketApi.goToProject(projectId, 'settings');
  }, [projectId]);

  if (!project) {
    return null;
  }

  const pinned = project.pinnedAt != null;
  const dueDays = project.dueDate !== undefined ? Math.ceil((project.dueDate - Date.now()) / DAY_MS) : null;
  const dueLabel =
    dueDays === null
      ? null
      : dueDays < 0
        ? `${Math.abs(dueDays)} days overdue`
        : dueDays === 0
          ? 'Due today'
          : `Due in ${dueDays} day${dueDays === 1 ? '' : 's'}`;

  return (
    <div className={styles.hero} data-slot="project-hero">
      <div className={styles.heroTitleRow}>
        {editingName ? (
          <input
            aria-label="Project name"
            className={styles.heroTitleInput}
            value={editName}
            onChange={handleNameChange}
            onBlur={handleSaveName}
            onKeyDown={handleNameKeyDown}
            autoFocus
          />
        ) : (
          <button type="button" className={styles.heroTitleBtn} onClick={handleStartRename} title="Rename project">
            <span className={styles.heroTitleText}>{project.label}</span>
            <Edit20Regular className={mergeClasses(styles.heroEditIcon, 'editIcon')} />
          </button>
        )}
        <IconButton
          aria-label={pinned ? 'Unpin project' : 'Pin project'}
          icon={pinned ? <Pin20Filled className={styles.heroPinActive} /> : <Pin20Regular />}
          size="sm"
          onClick={handleTogglePin}
        />
        <div className={styles.heroSpacer} />
        <Menu positioning={{ position: 'below', align: 'end' }}>
          <MenuTrigger disableButtonEnhancement>
            <IconButton aria-label="Project actions" icon={<MoreHorizontal20Regular />} size="sm" />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<Edit20Regular />} onClick={handleStartRename}>
                Rename project
              </MenuItem>
              <MenuItem icon={<Settings20Regular />} onClick={handleOpenSettings}>
                Project settings
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
      {dueLabel && (
        <Caption1 className={mergeClasses(styles.heroMeta, dueDays !== null && dueDays < 0 && styles.heroDueOverdue)}>
          <CalendarLtr16Regular />
          {dueLabel}
        </Caption1>
      )}
    </div>
  );
});
ProjectHero.displayName = 'ProjectHero';

/* ---------- Context ---------- */

const ContextSection = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const pages = useStore($pages);
  const rootPage = useMemo(
    () => Object.values(pages).find((p) => p.projectId === projectId && p.isRoot),
    [pages, projectId]
  );
  const [content, setContent] = useState<string | null>(null);

  const rootPageId = rootPage?.id;
  const rootUpdatedAt = rootPage?.updatedAt;
  useEffect(() => {
    if (!rootPageId) {
      setContent(null);
      return;
    }
    let cancelled = false;
    void pageApi.readContent(rootPageId).then((text) => {
      if (!cancelled) {
        setContent(text);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [rootPageId, rootUpdatedAt]);

  const handleOpen = useCallback(() => {
    if (rootPageId) {
      ticketApi.goToPage(rootPageId, projectId);
    }
  }, [rootPageId, projectId]);

  if (!rootPage) {
    return null;
  }

  const trimmed = (content ?? '').trim();

  return (
    <Section
      icon={<TextDescription20Regular style={{ width: 16, height: 16 }} />}
      title="Context"
      actions={
        <Button size="sm" variant="ghost" leftIcon={<Open16Regular />} onClick={handleOpen}>
          Open
        </Button>
      }
    >
      <button type="button" className={styles.contextCard} onClick={handleOpen} data-slot="project-context-preview">
        {trimmed ? (
          <>
            <div className={`prose prose-invert prose-sm max-w-none ${styles.contextMarkdown}`}>
              <Markdown>{trimmed}</Markdown>
            </div>
            <div className={styles.contextFade} />
          </>
        ) : (
          <span className={styles.contextEmpty}>
            Add context for this project — goals, constraints, links. Agents read it too.
          </span>
        )}
      </button>
    </Section>
  );
});
ContextSection.displayName = 'ContextSection';

/* ---------- Now ---------- */

const NowSection = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const ticketMap = useStore($tickets);
  const milestoneMap = useStore($milestones);
  const [milestoneFormOpen, setMilestoneFormOpen] = useState(false);

  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);

  const tickets = useMemo(
    () => Object.values(ticketMap).filter((t) => t.projectId === projectId && !t.archivedAt),
    [ticketMap, projectId]
  );

  const terminalColumnIds = useMemo<ReadonlySet<ColumnId>>(
    () => doneColumnIds(project?.pipeline ?? DEFAULT_PIPELINE),
    [project?.pipeline]
  );

  const milestones = useMemo(
    () =>
      Object.values(milestoneMap)
        .filter((m) => m.projectId === projectId && m.status === 'active')
        .sort((a, b) => a.createdAt - b.createdAt),
    [milestoneMap, projectId]
  );

  // Open tasks grouped under their milestone (Basecamp's to-do-list shape).
  // Tasks on inactive/deleted milestones fall into the ungrouped bucket so
  // nothing disappears from the card.
  const openTickets = useMemo(
    () =>
      tickets
        .filter((t) => t.resolution === undefined && !terminalColumnIds.has(t.columnId))
        .sort((a, b) => a.createdAt - b.createdAt),
    [tickets, terminalColumnIds]
  );
  const activeMilestoneIds = useMemo(() => new Set(milestones.map((m) => m.id)), [milestones]);
  const openByMilestone = useMemo(() => {
    const map = new Map<string, Ticket[]>();
    for (const ticket of openTickets) {
      if (ticket.milestoneId && activeMilestoneIds.has(ticket.milestoneId)) {
        const group = map.get(ticket.milestoneId) ?? [];
        group.push(ticket);
        map.set(ticket.milestoneId, group);
      }
    }
    return map;
  }, [openTickets, activeMilestoneIds]);
  const ungrouped = useMemo(
    () => openTickets.filter((t) => !t.milestoneId || !activeMilestoneIds.has(t.milestoneId)),
    [openTickets, activeMilestoneIds]
  );

  const nextUp = useMemo(() => {
    if (!project) {
      return null;
    }
    const focus = rankFocusForProject({
      project,
      tickets,
      milestones: milestoneMap,
      terminalColumnIds,
      now: Date.now(),
    });
    return focus?.ticket ?? null;
  }, [project, tickets, milestoneMap, terminalColumnIds]);

  const handleNextUpOpen = useCallback(() => {
    if (nextUp) {
      ticketApi.goToTicket(nextUp.id);
    }
  }, [nextUp]);
  const handleNextUpStart = useCallback(() => {
    if (nextUp) {
      ticketApi.requestStartSupervisor(nextUp.id);
    }
  }, [nextUp]);
  const handleNextUpChat = useCallback(() => {
    if (nextUp) {
      void openTicketInCode(nextUp.id);
    }
  }, [nextUp]);

  const handleNewTicket = useCallback(async () => {
    const ticket = await ticketApi.addTicket({
      projectId,
      title: 'Untitled',
      description: '',
      priority: 'medium',
      blockedBy: [],
    });
    ticketApi.goToTicket(ticket.id);
  }, [projectId]);

  const openMilestoneForm = useCallback(() => setMilestoneFormOpen(true), []);
  const closeMilestoneForm = useCallback(() => setMilestoneFormOpen(false), []);

  return (
    <Section
      icon={<Pulse20Regular style={{ width: 16, height: 16 }} />}
      title="Tasks"
      actions={
        <Button size="sm" variant="ghost" leftIcon={<Add16Regular />} onClick={openMilestoneForm}>
          New milestone
        </Button>
      }
    >
      {nextUp ? (
        <div className={styles.nextUp}>
          <span className={styles.nextUpLabel}>Next:</span>
          <button type="button" className={styles.nextUpBtn} onClick={handleNextUpOpen}>
            {nextUp.title}
          </button>
          <Button size="sm" variant="ghost" leftIcon={<Chat20Regular />} onClick={handleNextUpChat}>
            Chat
          </Button>
          <Button size="sm" leftIcon={<Play20Filled />} onClick={handleNextUpStart}>
            Start
          </Button>
        </div>
      ) : (
        <div className={styles.sectionEmpty}>
          No open tasks.{' '}
          <Button size="sm" variant="ghost" leftIcon={<Add16Regular />} onClick={handleNewTicket}>
            New task
          </Button>
        </div>
      )}

      {(milestones.length > 0 || ungrouped.length > 0) && (
        <div className={styles.tasksScroll}>
          {milestones.map((milestone) => (
            <MilestoneGroup
              key={milestone.id}
              milestone={milestone}
              tickets={tickets}
              openTasks={openByMilestone.get(milestone.id) ?? []}
            />
          ))}
          {ungrouped.length > 0 && (
            <>
              {milestones.length > 0 && (
                <div className={mergeClasses(styles.groupHeading, styles.groupHeadingStatic)}>
                  <span className={styles.rowIcon}>
                    <Flag16Regular />
                  </span>
                  <span className={styles.groupTitle}>Other tasks</span>
                  <span className={styles.groupCount}>{ungrouped.length}</span>
                </div>
              )}
              {ungrouped.map((ticket) => (
                <TaskMiniRow key={ticket.id} ticket={ticket} indent={milestones.length > 0} />
              ))}
            </>
          )}
        </div>
      )}

      <AnimatedDialog open={milestoneFormOpen} onClose={closeMilestoneForm}>
        <DialogContent>
          <DialogHeader>New Milestone</DialogHeader>
          <DialogBody>
            <MilestoneForm projectId={projectId} onClose={closeMilestoneForm} />
          </DialogBody>
        </DialogContent>
      </AnimatedDialog>
    </Section>
  );
});
NowSection.displayName = 'NowSection';

/** A milestone as a Basecamp-style to-do list: bold heading (→ milestone
 *  page) with resolved/total count, its open tasks indented underneath. */
const MilestoneGroup = memo(
  ({ milestone, tickets, openTasks }: { milestone: Milestone; tickets: Ticket[]; openTasks: Ticket[] }) => {
    const styles = useStyles();
    const progress = useMemo(() => milestoneProgress(milestone, tickets), [milestone, tickets]);
    const handleOpen = useCallback(
      () => ticketApi.goToMilestone(milestone.id, milestone.projectId),
      [milestone.id, milestone.projectId]
    );
    return (
      <div>
        <button type="button" className={styles.groupHeading} onClick={handleOpen}>
          <span className={styles.rowIcon}>
            <Flag16Regular />
          </span>
          <span className={styles.groupTitle}>{milestone.title}</span>
          <span className={styles.groupCount}>
            {progress.resolved}/{progress.total}
          </span>
        </button>
        {openTasks.map((ticket) => (
          <TaskMiniRow key={ticket.id} ticket={ticket} indent />
        ))}
      </div>
    );
  }
);
MilestoneGroup.displayName = 'MilestoneGroup';

const TaskMiniRow = memo(({ ticket, indent }: { ticket: Ticket; indent?: boolean }) => {
  const styles = useStyles();
  const handleOpen = useCallback(() => ticketApi.goToTicket(ticket.id), [ticket.id]);
  const phase = ticket.phase;
  const isRunning = phase !== undefined && isActivePhase(phase);
  return (
    <button type="button" className={mergeClasses(styles.row, indent && styles.rowIndent)} onClick={handleOpen}>
      <span
        className={styles.priorityDot}
        style={{ backgroundColor: PRIORITY_DOT_COLORS[ticket.priority] ?? tokens.colorNeutralForeground3 }}
        title={TICKET_PRIORITY_LABELS[ticket.priority]}
      />
      <span className={styles.rowTitle}>{ticket.title}</span>
      {isRunning && phase && PHASE_LABELS[phase] && (
        <Badge color={PHASE_COLORS[phase] ?? 'default'}>{PHASE_LABELS[phase]}</Badge>
      )}
    </button>
  );
});
TaskMiniRow.displayName = 'TaskMiniRow';

/* ---------- Board ---------- */

const BoardSection = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const ticketMap = useStore($tickets);
  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);
  const pipeline = project?.pipeline ?? DEFAULT_PIPELINE;

  const columnCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const ticket of Object.values(ticketMap)) {
      if (ticket.projectId === projectId && !ticket.archivedAt) {
        counts[ticket.columnId] = (counts[ticket.columnId] ?? 0) + 1;
      }
    }
    return counts;
  }, [ticketMap, projectId]);

  const handleOpen = useCallback(() => openProjectBoard(projectId), [projectId]);

  return (
    <Section
      icon={<Board20Regular style={{ width: 16, height: 16 }} />}
      title="Board"
      actions={
        <Button size="sm" variant="ghost" leftIcon={<Open16Regular />} onClick={handleOpen}>
          Open
        </Button>
      }
    >
      <button type="button" className={styles.boardPreview} onClick={handleOpen} data-slot="project-board-preview">
        {pipeline.columns.map((column) => (
          <span key={column.id} className={styles.boardColRow}>
            <span className={styles.boardColLabel}>{column.label}</span>
            <span className={styles.rowMeta}>{columnCounts[column.id] ?? 0}</span>
          </span>
        ))}
      </button>
    </Section>
  );
});
BoardSection.displayName = 'BoardSection';

/* ---------- Docs ---------- */

const PagesSection = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const pages = useStore($pages);

  const rootLevelPages = useMemo(() => {
    const rootPage = Object.values(pages).find((p) => p.projectId === projectId && p.isRoot);
    return Object.values(pages)
      .filter(
        (p) => p.projectId === projectId && !p.isRoot && (p.parentId === null || p.parentId === (rootPage?.id ?? null))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [pages, projectId]);

  const visible = rootLevelPages.slice(0, HOME_PAGE_LIMIT);

  const createPage = useCallback(
    async (kind?: Page['kind']) => {
      const all = $pages.get();
      const rootPage = Object.values(all).find((p) => p.projectId === projectId && p.isRoot);
      if (!rootPage) {
        return;
      }
      const siblings = Object.values(all).filter((p) => p.parentId === rootPage.id);
      const maxSort = siblings.reduce((max, p) => Math.max(max, p.sortOrder), 0);
      const created = await pageApi.addPage({
        projectId,
        parentId: rootPage.id,
        title: kind === 'notebook' ? 'Untitled notebook' : 'Untitled',
        sortOrder: maxSort + 1,
        ...(kind ? { kind } : {}),
      });
      ticketApi.goToPage(created.id, projectId);
    },
    [projectId]
  );

  const handleNewPage = useCallback(() => void createPage(), [createPage]);
  const handleNewNotebook = useCallback(() => void createPage('notebook'), [createPage]);
  const handleViewAll = useCallback(() => ticketApi.goToProject(projectId, 'pages'), [projectId]);

  return (
    <Section
      icon={<DocumentMultiple20Regular style={{ width: 16, height: 16 }} />}
      title="Docs"
      actions={
        <>
          <Button size="sm" variant="ghost" leftIcon={<Add16Regular />} onClick={handleNewPage}>
            New page
          </Button>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Notebook20Regular style={{ width: 16, height: 16 }} />}
            onClick={handleNewNotebook}
          >
            New notebook
          </Button>
        </>
      }
    >
      {visible.length === 0 ? (
        <div className={styles.sectionEmpty}>No pages yet.</div>
      ) : (
        visible.map((page) => <PageRow key={page.id} page={page} projectId={projectId} />)
      )}
      {rootLevelPages.length > HOME_PAGE_LIMIT && (
        <Button size="sm" variant="ghost" onClick={handleViewAll}>
          View all {rootLevelPages.length} pages →
        </Button>
      )}
    </Section>
  );
});
PagesSection.displayName = 'PagesSection';

const PageRow = memo(({ page, projectId }: { page: Page; projectId: ProjectId }) => {
  const styles = useStyles();
  const handleOpen = useCallback(() => ticketApi.goToPage(page.id, projectId), [page.id, projectId]);
  return (
    <button type="button" className={styles.row} onClick={handleOpen}>
      <span className={styles.rowIcon}>
        {page.icon ? <span className={styles.emojiIcon}>{page.icon}</span> : <DocumentText16Regular />}
      </span>
      <span className={styles.rowTitle}>{page.title || 'Untitled'}</span>
    </button>
  );
});
PageRow.displayName = 'PageRow';

/* ---------- Sources ---------- */

const SourcesSection = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const ticketMap = useStore($tickets);
  const project = useMemo(() => store.projects.find((p) => p.id === projectId), [store.projects, projectId]);
  const credentials = store.gitCredentials ?? [];

  const [addOpen, setAddOpen] = useState(false);
  const [detailSourceId, setDetailSourceId] = useState<string | null>(null);
  const [editSourceId, setEditSourceId] = useState<string | null>(null);
  const [addTokenHost, setAddTokenHost] = useState<string | null>(null);

  const handleOpenAdd = useCallback(() => setAddOpen(true), []);
  const handleCloseAdd = useCallback(() => setAddOpen(false), []);
  const handleCloseDetail = useCallback(() => setDetailSourceId(null), []);
  const handleCloseEdit = useCallback(() => setEditSourceId(null), []);
  const handleCloseAddToken = useCallback(() => setAddTokenHost(null), []);

  const handleRemove = useCallback(
    (sourceId: string) => {
      const current = persistedStoreApi.$atom.get().projects.find((p) => p.id === projectId);
      if (!current) {
        return;
      }
      void ticketApi.updateProject(projectId, { sources: current.sources.filter((s) => s.id !== sourceId) });
    },
    [projectId]
  );

  const handleEditFromDetail = useCallback(() => {
    setEditSourceId(detailSourceId);
    setDetailSourceId(null);
  }, [detailSourceId]);

  const handleRemoveFromDetail = useCallback(() => {
    if (detailSourceId) {
      handleRemove(detailSourceId);
    }
    setDetailSourceId(null);
  }, [detailSourceId, handleRemove]);

  if (!project) {
    return null;
  }

  const detailSource = detailSourceId ? project.sources.find((s) => s.id === detailSourceId) : undefined;
  const editSource = editSourceId ? project.sources.find((s) => s.id === editSourceId) : undefined;

  return (
    <Section
      icon={<Link16Regular style={{ width: 16, height: 16 }} />}
      title="Sources"
      actions={
        <Button size="sm" variant="ghost" leftIcon={<Add16Regular />} onClick={handleOpenAdd}>
          Add source
        </Button>
      }
    >
      {project.sources.length === 0 ? (
        <div className={styles.sectionEmpty}>
          No sources yet — attach a repo or folder so agents have something to work in.
        </div>
      ) : (
        project.sources.map((source) => (
          <div key={source.id} className={mergeClasses(styles.row, styles.rowStatic)}>
            <span className={styles.rowIcon}>{source.kind === 'local' ? <Link16Regular /> : <Globe16Regular />}</span>
            <button
              type="button"
              className={styles.sourceMain}
              style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left' }}
              onClick={setDetailSourceId.bind(null, source.id)}
              title={sourceLocation(source)}
            >
              <span className={styles.sourceMount}>{source.mountName}</span>
              <span className={styles.sourceLoc}>{sourceLabel(source)}</span>
              {source.kind === 'git-remote' && (
                <CredentialStatus repoUrl={source.repoUrl} credentials={credentials} onAddToken={setAddTokenHost} />
              )}
            </button>
            <Menu positioning={{ position: 'below', align: 'end' }}>
              <MenuTrigger>
                <IconButton aria-label="Source actions" icon={<MoreHorizontal16Regular />} size="sm" />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem onClick={setEditSourceId.bind(null, source.id)}>Edit source</MenuItem>
                  <MenuItem onClick={handleRemove.bind(null, source.id)}>Remove source</MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        ))
      )}

      <AddSourceDialog open={addOpen} onClose={handleCloseAdd} project={project} />
      {detailSource && (
        <SourceDetailDialog
          open
          onClose={handleCloseDetail}
          project={project}
          source={detailSource}
          tickets={Object.values(ticketMap)}
          onEdit={handleEditFromDetail}
          onRemove={handleRemoveFromDetail}
        />
      )}
      {editSource && <EditSourceDialog open onClose={handleCloseEdit} project={project} source={editSource} />}
      <GitCredentialDialog
        open={addTokenHost !== null}
        onClose={handleCloseAddToken}
        initialHost={addTokenHost ?? ''}
      />
    </Section>
  );
});
SourcesSection.displayName = 'SourcesSection';

/* ---------- Home ---------- */

/**
 * The project's homepage, Basecamp-style: a hero header (the project's big
 * title — the shell name row is hidden on Home) above a fixed grid of titled
 * cards — Context · Now · Pages · Sources. Deliberately not customizable:
 * every project reads the same way, so navigation stays predictable.
 */
export const ProjectHome = memo(({ projectId }: { projectId: ProjectId }) => {
  const styles = useStyles();
  return (
    <div className={styles.root} data-slot="project-home">
      <div className={styles.container}>
        <ProjectHero projectId={projectId} />
        <div className={styles.grid}>
          <ContextSection projectId={projectId} />
          <NowSection projectId={projectId} />
          <BoardSection projectId={projectId} />
          <PagesSection projectId={projectId} />
          <SourcesSection projectId={projectId} />
        </div>
      </div>
    </div>
  );
});
ProjectHome.displayName = 'ProjectHome';
