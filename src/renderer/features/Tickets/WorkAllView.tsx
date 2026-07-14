import { makeStyles, mergeClasses, tokens, Toolbar } from '@fluentui/react-components';
import {
  Add16Regular,
  ArrowSync20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  Folder16Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useMemo, useState } from 'react';

import { CATEGORY_LABELS, categoryOf } from '@/lib/pipeline-category';
import { ATTENTION_LABELS, type AttentionReason, groupTasks } from '@/lib/task-attention';
import {
  Badge,
  Button,
  Caption1,
  Caption1Strong,
  Input,
  Menu,
  type MenuCheckedValueChangeData,
  MenuDivider,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@/renderer/ds';
import { $currentPrincipal } from '@/renderer/features/Teams/state';
import { persistedStoreApi } from '@/renderer/services/store';
import { DEFAULT_PIPELINE } from '@/shared/pipeline-defaults';
import { isActivePhase } from '@/shared/ticket-phase';
import type { Pipeline, ProjectId, Ticket } from '@/shared/types';

import { AssigneeFilter } from './AssigneeFilter';
import { $assigneeFilter, ticketApi } from './state';
import { PHASE_COLORS, PHASE_LABELS, PRIORITY_DOT_COLORS, TICKET_PRIORITY_LABELS } from './ticket-constants';

/** Done group shows the last two weeks; older tasks live on project boards. */
const DONE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const ATTENTION_COLORS: Record<AttentionReason, 'red' | 'yellow' | 'blue'> = {
  error: 'red',
  gate: 'yellow',
  agent_done: 'blue',
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalS,
    flexWrap: 'wrap',
  },
  search: {
    flex: '1 1 220px',
    minWidth: '160px',
    maxWidth: '360px',
  },
  scroll: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    paddingBottom: '32px',
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '16px',
    paddingBottom: '4px',
  },
  groupTitle: {
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: tokens.colorNeutralForeground2,
  },
  groupToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    padding: 0,
    color: tokens.colorNeutralForeground2,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '8px',
    paddingBottom: '8px',
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    width: '100%',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: tokens.colorBrandStroke1,
      outlineOffset: '-2px',
    },
  },
  rowDone: { opacity: 0.55 },
  priorityDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  title: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
  },
  projectChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    maxWidth: '160px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  stageBadge: {
    flexShrink: 0,
    display: 'none',
    '@media (min-width: 768px)': { display: 'inline-flex' },
  },
  empty: {
    padding: tokens.spacingHorizontalL,
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
});

type TaskRowProps = {
  ticket: Ticket;
  projectLabel: string | undefined;
  pipeline: Pipeline | undefined;
  done?: boolean;
  attention?: AttentionReason;
};

const TaskRow = memo(({ ticket, projectLabel, pipeline, done, attention }: TaskRowProps) => {
  const styles = useStyles();
  const handleOpen = useCallback(() => ticketApi.goToTicket(ticket.id), [ticket.id]);

  const category = categoryOf(pipeline, ticket.columnId);
  const columnLabel = pipeline?.columns.find((c) => c.id === ticket.columnId)?.label;
  const stage = columnLabel ? `${CATEGORY_LABELS[category]} · ${columnLabel}` : CATEGORY_LABELS[category];
  const isRunning = ticket.phase !== undefined && isActivePhase(ticket.phase);

  return (
    <button type="button" className={mergeClasses(styles.row, done && styles.rowDone)} onClick={handleOpen}>
      <span
        className={styles.priorityDot}
        style={{ backgroundColor: PRIORITY_DOT_COLORS[ticket.priority] ?? tokens.colorNeutralForeground3 }}
        title={TICKET_PRIORITY_LABELS[ticket.priority]}
      />
      <span className={styles.title}>{ticket.title}</span>
      {projectLabel && (
        <span className={styles.projectChip} title={projectLabel}>
          <Folder16Regular />
          {projectLabel}
        </span>
      )}
      {attention && <Badge color={ATTENTION_COLORS[attention]}>{ATTENTION_LABELS[attention]}</Badge>}
      {!attention && !done && <Badge className={styles.stageBadge}>{stage}</Badge>}
      {isRunning && ticket.phase && PHASE_LABELS[ticket.phase] && (
        <Badge color={PHASE_COLORS[ticket.phase] ?? 'default'}>
          <ArrowSync20Regular style={{ width: 12, height: 12 }} />
          {PHASE_LABELS[ticket.phase]}
        </Badge>
      )}
    </button>
  );
});
TaskRow.displayName = 'TaskRow';

/**
 * The Work tab's landing view: every task across every project, grouped
 * attention-first — Needs you → Doing → To do → Done. Groups key on the
 * column's status category (+ derived attention), never on raw column ids,
 * so custom pipelines all read the same way here.
 */
