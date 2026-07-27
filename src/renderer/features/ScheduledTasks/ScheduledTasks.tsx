import { Field, makeStyles, mergeClasses, Switch, tokens } from '@fluentui/react-components';
import {
  Add20Regular,
  Delete20Regular,
  Edit20Regular,
  MoreHorizontal20Regular,
  Open20Regular,
  Play20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import type { ComponentProps } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { formatDuration, formatTimestamp } from '@/lib/format-time';
import { openMobileNav } from '@/renderer/app/mobile-nav';
import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import {
  Badge,
  Button,
  Caption1,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  Select,
  Textarea,
  TopAppBar,
} from '@/renderer/ds';
import { getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { SandboxPicker } from '@/renderer/features/SandboxProfile/SandboxPicker';
import { toast } from '@/renderer/features/Toast/state';
import { emitter } from '@/renderer/services/ipc';
import { $machines } from '@/renderer/services/machines';
import { scheduledTaskApi } from '@/renderer/services/scheduled-tasks';
import { persistedStoreApi } from '@/renderer/services/store';
import { $glassEnabled } from '@/renderer/theme/use-glass';
import type {
  Project,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskPermissionMode,
  ScheduledTaskRun,
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule,
} from '@/shared/types';

import { ensureRoutineSessionTab, formatDayOfWeek } from './routine-session';
import { $routinesView } from './state';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  root: {
    display: 'flex',
    width: '100%',
    height: '100%',
  },
  rootGlass: {
    backgroundColor: 'transparent',
  },
  list: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
  },
  detailPane: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  detailPaneGlass: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  /* List rows — same idiom as the Work tab's task rows. */
  row: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '2px',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalS,
    paddingTop: '8px',
    paddingBottom: '8px',
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    width: '100%',
    textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: tokens.colorBrandStroke1,
      outlineOffset: '-2px',
    },
    '&:hover .routine-row-menu': { opacity: 1 },
    '&:focus-within .routine-row-menu': { opacity: 1 },
  },
  rowMenu: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
  },
  rowMenuOpen: {
    opacity: 1,
  },
  rowTop: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  rowTitle: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  rowMeta: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /* ── Detail: the standard skeleton — full-bleed header band (title +
     actions), centered scrollable body, content | properties rail. ── */
  bandHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
  },
  bandTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  bandTitle: {
    flex: '0 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase600,
    color: tokens.colorNeutralForeground1,
  },
  bandSpacer: {
    flex: '1 1 0',
  },
  detailBody: {
    flex: '1 1 0',
    minHeight: 0,
    overflowY: 'auto',
    padding: tokens.spacingVerticalXXL,
  },
  detailBodyInner: {
    width: '100%',
    maxWidth: '56rem',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  formInner: {
    width: '100%',
    maxWidth: '36rem',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  /* Content + properties rail — stacks early: the pane sits next to the
     320px routine list. */
  split: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalXXL,
    '@media (max-width: 1000px)': {
      flexDirection: 'column',
    },
  },
  main: {
    flex: '1 1 0',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXL,
    '@media (max-width: 1000px)': {
      width: '100%',
      flex: '0 0 auto',
    },
  },
  aside: {
    width: '240px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    '@media (max-width: 1000px)': {
      width: '100%',
    },
  },
  prop: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  propText: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: '2px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  instructions: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase400,
    whiteSpace: 'pre-wrap',
    margin: 0,
  },
  runItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
  },
  runSummary: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
  toolItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  dangerMenuItem: {
    color: tokens.colorPaletteRedForeground1,
  },
  form: {
    display: 'grid',
    gap: tokens.spacingVerticalM,
  },
  formButtons: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  sandboxRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
  },
  helperText: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: '18px',
  },
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const RUN_STATUS: Record<
  ScheduledTaskRunStatus,
  { label: string; color: 'blue' | 'green' | 'red' | 'yellow' | 'default' }
> = {
  running: { label: 'Running', color: 'blue' },
  waiting_for_approval: { label: 'Needs approval', color: 'yellow' },
  completed: { label: 'Completed', color: 'green' },
  skipped: { label: 'Skipped', color: 'default' },
  failed: { label: 'Failed', color: 'red' },
};

