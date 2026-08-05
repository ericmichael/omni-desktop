import { useStore } from '@nanostores/react';
import { Edit, Ellipsis, ExternalLink, Play, Plus, Trash2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { formatDuration, formatTimestamp } from '@/lib/format-time';
import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import { cn } from '@/renderer/ds/cn';
import { TopAppBar } from '@/renderer/ds/TopAppBar';
import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/ds/ui/alert-dialog';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/ds/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/renderer/ds/ui/field';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Switch } from '@/renderer/ds/ui/switch';
import { Textarea } from '@/renderer/ds/ui/textarea';
import { getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { SandboxPicker } from '@/renderer/features/SandboxProfile/SandboxPicker';
import { toast } from '@/renderer/features/Toast/state';
import { emitter } from '@/renderer/services/ipc';
import { $machines } from '@/renderer/services/machines';
import { scheduledTaskApi } from '@/renderer/services/scheduled-tasks';
import { persistedStoreApi } from '@/renderer/services/store';
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
  const store = useStore(persistedStoreApi.$atom);
  const machines = useStore($machines);
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
      <div className="flex flex-col gap-0.5 pl-5 pr-5 pt-5 pb-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {isDesktop && (
            <span className="flex-initial min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-2xl font-semibold leading-8 text-foreground">
              Routines
            </span>
          )}
          <div className="flex-1" />
          <Button size="sm" onClick={startCreate}>
            <Plus />
            New routine
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {sorted.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle className="text-base">No routines yet</EmptyTitle>
              <EmptyDescription>Routines are scheduled agent sessions that run while the app is open.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={startCreate}>
                <Plus />
                New routine
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          sorted.map((task) => (
            <RoutineRow
              key={task.id}
              task={task}
              projects={store.projects}
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
        <div className="flex flex-col gap-0.5 pl-5 pr-5 pt-5 pb-2 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex-initial min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-2xl font-semibold leading-8 text-foreground">
              New routine
            </span>
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto p-8">
        <div className="w-full max-w-xl ml-auto mr-auto">
          <RoutineForm
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
        <div className="flex flex-col gap-0.5 pl-5 pr-5 pt-5 pb-2 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex-initial min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-2xl font-semibold leading-8 text-foreground">
              Edit routine
            </span>
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto p-8">
        <div className="w-full max-w-xl ml-auto mr-auto">
          <RoutineForm
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
    <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && closeDelete()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Delete routine "${pendingDelete?.name ?? ''}"?`}</AlertDialogTitle>
          <AlertDialogDescription>
            Its schedule and run history will be removed. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirmDelete}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  // One master per tab: the host's sidebar is the only master. This surface
  // fills the content plane — the list, or (drilled in) a detail/form that
  // replaces it. On mobile every level carries a TopAppBar: detail backs
  // out to the list, the list leads with the drawer handle.
  const surfaceOpen = creating || selectedTask !== null;

  return (
    <div className="flex w-full h-full">
      <div className="flex-1 min-w-0 flex flex-col">
        {!isDesktop &&
          (surfaceOpen ? (
            <TopAppBar title={creating ? 'New routine' : (selectedTask?.name ?? 'Routine')} onBack={handleBack} />
          ) : (
            <TopAppBar title="Routines" showMenu />
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
  onSelect: (taskId: string) => void;
  onRunNow: (task: ScheduledTask) => Promise<void>;
  onStartEdit: (task: ScheduledTask) => void;
  onRequestDelete: (task: ScheduledTask) => void;
};

const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

const RoutineRow = memo(({ task, projects, onSelect, onRunNow, onStartEdit, onRequestDelete }: RoutineRowProps) => {
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
  const handleMenuOpenChange = useCallback((open: boolean) => setMenuOpen(open), []);
  const handleRunNow = useCallback(() => void onRunNow(task), [onRunNow, task]);
  const handleEdit = useCallback(() => onStartEdit(task), [onStartEdit, task]);
  const handleDelete = useCallback(() => onRequestDelete(task), [onRequestDelete, task]);
  const attention = rowAttention(task);
  const project = projectLabel(task, projects);

  return (
    // div+role rather than <button>: the row hosts the "…" menu button, and
    // nesting buttons inside a button is invalid markup.
    <div
      role="button"
      tabIndex={0}
      className="flex flex-col items-stretch gap-0.5 pl-5 pr-2 pt-2 pb-2 cursor-pointer border-0 bg-transparent w-full text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-primary focus-visible:-outline-offset-2 [&:hover_.routine-row-menu]:opacity-100 [&:focus-within_.routine-row-menu]:opacity-100"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <span className="flex items-center gap-2">
        <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-foreground">
          {task.name}
        </span>
        {attention && <Badge variant="secondary">{attention.label}</Badge>}
        <span
          role="presentation"
          className={cn(
            'flex items-center shrink-0 opacity-0 transition-opacity duration-100',
            'routine-row-menu',
            menuOpen && 'opacity-100'
          )}
          onClick={stopPropagation}
        >
          <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Routine actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={handleRunNow}>
                  <Play />
                  Run now
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleEdit}>
                  <Edit />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onClick={handleDelete}>
                  <Trash2 />
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </>
          </DropdownMenu>
        </span>
      </span>
      <span className="text-xs text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
        {scheduleLabel(task.schedule)}
        {project ? ` · ${project}` : ''}
      </span>
    </div>
  );
});
RoutineRow.displayName = 'RoutineRow';

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

type RoutineDetailProps = {
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
      <div className="flex flex-col gap-0.5 pl-5 pr-5 pt-5 pb-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex-initial min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-2xl font-semibold leading-8 text-foreground">
            {task.name}
          </span>
          {!task.enabled && <Badge variant="secondary">Paused</Badge>}
          <div className="flex-1" />
          <Button size="sm" onClick={() => void onRunNow(task)} disabled={busy}>
            <Play />
            Run now
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onStartEdit(task)}>
            Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="More actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <>
              <DropdownMenuContent>
                <DropdownMenuItem className="text-destructive" onClick={() => onRequestDelete(task)}>
                  Delete routine…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </>
          </DropdownMenu>
        </div>
      </div>

      {/* Centered body: instructions + runs (content) | properties rail. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-8">
        <div className="w-full max-w-4xl ml-auto mr-auto">
          <div className="flex items-start gap-8 [@media(max-width:1000px)]:flex-col">
            <div className="flex-1 min-w-0 flex flex-col gap-6 [@media(max-width:1000px)]:w-full [@media(max-width:1000px)]:flex-none">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Instructions
                </span>
                <p className="text-sm text-muted-foreground leading-6 whitespace-pre-wrap m-0">{task.instructions}</p>
              </div>

              <div className="flex flex-col gap-2" aria-label={`${task.name} recent runs`}>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Recent runs
                </span>
                {runs.length === 0 && (
                  <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>No runs yet.</span>
                )}
                {runs.map((run) => (
                  <RunItem key={run.id} task={task} run={run} onOpenSession={onOpenSession} />
                ))}
              </div>
            </div>

            <aside
              className="w-60 shrink-0 flex flex-col gap-5 [@media(max-width:1000px)]:w-full"
              aria-label={`${task.name} properties`}
            >
              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</span>
                <label className="inline-flex items-center gap-2 text-sm">
                  <Switch checked={task.enabled} onCheckedChange={(checked) => onToggle(task, checked)} />
                  {task.enabled ? 'Active' : 'Paused'}
                </label>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Schedule</span>
                <div className="flex flex-col gap-y-0.5 text-xs text-muted-foreground">
                  <span>{scheduleLabel(task.schedule)}</span>
                  {task.enabled && task.nextRunAt && <span>Next {formatTimestamp(task.nextRunAt)}</span>}
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Project</span>
                <div className="flex flex-col gap-y-0.5 text-xs text-muted-foreground">
                  <span>{project ?? 'No project'}</span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Sandbox</span>
                <div className="flex flex-col gap-y-0.5 text-xs text-muted-foreground">
                  <span>{sandbox}</span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Details</span>
                <div className="flex flex-col gap-y-0.5 text-xs text-muted-foreground">
                  <span>Created {formatTimestamp(task.createdAt)}</span>
                  {task.updatedAt !== task.createdAt && <span>Updated {formatTimestamp(task.updatedAt)}</span>}
                </div>
              </div>

              {(allowedToolNames.length > 0 || allowedMcpTools.length > 0) && (
                <div className="flex flex-col gap-1" aria-label={`${task.name} always allowed tools`}>
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Allowed tools
                  </span>
                  {allowedToolNames.map((toolName) => (
                    <div key={toolName} className="flex items-center justify-between gap-2">
                      <code className="font-mono text-xs">{toolName}</code>
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
                    <div
                      key={`${tool.serverLabel}\u0000${tool.toolName}`}
                      className="flex items-center justify-between gap-2"
                    >
                      <code className="font-mono text-xs">
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
  task: ScheduledTask;
  run: ScheduledTaskRun;
  onOpenSession: (task: ScheduledTask, run: ScheduledTaskRun) => Promise<void>;
};

const RunItem = memo(({ task, run, onOpenSession }: RunItemProps) => {
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
    <div className="flex flex-col gap-1 pt-2 pb-2">
      <div className="flex items-center flex-wrap gap-2">
        <Badge variant="secondary">{status.label}</Badge>
        <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>{formatRunTime(run)}</span>
        {run.sessionId && (
          <Button size="sm" variant="ghost" onClick={handleOpen}>
            <ExternalLink />
            Open session
          </Button>
        )}
      </div>
      {waiting && (
        <div className="flex items-center flex-wrap gap-2">
          <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
            {pendingToolLabel
              ? `Waiting on “${pendingToolLabel}” — approve it in the session.`
              : 'Waiting on a tool approval — approve it in the session.'}
          </span>
          {pendingToolLabel && (
            <Button size="sm" variant="ghost" onClick={handleAllow}>
              Always allow
            </Button>
          )}
        </div>
      )}
      {run.reason && <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>{run.reason}</span>}
    </div>
  );
});
RunItem.displayName = 'RunItem';

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

type RoutineFormProps = {
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
    <div className="grid gap-4">
      <Field>
        <FieldLabel>Name</FieldLabel>
        <Input
          value={value.name}
          onChange={(e) => setField('name', e.target.value)}
          placeholder="Morning code review"
        />
      </Field>
      <Field>
        <FieldLabel>Instructions</FieldLabel>
        <Textarea
          value={value.instructions}
          onChange={(e) => setField('instructions', e.target.value)}
          placeholder="Review yesterday's changes and summarize any risks."
          rows={4}
        />
      </Field>
      <Field>
        <FieldLabel>Project</FieldLabel>
        <Select value={value.projectId} onChange={(e) => setField('projectId', e.currentTarget.value)}>
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.label}
            </option>
          ))}
        </Select>
        <FieldDescription>Without a project, each run gets a fresh session workspace.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>Sandbox</FieldLabel>
        <div className="flex items-center justify-between gap-4">
          <SandboxPicker
            value={value.profileName}
            onChange={(profileName) => setField('profileName', profileName)}
            context={sandboxContext}
          />

          <span className="text-muted-foreground text-xs leading-5">
            {getProfileMenuLabel(value.profileName, machines)}
          </span>
        </div>
      </Field>
      <Field>
        <FieldLabel>Schedule</FieldLabel>
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
        <Field>
          <FieldLabel>Time</FieldLabel>
          <Input type="time" value={value.time} onChange={(e) => setField('time', e.target.value)} />
        </Field>
      )}
      {value.scheduleKind === 'weekly' && (
        <Field>
          <FieldLabel>Day</FieldLabel>
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
        <label className="inline-flex items-center gap-2 text-sm">
          <Switch checked={value.enabled} onCheckedChange={(checked) => setField('enabled', checked)} />
          {value.enabled ? 'Active' : 'Paused'}
        </label>
      )}
      <div className="text-muted-foreground text-xs leading-5">
        Runs ask before using tools. When a run is waiting on a specific tool, you can always-allow it for this routine
        from its run entry.
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-2 mt-2">
        <Button onClick={onSubmit} disabled={busy || !value.name.trim() || !value.instructions.trim()}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
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