export const WorkAllView = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const assigneeFilter = useStore($assigneeFilter);
  const currentPrincipal = useStore($currentPrincipal);

  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState<ProjectId | 'all'>('all');
  const [doneExpanded, setDoneExpanded] = useState(false);

  const pipelines = useMemo(() => {
    const map = new Map<ProjectId, Pipeline>();
    for (const project of store.projects) {
      map.set(project.id, project.pipeline ?? DEFAULT_PIPELINE);
    }
    return map;
  }, [store.projects]);
  const pipelineFor = useCallback((projectId: ProjectId) => pipelines.get(projectId), [pipelines]);

  const projectLabels = useMemo(() => {
    const map: Record<ProjectId, string> = {};
    for (const p of store.projects) {
      map[p.id] = p.label;
    }
    return map;
  }, [store.projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return store.tickets.filter((t) => {
      if (t.archivedAt) {
        return false;
      }
      if (projectFilter !== 'all' && t.projectId !== projectFilter) {
        return false;
      }
      if (assigneeFilter === 'me') {
        if (!currentPrincipal || t.assignee !== currentPrincipal) {
          return false;
        }
      } else if (assigneeFilter === 'unassigned') {
        if (t.assignee) {
          return false;
        }
      } else if (assigneeFilter !== 'all' && t.assignee !== assigneeFilter) {
        return false;
      }
      if (q && !t.title.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [store.tickets, query, projectFilter, assigneeFilter, currentPrincipal]);

  const grouped = useMemo(() => groupTasks(filtered, pipelineFor), [filtered, pipelineFor]);

  const doneWindowed = useMemo(() => {
    const cutoff = Date.now() - DONE_WINDOW_MS;
    return grouped.done.filter((t) => (t.resolvedAt ?? t.updatedAt) >= cutoff);
  }, [grouped.done]);

  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value), []);
  const toggleDone = useCallback(() => setDoneExpanded((v) => !v), []);
  const handleProjectFilterChange = useCallback((_e: unknown, data: MenuCheckedValueChangeData) => {
    if (data.name === 'project') {
      setProjectFilter((data.checkedItems[0] ?? 'all') as ProjectId | 'all');
    }
  }, []);

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

  const projectFilterLabel = projectFilter === 'all' ? 'All projects' : (projectLabels[projectFilter] ?? 'Project');
  const isEmpty =
    grouped.needsYou.length === 0 &&
    grouped.doing.length === 0 &&
    grouped.todo.length === 0 &&
    doneWindowed.length === 0;

  return (
    <div className={styles.root} data-slot="work-all-view">
      <Toolbar aria-label="Task filters" className={styles.toolbar}>
        <Input
          aria-label="Search tasks"
          type="text"
          value={query}
          onChange={handleQueryChange}
          placeholder="Search tasks…"
          size="sm"
          className={styles.search}
        />
        <Menu
          positioning={{ position: 'below', align: 'start' }}
          checkedValues={{ project: [projectFilter] }}
          onCheckedValueChange={handleProjectFilterChange}
        >
          <MenuTrigger disableButtonEnhancement>
            <Button size="sm" variant="ghost" leftIcon={<Folder16Regular />}>
              {projectFilterLabel}
            </Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItemRadio name="project" value="all">
                All projects
              </MenuItemRadio>
              <MenuDivider />
              {store.projects.map((p) => (
                <MenuItemRadio key={p.id} name="project" value={p.id}>
                  {p.label}
                </MenuItemRadio>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
        <AssigneeFilter />
        <div style={{ flex: '1 1 0' }} />
        <Menu positioning={{ position: 'below', align: 'end' }}>
          <MenuTrigger disableButtonEnhancement>
            <Button size="sm" leftIcon={<Add16Regular />}>
              New task
            </Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {store.projects.length === 0 ? (
                <MenuItem disabled>Create a project first</MenuItem>
              ) : (
                store.projects.map((p) => (
                  <MenuItem key={p.id} onClick={handleNewTask.bind(null, p.id)}>
                    {p.label}
                  </MenuItem>
                ))
              )}
            </MenuList>
          </MenuPopover>
        </Menu>
      </Toolbar>

      <div className={styles.scroll}>
        {isEmpty && <p className={styles.empty}>{query ? 'No tasks match your search.' : 'No tasks yet.'}</p>}

        {grouped.needsYou.length > 0 && (
          <>
            <div className={styles.groupHeader}>
              <Caption1Strong className={styles.groupTitle}>Needs you</Caption1Strong>
              <Caption1>({grouped.needsYou.length})</Caption1>
            </div>
            {grouped.needsYou.map(({ ticket, reason }) => (
              <TaskRow
                key={ticket.id}
                ticket={ticket}
                projectLabel={projectLabels[ticket.projectId]}
                pipeline={pipelineFor(ticket.projectId)}
                attention={reason}
              />
            ))}
          </>
        )}

        {grouped.doing.length > 0 && (
          <>
            <div className={styles.groupHeader}>
              <Caption1Strong className={styles.groupTitle}>Doing</Caption1Strong>
              <Caption1>({grouped.doing.length})</Caption1>
            </div>
            {grouped.doing.map((ticket) => (
              <TaskRow
                key={ticket.id}
                ticket={ticket}
                projectLabel={projectLabels[ticket.projectId]}
                pipeline={pipelineFor(ticket.projectId)}
              />
            ))}
          </>
        )}

        {grouped.todo.length > 0 && (
          <>
            <div className={styles.groupHeader}>
              <Caption1Strong className={styles.groupTitle}>To do</Caption1Strong>
              <Caption1>({grouped.todo.length})</Caption1>
            </div>
            {grouped.todo.map((ticket) => (
              <TaskRow
                key={ticket.id}
                ticket={ticket}
                projectLabel={projectLabels[ticket.projectId]}
                pipeline={pipelineFor(ticket.projectId)}
              />
            ))}
          </>
        )}

        {doneWindowed.length > 0 && (
          <>
            <div className={styles.groupHeader}>
              <button type="button" className={styles.groupToggle} onClick={toggleDone}>
                {doneExpanded ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
                <Caption1Strong className={styles.groupTitle}>Done</Caption1Strong>
                <Caption1>({doneWindowed.length} in the last 14 days)</Caption1>
              </button>
            </div>
            {doneExpanded &&
              doneWindowed.map((ticket) => (
                <TaskRow
                  key={ticket.id}
                  ticket={ticket}
                  projectLabel={projectLabels[ticket.projectId]}
                  pipeline={pipelineFor(ticket.projectId)}
                  done
                />
              ))}
          </>
        )}
      </div>
    </div>
  );
});
WorkAllView.displayName = 'WorkAllView';