/** Compact schedule for list rows and the detail header — no next-run time. */
function scheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.kind === 'manual') {
    return 'Manual';
  }
  if (schedule.kind === 'interval') {
    return schedule.everyMinutes === 60 ? 'Hourly' : `Every ${schedule.everyMinutes} min`;
  }
  if (schedule.kind === 'daily') {
    return `${schedule.weekdaysOnly ? 'Weekdays' : 'Daily'} at ${schedule.time}`;
  }
  return `${formatDayOfWeek(schedule.dayOfWeek)}s at ${schedule.time}`;
}

function projectLabel(task: ScheduledTask, projects: Project[]): string | null {
  if (!task.projectId) {
    return null;
  }
  return projects.find((project) => project.id === task.projectId)?.label ?? 'Unknown project';
}

function formatRunTime(run: ScheduledTaskRun): string {
  const started = formatTimestamp(run.startedAt);
  if (!run.completedAt) {
    return started;
  }
  return `${started} · ${formatDuration(run.completedAt - run.startedAt)}`;
}

/** The one state worth surfacing on a list row; everything else is noise. */
function rowAttention(task: ScheduledTask): { label: string; color: 'blue' | 'red' | 'yellow' | 'default' } | null {
  if (!task.enabled) {
    return { label: 'Paused', color: 'default' };
  }
  const last = task.history[0];
  if (!last) {
    return null;
  }
  if (last.status === 'waiting_for_approval') {
    return { label: 'Needs approval', color: 'yellow' };
  }
  if (last.status === 'running') {
    return { label: 'Running', color: 'blue' };
  }
  if (last.status === 'failed') {
    return { label: 'Failed', color: 'red' };
  }
  return null;
}

function isWaitingForApproval(run: ScheduledTaskRun): boolean {
  return run.status === 'waiting_for_approval';
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

const DEFAULT_TIME = '09:00';

type ScheduleKind = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly';

type RoutineFormState = {
  name: string;
  instructions: string;
  scheduleKind: ScheduleKind;
  time: string;
  dayOfWeek: string;
  projectId: string;
  profileName: string;
  permissionMode: ScheduledTaskPermissionMode;
  enabled: boolean;
};

const createEmptyFormState = (defaultProfileName: string | undefined): RoutineFormState => ({
  name: '',
  instructions: '',
  scheduleKind: 'daily',
  time: DEFAULT_TIME,
  dayOfWeek: '1',
  projectId: '',
  profileName: defaultProfileName ?? 'host',
  permissionMode: 'ask',
  enabled: true,
});

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * The Routines surface (hosted by the Agents tab): scheduled agent sessions
 * that run while the app is open. Follows the host's one-master grammar
 * (the Agents sidebar is the only master): the routines list fills the
 * content plane; opening a routine replaces the plane with its detail —
 * the same shape as Roster → AgentDetail.
 *
 * On mobile every level renders a TopAppBar: the list leads with the drawer
 * handle, detail/create levels with a back arrow to this list.
 */
export const ScheduledTasks = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const machines = useStore($machines);
  const isGlass = useStore($glassEnabled);
  const isDesktop = useIsDesktop();

  const [isEnterprise, setIsEnterprise] = useState(false);
  const [createForm, setCreateForm] = useState<RoutineFormState>(() => createEmptyFormState(store.defaultProfileName));
  // Selection lives in `$routinesView` (like the Inbox tab's `$inboxView`),
  // so cross-tab jumps can land on a specific routine.
  const view = useStore($routinesView);
  const selectedTaskId = view.selectedTaskId;
  const [creating, setCreating] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RoutineFormState | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduledTask | null>(null);

  useEffect(() => {
    emitter
      .invoke('platform:is-enterprise')
      .then(setIsEnterprise)
      .catch(() => setIsEnterprise(false));
  }, []);

  const sorted = useMemo(
    () =>
      [...(store.scheduledTasks ?? [])].sort(
        (a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER)
      ),
    [store.scheduledTasks]
  );

  // One plane: a routine is open only when explicitly selected — the list
  // is the surface otherwise (no auto-select; there is no second pane).
  const selectedTask = useMemo(
    () => sorted.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, sorted]
  );
  const isEditing = selectedTask !== null && editingTaskId === selectedTask.id && editForm !== null;

  const sandboxContext: ComponentProps<typeof SandboxPicker>['context'] = {
    isEnterprise,
    available: store.availableSandboxProfiles,
    machines,
  };

  // ----- handlers -----

  const cancelEdit = useCallback(() => {
    setEditingTaskId(null);
    setEditForm(null);
    setEditError(null);
  }, []);

  const startCreate = useCallback(() => {
    cancelEdit();
    setError(null);
    setCreating(true);
  }, [cancelEdit]);

  const cancelCreate = useCallback(() => {
    setCreating(false);
    setError(null);
  }, []);

  const selectTask = useCallback(
    (taskId: string) => {
      cancelEdit();
      setCreating(false);
      $routinesView.set({ selectedTaskId: taskId });
    },
    [cancelEdit]
  );

  const handleBack = useCallback(() => {
    cancelEdit();
    setCreating(false);
    $routinesView.set({ selectedTaskId: null });
  }, [cancelEdit]);

  const createTask = async () => {
    setError(null);
    try {
      const task = await scheduledTaskApi.create(toScheduledTaskInput(createForm));
      setCreateForm((current) => ({
        ...createEmptyFormState(store.defaultProfileName),
        projectId: current.projectId,
        profileName: current.profileName,
      }));
      setCreating(false);
      $routinesView.set({ selectedTaskId: task.id });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startEdit = useCallback(
    (task: ScheduledTask) => {
      setEditError(null);
      setCreating(false);
      $routinesView.set({ selectedTaskId: task.id });
      setEditingTaskId(task.id);
      setEditForm(toFormState(task, store.defaultProfileName));
    },
    [store.defaultProfileName]
  );

  const saveEdit = async (task: ScheduledTask) => {
    if (!editForm) {
      return;
    }
    setSavingTaskId(task.id);
    setEditError(null);
    try {
      await scheduledTaskApi.update(task.id, toScheduledTaskUpdate(editForm));
      cancelEdit();
    } catch (err) {
      setEditError((err as Error).message);
    } finally {
      setSavingTaskId(null);
    }
  };

  const runNow = async (task: ScheduledTask) => {
    setBusyTaskId(task.id);
    try {
      await scheduledTaskApi.runNow(task.id);
    } finally {
      setBusyTaskId(null);
    }
  };

  const confirmDelete = useCallback(() => {
    const task = pendingDelete;
    if (!task) {
      return;
    }
    void scheduledTaskApi.delete(task.id).then(() => {
      $routinesView.set({ selectedTaskId: null });
    });
  }, [pendingDelete]);

  const closeDelete = useCallback(() => setPendingDelete(null), []);

  const openSession = async (task: ScheduledTask, run: ScheduledTaskRun) => {
    if (!run.sessionId) {
      return;
    }
    try {
      await ensureRoutineSessionTab(task, run.sessionId, store, true);
    } catch (err) {
      toast.error('Cannot open routine session', err instanceof Error ? err.message : String(err));
      return;
    }
    await persistedStoreApi.setKey('layoutMode', 'chat');
  };

  // ----- panes -----

  // Full-plane list surface — band header on desktop (the Roster shape);
  // on mobile the TopAppBar titles it and the band carries only the action.
  const listSurface = (
    <>
      <div className={styles.bandHeader}>
        <div className={styles.bandTitleRow}>
          {isDesktop && <span className={styles.bandTitle}>Routines</span>}
          <div className={styles.bandSpacer} />
          <Button size="sm" leftIcon={<Add20Regular />} onClick={startCreate}>
            New routine
          </Button>
        </div>
      </div>
      <div className={styles.list}>
        {sorted.length === 0 ? (
          <EmptyState
            title="No routines yet"
            description="Routines are scheduled agent sessions that run while the app is open."
            action={
              <Button size="sm" leftIcon={<Add20Regular />} onClick={startCreate}>
                New routine
              </Button>
            }
          />
        ) : (
          sorted.map((task) => (
            <RoutineRow
              key={task.id}
              task={task}
              projects={store.projects}
              styles={styles}
              onSelect={selectTask}
              onRunNow={runNow}
              onStartEdit={startEdit}
              onRequestDelete={setPendingDelete}
            />
          ))
        )}
      </div>
    </>
  );

  const detailBody = creating ? (
    <>
      {isDesktop && (
        <div className={styles.bandHeader}>
          <div className={styles.bandTitleRow}>
            <span className={styles.bandTitle}>New routine</span>
          </div>
        </div>
      )}
      <div className={styles.detailBody}>
        <div className={styles.formInner}>
          <RoutineForm
            styles={styles}
            value={createForm}
            projects={store.projects}
            sandboxContext={sandboxContext}
            machines={machines}
            submitLabel="Create routine"
            error={error}
            onChange={setCreateForm}
            onSubmit={() => void createTask()}
            onCancel={cancelCreate}
          />
        </div>
      </div>
    </>
  ) : isEditing && selectedTask && editForm ? (
    <>
      {isDesktop && (
        <div className={styles.bandHeader}>
          <div className={styles.bandTitleRow}>
            <span className={styles.bandTitle}>Edit routine</span>
          </div>
        </div>
      )}
      <div className={styles.detailBody}>
        <div className={styles.formInner}>
          <RoutineForm
            styles={styles}
            value={editForm}
            projects={store.projects}
            sandboxContext={sandboxContext}
            machines={machines}
            submitLabel="Save changes"
            error={editError}
            showEnabled
            busy={savingTaskId === selectedTask.id}
            onChange={setEditForm}
            onSubmit={() => void saveEdit(selectedTask)}
            onCancel={cancelEdit}
          />
        </div>
      </div>
    </>
  ) : selectedTask ? (
    <RoutineDetail
      styles={styles}
      task={selectedTask}
      projects={store.projects}
      machines={machines}
      busy={busyTaskId === selectedTask.id}
      onRunNow={runNow}
      onStartEdit={startEdit}
      onRequestDelete={setPendingDelete}
      onToggle={(task, enabled) => void scheduledTaskApi.update(task.id, { enabled })}
      onOpenSession={openSession}
    />
  ) : null;

  const deleteDialog = (
    <ConfirmDialog
      open={pendingDelete !== null}
      onClose={closeDelete}
      onConfirm={confirmDelete}
      title={`Delete routine "${pendingDelete?.name ?? ''}"?`}
      description="Its schedule and run history will be removed. This action cannot be undone."
      confirmLabel="Delete"
      destructive
    />
  );

  // One master per tab: the host's sidebar is the only master. This surface
  // fills the content plane — the list, or (drilled in) a detail/form that
  // replaces it. On mobile every level carries a TopAppBar: detail backs
  // out to the list, the list leads with the drawer handle.
  const surfaceOpen = creating || selectedTask !== null;

  return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
      <div className={mergeClasses(styles.detailPane, isGlass && styles.detailPaneGlass)}>
        {!isDesktop &&
          (surfaceOpen ? (
            <TopAppBar title={creating ? 'New routine' : (selectedTask?.name ?? 'Routine')} onBack={handleBack} />
          ) : (
            <TopAppBar title="Routines" onMenu={openMobileNav} />
          ))}
        {surfaceOpen ? detailBody : listSurface}
      </div>
      {deleteDialog}
    </div>
  );
});

ScheduledTasks.displayName = 'ScheduledTasks';

// ---------------------------------------------------------------------------
// List row
// ---------------------------------------------------------------------------

type RoutineRowProps = {
  task: ScheduledTask;
  projects: Project[];
  styles: ReturnType<typeof useStyles>;
  onSelect: (taskId: string) => void;
  onRunNow: (task: ScheduledTask) => Promise<void>;
  onStartEdit: (task: ScheduledTask) => void;
  onRequestDelete: (task: ScheduledTask) => void;
};

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

const RoutineRow = memo(
  ({ task, projects, styles, onSelect, onRunNow, onStartEdit, onRequestDelete }: RoutineRowProps) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const handleClick = useCallback(() => onSelect(task.id), [onSelect, task.id]);
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelect(task.id);
        }
      },
      [onSelect, task.id]
    );
    const handleMenuOpenChange = useCallback((_e: unknown, data: { open: boolean }) => setMenuOpen(data.open), []);
    const handleRunNow = useCallback(() => void onRunNow(task), [onRunNow, task]);
    const handleEdit = useCallback(() => onStartEdit(task), [onStartEdit, task]);
    const handleDelete = useCallback(() => onRequestDelete(task), [onRequestDelete, task]);
    const attention = rowAttention(task);
    const project = projectLabel(task, projects);

    return (
      // div+role rather than <button>: the row hosts the "…" menu button, and
      // nesting buttons inside a button is invalid markup.
      <div role="button" tabIndex={0} className={styles.row} onClick={handleClick} onKeyDown={handleKeyDown}>
        <span className={styles.rowTop}>
          <span className={styles.rowTitle}>{task.name}</span>
          {attention && <Badge color={attention.color}>{attention.label}</Badge>}
          <span
            role="presentation"
            className={mergeClasses(styles.rowMenu, 'routine-row-menu', menuOpen && styles.rowMenuOpen)}
            onClick={stopPropagation}
          >
            <Menu open={menuOpen} onOpenChange={handleMenuOpenChange} positioning={{ position: 'below', align: 'end' }}>
              <MenuTrigger disableButtonEnhancement>
                <IconButton aria-label="Routine actions" icon={<MoreHorizontal20Regular />} size="sm" />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem icon={<Play20Regular />} onClick={handleRunNow}>
                    Run now
                  </MenuItem>
                  <MenuItem icon={<Edit20Regular />} onClick={handleEdit}>
                    Edit
                  </MenuItem>
                  <MenuDivider />
                  <MenuItem icon={<Delete20Regular />} className={styles.dangerMenuItem} onClick={handleDelete}>
                    Delete…
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          </span>
        </span>
        <span className={styles.rowMeta}>
          {scheduleLabel(task.schedule)}
          {project ? ` · ${project}` : ''}
        </span>
      </div>
    );
  }
);
RoutineRow.displayName = 'RoutineRow';

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

type RoutineDetailProps = {
  styles: ReturnType<typeof useStyles>;
  task: ScheduledTask;
  projects: Project[];
  machines: Parameters<typeof getProfileMenuLabel>[1];
  busy: boolean;
  onRunNow: (task: ScheduledTask) => Promise<void>;
  onStartEdit: (task: ScheduledTask) => void;
  onRequestDelete: (task: ScheduledTask) => void;
  onToggle: (task: ScheduledTask, enabled: boolean) => void;
  onOpenSession: (task: ScheduledTask, run: ScheduledTaskRun) => Promise<void>;
};

const RoutineDetail = ({
  styles,
  task,
  projects,
  machines,
  busy,
  onRunNow,
  onStartEdit,
  onRequestDelete,
  onToggle,
  onOpenSession,
}: RoutineDetailProps) => {
  const project = projectLabel(task, projects);
  const sandbox = task.profileName ? getProfileMenuLabel(task.profileName, machines) : 'Default sandbox';
  const allowedToolNames = task.allowedToolNames ?? [];
  const allowedMcpTools = task.allowedMcpTools ?? [];
  const runs = (task.history ?? []).slice(0, 5);

  return (
    <>
      {/* Header band — title + actions, like every other detail page. */}
      <div className={styles.bandHeader}>
        <div className={styles.bandTitleRow}>
          <span className={styles.bandTitle}>{task.name}</span>
          {!task.enabled && <Badge color="default">Paused</Badge>}
          <div className={styles.bandSpacer} />
          <Button size="sm" leftIcon={<Play20Regular />} onClick={() => void onRunNow(task)} isDisabled={busy}>
            Run now
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onStartEdit(task)}>
            Edit
          </Button>
          <Menu positioning={{ position: 'below', align: 'end' }}>
            <MenuTrigger disableButtonEnhancement>
              <IconButton aria-label="More actions" icon={<MoreHorizontal20Regular />} size="sm" />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem className={styles.dangerMenuItem} onClick={() => onRequestDelete(task)}>
                  Delete routine…
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </div>

      {/* Centered body: instructions + runs (content) | properties rail. */}
      <div className={styles.detailBody}>
        <div className={styles.detailBodyInner}>
          <div className={styles.split}>
            <div className={styles.main}>
              <div className={styles.section}>
                <span className={styles.sectionTitle}>Instructions</span>
                <p className={styles.instructions}>{task.instructions}</p>
              </div>

              <div className={styles.section} aria-label={`${task.name} recent runs`}>
                <span className={styles.sectionTitle}>Recent runs</span>
                {runs.length === 0 && <Caption1 className={styles.muted}>No runs yet.</Caption1>}
                {runs.map((run) => (
                  <RunItem key={run.id} styles={styles} task={task} run={run} onOpenSession={onOpenSession} />
                ))}
              </div>
            </div>

            <aside className={styles.aside} aria-label={`${task.name} properties`}>
              <div className={styles.prop}>
                <span className={styles.sectionTitle}>Status</span>
                <Switch
                  checked={task.enabled}
                  label={task.enabled ? 'Active' : 'Paused'}
                  onChange={(_, data) => onToggle(task, data.checked)}
                />
              </div>

              <div className={styles.prop}>
                <span className={styles.sectionTitle}>Schedule</span>
                <div className={styles.propText}>
                  <span>{scheduleLabel(task.schedule)}</span>
                  {task.enabled && task.nextRunAt && <span>Next {formatTimestamp(task.nextRunAt)}</span>}
                </div>
              </div>

              <div className={styles.prop}>
                <span className={styles.sectionTitle}>Project</span>
                <div className={styles.propText}>
                  <span>{project ?? 'No project'}</span>
                </div>
              </div>

              <div className={styles.prop}>
                <span className={styles.sectionTitle}>Sandbox</span>
                <div className={styles.propText}>
                  <span>{sandbox}</span>
                </div>
              </div>

              <div className={styles.prop}>
                <span className={styles.sectionTitle}>Details</span>
                <div className={styles.propText}>
                  <span>Created {formatTimestamp(task.createdAt)}</span>
                  {task.updatedAt !== task.createdAt && <span>Updated {formatTimestamp(task.updatedAt)}</span>}
                </div>
              </div>

              {(allowedToolNames.length > 0 || allowedMcpTools.length > 0) && (
                <div className={styles.prop} aria-label={`${task.name} always allowed tools`}>
                  <span className={styles.sectionTitle}>Allowed tools</span>
                  {allowedToolNames.map((toolName) => (
                    <div key={toolName} className={styles.toolItem}>
                      <code className={styles.mono}>{toolName}</code>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void scheduledTaskApi.revokeTool(task.id, toolName)}
                      >
                        Revoke
                      </Button>
                    </div>
                  ))}
                  {allowedMcpTools.map((tool) => (
                    <div key={`${tool.serverLabel}\u0000${tool.toolName}`} className={styles.toolItem}>
                      <code className={styles.mono}>
                        {tool.serverLabel} / {tool.toolName}
                      </code>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void scheduledTaskApi.revokeMcpTool(task.id, tool)}
                      >
                        Revoke
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </aside>
          </div>
        </div>
      </div>
    </>
  );
};

type RunItemProps = {
  styles: ReturnType<typeof useStyles>;
  task: ScheduledTask;
  run: ScheduledTaskRun;
  onOpenSession: (task: ScheduledTask, run: ScheduledTaskRun) => Promise<void>;
};

const RunItem = memo(({ styles, task, run, onOpenSession }: RunItemProps) => {
  const status = RUN_STATUS[run.status];
  const waiting = isWaitingForApproval(run);
  const pendingToolLabel =
    run.pendingApprovalKind === 'mcp'
      ? run.pendingApprovalServerLabel && run.pendingApprovalToolName
        ? `${run.pendingApprovalServerLabel} / ${run.pendingApprovalToolName}`
        : null
      : (run.pendingApprovalToolName ?? null);

  const handleOpen = useCallback(() => void onOpenSession(task, run), [onOpenSession, task, run]);
  const handleAllow = useCallback(() => {
    if (run.pendingApprovalKind === 'mcp') {
      if (run.pendingApprovalServerLabel && run.pendingApprovalToolName) {
        void scheduledTaskApi.allowMcpTool(task.id, {
          serverLabel: run.pendingApprovalServerLabel,
          toolName: run.pendingApprovalToolName,
        });
      }
    } else if (run.pendingApprovalToolName) {
      void scheduledTaskApi.allowTool(task.id, run.pendingApprovalToolName);
    }
  }, [run, task.id]);

  return (
    <div className={styles.runItem}>
      <div className={styles.runSummary}>
        <Badge color={status.color}>{status.label}</Badge>
        <Caption1 className={styles.muted}>{formatRunTime(run)}</Caption1>
        {run.sessionId && (
          <Button size="sm" variant="ghost" leftIcon={<Open20Regular />} onClick={handleOpen}>
            Open session
          </Button>
        )}
      </div>
      {waiting && (
        <div className={styles.runSummary}>
          <Caption1 className={styles.muted}>
            {pendingToolLabel
              ? `Waiting on “${pendingToolLabel}” — approve it in the session.`
              : 'Waiting on a tool approval — approve it in the session.'}
          </Caption1>
          {pendingToolLabel && (
            <Button size="sm" variant="ghost" onClick={handleAllow}>
              Always allow
            </Button>
          )}
        </div>
      )}
      {run.reason && <Caption1 className={styles.muted}>{run.reason}</Caption1>}
    </div>
  );
});
RunItem.displayName = 'RunItem';

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

type RoutineFormProps = {
  styles: ReturnType<typeof useStyles>;
  value: RoutineFormState;
  projects: Project[];
  sandboxContext: ComponentProps<typeof SandboxPicker>['context'];
  machines: Parameters<typeof getProfileMenuLabel>[1];
  submitLabel: string;
  error?: string | null;
  showEnabled?: boolean;
  busy?: boolean;
  onChange: (value: RoutineFormState) => void;
  onSubmit: () => void;
  onCancel?: () => void;
};

const RoutineForm = ({
  styles,
  value,
  projects,
  sandboxContext,
  machines,
  submitLabel,
  error,
  showEnabled = false,
  busy = false,
  onChange,
  onSubmit,
  onCancel,
}: RoutineFormProps) => {
  const setField = <K extends keyof RoutineFormState>(field: K, fieldValue: RoutineFormState[K]) => {
    onChange({ ...value, [field]: fieldValue });
  };

  return (
    <div className={styles.form}>
      <Field label="Name">
        <Input
          value={value.name}
          onChange={(e) => setField('name', e.target.value)}
          placeholder="Morning code review"
        />
      </Field>
      <Field label="Instructions">
        <Textarea
          value={value.instructions}
          onChange={(e) => setField('instructions', e.target.value)}
          placeholder="Review yesterday's changes and summarize any risks."
          rows={4}
        />
      </Field>
      <Field label="Project" hint="Without a project, each run gets a fresh session workspace.">
        <Select value={value.projectId} onChange={(e) => setField('projectId', e.currentTarget.value)}>
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Sandbox">
        <div className={styles.sandboxRow}>
          <SandboxPicker
            value={value.profileName}
            onChange={(profileName) => setField('profileName', profileName)}
            context={sandboxContext}
          />
          <span className={styles.helperText}>{getProfileMenuLabel(value.profileName, machines)}</span>
        </div>
      </Field>
      <Field label="Schedule">
        <Select
          value={value.scheduleKind}
          onChange={(e) => setField('scheduleKind', e.currentTarget.value as ScheduleKind)}
        >
          <option value="manual">Manual</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Weekly</option>
        </Select>
      </Field>
      {value.scheduleKind !== 'manual' && value.scheduleKind !== 'hourly' && (
        <Field label="Time">
          <Input type="time" value={value.time} onChange={(e) => setField('time', e.target.value)} />
        </Field>
      )}
      {value.scheduleKind === 'weekly' && (
        <Field label="Day">
          <Select value={value.dayOfWeek} onChange={(e) => setField('dayOfWeek', e.currentTarget.value)}>
            <option value="1">Monday</option>
            <option value="2">Tuesday</option>
            <option value="3">Wednesday</option>
            <option value="4">Thursday</option>
            <option value="5">Friday</option>
            <option value="6">Saturday</option>
            <option value="0">Sunday</option>
          </Select>
        </Field>
      )}
      {showEnabled && (
        <Switch
          checked={value.enabled}
          label={value.enabled ? 'Active' : 'Paused'}
          onChange={(_, data) => setField('enabled', data.checked)}
        />
      )}
      <div className={styles.helperText}>
        Runs ask before using tools. When a run is waiting on a specific tool, you can always-allow it for this routine
        from its run entry.
      </div>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.formButtons}>
        <Button onClick={onSubmit} isDisabled={busy || !value.name.trim() || !value.instructions.trim()}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} isDisabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Form <-> task mapping
// ---------------------------------------------------------------------------

function buildSchedule(kind: ScheduleKind, time: string, dayOfWeek: number): ScheduledTaskSchedule {
  if (kind === 'manual') {
    return { kind: 'manual' };
  }
  if (kind === 'hourly') {
    return { kind: 'interval', everyMinutes: 60 };
  }
  if (kind === 'weekdays') {
    return { kind: 'daily', time, weekdaysOnly: true };
  }
  if (kind === 'weekly') {
    return { kind: 'weekly', dayOfWeek, time };
  }
  return { kind: 'daily', time };
}

function toScheduledTaskInput(form: RoutineFormState): ScheduledTaskInput {
  return {
    name: form.name,
    instructions: form.instructions,
    description: '',
    schedule: buildSchedule(form.scheduleKind, form.time, Number(form.dayOfWeek)),
    permissionMode: form.permissionMode,
    enabled: form.enabled,
    ...(form.projectId ? { projectId: form.projectId } : {}),
    ...(form.profileName ? { profileName: form.profileName } : {}),
  };
}

function toScheduledTaskUpdate(form: RoutineFormState): ScheduledTaskInput {
  return {
    name: form.name,
    instructions: form.instructions,
    description: '',
    schedule: buildSchedule(form.scheduleKind, form.time, Number(form.dayOfWeek)),
    permissionMode: form.permissionMode,
    enabled: form.enabled,
    projectId: form.projectId,
    profileName: form.profileName,
  };
}

function toFormState(task: ScheduledTask, defaultProfileName: string | undefined): RoutineFormState {
  const schedule = task.schedule;
  const fallback = createEmptyFormState(defaultProfileName);
  if (schedule.kind === 'manual') {
    return { ...fallback, ...baseFormState(task), scheduleKind: 'manual' };
  }
  if (schedule.kind === 'interval') {
    return { ...fallback, ...baseFormState(task), scheduleKind: 'hourly' };
  }
  if (schedule.kind === 'weekly') {
    return {
      ...fallback,
      ...baseFormState(task),
      scheduleKind: 'weekly',
      time: schedule.time,
      dayOfWeek: String(schedule.dayOfWeek),
    };
  }
  return {
    ...fallback,
    ...baseFormState(task),
    scheduleKind: schedule.weekdaysOnly ? 'weekdays' : 'daily',
    time: schedule.time,
  };
}

function baseFormState(
  task: ScheduledTask
): Pick<RoutineFormState, 'name' | 'instructions' | 'projectId' | 'profileName' | 'permissionMode' | 'enabled'> {
  return {
    name: task.name,
    instructions: task.instructions,
    projectId: task.projectId ?? '',
    profileName: task.profileName ?? 'host',
    permissionMode: task.permissionMode ?? 'ask',
    enabled: task.enabled,
  };
}
