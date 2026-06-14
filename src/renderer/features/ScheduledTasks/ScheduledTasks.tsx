import {
  Button,
  Card,
  Field,
  Input,
  makeStyles,
  mergeClasses,
  Select,
  Switch,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { useStore } from '@nanostores/react';
import type { ComponentProps } from 'react';
import { memo, useEffect, useMemo, useState } from 'react';

import { getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { SandboxPicker } from '@/renderer/features/SandboxProfile/SandboxPicker';
import { emitter } from '@/renderer/services/ipc';
import { $machines } from '@/renderer/services/machines';
import { scheduledTaskApi } from '@/renderer/services/scheduled-tasks';
import { persistedStoreApi } from '@/renderer/services/store';
import type {
  CodeTab,
  Project,
  ScheduledTask,
  ScheduledTaskAllowedMcpTool,
  ScheduledTaskInput,
  ScheduledTaskPermissionMode,
  ScheduledTaskRun,
  ScheduledTaskSchedule,
} from '@/shared/types';
import { firstSource } from '@/shared/types';

const useStyles = makeStyles({
  root: {
    height: '100%',
    overflow: 'auto',
    padding: '32px',
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '16px',
    alignItems: 'flex-start',
    marginBottom: '24px',
  },
  title: {
    fontSize: '28px',
    fontWeight: 700,
    margin: 0,
  },
  subtitle: {
    color: tokens.colorNeutralForeground3,
    marginTop: '6px',
    maxWidth: '720px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(260px, 360px) minmax(420px, 1fr)',
    gap: '20px',
    '@media (max-width: 900px)': {
      gridTemplateColumns: '1fr',
    },
  },
  form: {
    display: 'grid',
    gap: '14px',
  },
  cards: {
    display: 'grid',
    gap: '12px',
  },
  listCard: {
    padding: '12px',
  },
  listHeader: {
    alignItems: 'center',
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '10px',
  },
  listItem: {
    alignItems: 'flex-start',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    display: 'grid',
    gap: '4px',
    padding: '12px',
    textAlign: 'left',
    width: '100%',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  selectedListItem: {
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke1}`,
  },
  detailCard: {
    padding: '18px',
  },
  taskCard: {
    padding: '16px',
  },
  taskTop: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
  },
  taskName: {
    fontWeight: 650,
    fontSize: '16px',
  },
  muted: {
    color: tokens.colorNeutralForeground3,
    fontSize: '12px',
  },
  helperText: {
    color: tokens.colorNeutralForeground3,
    fontSize: '12px',
    lineHeight: '18px',
  },
  sandboxRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  },
  row: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginTop: '12px',
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    padding: '28px',
    textAlign: 'center',
  },
  runHistory: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'grid',
    gap: '8px',
    marginTop: '14px',
    paddingTop: '12px',
  },
  runHeading: {
    color: tokens.colorNeutralForeground2,
    fontSize: '12px',
    fontWeight: 650,
  },
  allowedTools: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'grid',
    gap: '8px',
    marginTop: '14px',
    paddingTop: '12px',
  },
  allowedToolItem: {
    alignItems: 'center',
    display: 'flex',
    gap: '8px',
    justifyContent: 'space-between',
  },
  section: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'grid',
    gap: '12px',
    marginTop: '16px',
    paddingTop: '14px',
  },
  runItem: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    display: 'grid',
    gap: '4px',
    padding: '8px',
  },
  approvalRunItem: {
    backgroundColor: tokens.colorPaletteYellowBackground1,
    border: `1px solid ${tokens.colorPaletteYellowBorder2}`,
  },
  runSummary: {
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
  },
  statusPill: {
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusCircular,
    color: tokens.colorNeutralForeground2,
    fontSize: '11px',
    fontWeight: 650,
    padding: '2px 8px',
  },
  approvalStatusPill: {
    backgroundColor: tokens.colorPaletteYellowBackground3,
    color: tokens.colorNeutralForegroundInverted,
  },
  runMeta: {
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
  },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
  },
});

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

export const ScheduledTasks = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const machines = useStore($machines);
  const [isEnterprise, setIsEnterprise] = useState(false);
  const [createForm, setCreateForm] = useState<RoutineFormState>(() => createEmptyFormState(store.defaultProfileName));
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [creating, setCreating] = useState(true);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RoutineFormState | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

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
  const selectedTask = useMemo(
    () => sorted.find((task) => task.id === selectedTaskId) ?? sorted[0] ?? null,
    [selectedTaskId, sorted]
  );

  useEffect(() => {
    if (creating || selectedTaskId || !selectedTask) {
      return;
    }
    setSelectedTaskId(selectedTask.id);
  }, [creating, selectedTask, selectedTaskId]);

  const createTask = async () => {
    setError(null);
    try {
      await scheduledTaskApi.create(toScheduledTaskInput(createForm));
      setCreateForm((current) => ({
        ...createEmptyFormState(store.defaultProfileName),
        projectId: current.projectId,
        profileName: current.profileName,
      }));
      setCreating(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startEdit = (task: ScheduledTask) => {
    setEditError(null);
    setCreating(false);
    setSelectedTaskId(task.id);
    setEditingTaskId(task.id);
    setEditForm(toFormState(task, store.defaultProfileName));
  };

  const cancelEdit = () => {
    setEditingTaskId(null);
    setEditForm(null);
    setEditError(null);
  };

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

  const openSession = async (task: ScheduledTask, run: ScheduledTaskRun) => {
    if (!run.sessionId) {
      return;
    }
    await ensureRoutineSessionTab(task, run.sessionId, store, true);
    await persistedStoreApi.setKey('layoutMode', 'spaces');
  };

  const allowTool = async (task: ScheduledTask, toolName: string) => {
    await scheduledTaskApi.allowTool(task.id, toolName);
  };

  const revokeTool = async (task: ScheduledTask, toolName: string) => {
    await scheduledTaskApi.revokeTool(task.id, toolName);
  };

  const allowMcpTool = async (task: ScheduledTask, tool: ScheduledTaskAllowedMcpTool) => {
    await scheduledTaskApi.allowMcpTool(task.id, tool);
  };

  const revokeMcpTool = async (task: ScheduledTask, tool: ScheduledTaskAllowedMcpTool) => {
    await scheduledTaskApi.revokeMcpTool(task.id, tool);
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Routines</h1>
          <div className={styles.subtitle}>
            Schedule local Omni sessions that run while Desktop is open. Use /loop for quick polling inside one session.
          </div>
        </div>
      </div>
      <div className={styles.grid}>
        <Card className={styles.listCard}>
          <div className={styles.listHeader}>
            <div className={styles.runHeading}>Routine index</div>
            <Button
              size="small"
              appearance={creating ? 'primary' : 'secondary'}
              onClick={() => {
                cancelEdit();
                setCreating(true);
              }}
            >
              New
            </Button>
          </div>
          <div className={styles.cards}>
            {sorted.length === 0 ? <div className={styles.empty}>No routines yet.</div> : null}
            {sorted.map((task) => (
              <button
                key={task.id}
                className={mergeClasses(
                  styles.listItem,
                  !creating && selectedTask?.id === task.id && styles.selectedListItem
                )}
                type="button"
                onClick={() => {
                  cancelEdit();
                  setCreating(false);
                  setSelectedTaskId(task.id);
                }}
              >
                <span className={styles.taskName}>{task.name}</span>
                <span className={styles.muted}>{formatSchedule(task)}</span>
                <span className={styles.muted}>{formatProject(task, store.projects)}</span>
                <span className={styles.muted}>{task.history[0] ? lastRunLabel(task.history[0]) : 'Never run'}</span>
              </button>
            ))}
          </div>
        </Card>
        <Card className={styles.detailCard}>
          {creating ? (
            <>
              <div className={styles.runHeading}>Create routine</div>
              <RoutineForm
                styles={styles}
                value={createForm}
                projects={store.projects}
                sandboxContext={{ isEnterprise, available: store.availableSandboxProfiles, machines }}
                machines={machines}
                submitLabel="Create routine"
                error={error}
                onChange={setCreateForm}
                onSubmit={() => void createTask()}
              />
            </>
          ) : selectedTask ? (
            <RoutineDetail
              styles={styles}
              task={selectedTask}
              projects={store.projects}
              machines={machines}
              isEditing={editingTaskId === selectedTask.id && Boolean(editForm)}
              editForm={editForm}
              editError={editError}
              saving={savingTaskId === selectedTask.id}
              busy={busyTaskId === selectedTask.id}
              sandboxContext={{ isEnterprise, available: store.availableSandboxProfiles, machines }}
              onRunNow={runNow}
              onStartEdit={startEdit}
              onDelete={async (task) => {
                await scheduledTaskApi.delete(task.id);
                setSelectedTaskId(null);
                setCreating(sorted.length <= 1);
              }}
              onToggle={(task, enabled) => scheduledTaskApi.update(task.id, { enabled })}
              onEditChange={setEditForm}
              onSaveEdit={saveEdit}
              onCancelEdit={cancelEdit}
              onOpenSession={openSession}
              onAllowTool={allowTool}
              onAllowMcpTool={allowMcpTool}
              onRevokeTool={revokeTool}
              onRevokeMcpTool={revokeMcpTool}
            />
          ) : (
            <div className={styles.empty}>Select or create a routine.</div>
          )}
        </Card>
      </div>
    </div>
  );
});

ScheduledTasks.displayName = 'ScheduledTasks';

export const RoutineSessionWatcher = memo(() => {
  const store = useStore(persistedStoreApi.$atom);

  useEffect(() => {
    for (const task of store.scheduledTasks ?? []) {
      if (!task.runningSessionId) {
        continue;
      }
      void ensureRoutineSessionTab(task, task.runningSessionId, store);
    }
  }, [store]);

  return null;
});

RoutineSessionWatcher.displayName = 'RoutineSessionWatcher';

type RoutineDetailProps = {
  styles: ReturnType<typeof useStyles>;
  task: ScheduledTask;
  projects: Project[];
  machines: Parameters<typeof getProfileMenuLabel>[1];
  sandboxContext: ComponentProps<typeof SandboxPicker>['context'];
  isEditing: boolean;
  editForm: RoutineFormState | null;
  editError: string | null;
  saving: boolean;
  busy: boolean;
  onRunNow: (task: ScheduledTask) => Promise<void>;
  onStartEdit: (task: ScheduledTask) => void;
  onDelete: (task: ScheduledTask) => Promise<void>;
  onToggle: (task: ScheduledTask, enabled: boolean) => Promise<ScheduledTask>;
  onEditChange: (value: RoutineFormState) => void;
  onSaveEdit: (task: ScheduledTask) => Promise<void>;
  onCancelEdit: () => void;
  onOpenSession: (task: ScheduledTask, run: ScheduledTaskRun) => Promise<void>;
  onAllowTool: (task: ScheduledTask, toolName: string) => Promise<void>;
  onAllowMcpTool: (task: ScheduledTask, tool: ScheduledTaskAllowedMcpTool) => Promise<void>;
  onRevokeTool: (task: ScheduledTask, toolName: string) => Promise<void>;
  onRevokeMcpTool: (task: ScheduledTask, tool: ScheduledTaskAllowedMcpTool) => Promise<void>;
};

const RoutineDetail = ({
  styles,
  task,
  projects,
  machines,
  sandboxContext,
  isEditing,
  editForm,
  editError,
  saving,
  busy,
  onRunNow,
  onStartEdit,
  onDelete,
  onToggle,
  onEditChange,
  onSaveEdit,
  onCancelEdit,
  onOpenSession,
  onAllowTool,
  onAllowMcpTool,
  onRevokeTool,
  onRevokeMcpTool,
}: RoutineDetailProps) => (
  <div>
    <div className={styles.taskTop}>
      <div>
        <div className={styles.taskName}>{task.name}</div>
        <div className={styles.muted}>{formatSchedule(task)}</div>
        <div className={styles.muted}>{formatProject(task, projects)}</div>
        <div className={styles.muted}>
          {task.profileName ? getProfileMenuLabel(task.profileName, machines) : 'Default sandbox'}
        </div>
      </div>
      <Switch
        checked={task.enabled}
        label={task.enabled ? 'Active' : 'Paused'}
        onChange={(_, data) => void onToggle(task, data.checked)}
      />
    </div>
    <div className={styles.row}>
      <Button size="small" onClick={() => void onRunNow(task)} disabled={busy}>
        Run now
      </Button>
      <Button size="small" appearance="secondary" onClick={() => onStartEdit(task)}>
        Edit
      </Button>
      <Button size="small" appearance="secondary" onClick={() => void onDelete(task)}>
        Delete
      </Button>
    </div>
    {isEditing && editForm ? (
      <div className={styles.section} aria-label={`Edit ${task.name}`}>
        <div className={styles.runHeading}>Edit routine</div>
        <RoutineForm
          styles={styles}
          value={editForm}
          projects={projects}
          sandboxContext={sandboxContext}
          machines={machines}
          submitLabel="Save changes"
          error={editError}
          showEnabled
          busy={saving}
          onChange={onEditChange}
          onSubmit={() => void onSaveEdit(task)}
          onCancel={onCancelEdit}
        />
      </div>
    ) : null}
    <AllowedToolsPanel styles={styles} task={task} onRevokeTool={onRevokeTool} onRevokeMcpTool={onRevokeMcpTool} />
    <RunHistory
      styles={styles}
      task={task}
      onOpenSession={onOpenSession}
      onAllowTool={onAllowTool}
      onAllowMcpTool={onAllowMcpTool}
    />
  </div>
);

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
  const selectedProject = projects.find((project) => project.id === value.projectId);
  const setField = <K extends keyof RoutineFormState>(field: K, fieldValue: RoutineFormState[K]) => {
    onChange({ ...value, [field]: fieldValue });
  };

  return (
    <div className={styles.form}>
      <Field label="Name">
        <Input
          value={value.name}
          onChange={(_, data) => setField('name', data.value)}
          placeholder="Morning code review"
        />
      </Field>
      <Field label="Instructions">
        <Textarea
          value={value.instructions}
          onChange={(_, data) => setField('instructions', data.value)}
          placeholder="Review yesterday's changes and summarize any risks."
          resize="vertical"
        />
      </Field>
      <Field label="Project">
        <Select value={value.projectId} onChange={(event) => setField('projectId', event.currentTarget.value)}>
          <option value="">No project · new session workspace</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.label}
            </option>
          ))}
        </Select>
      </Field>
      {!selectedProject ? (
        <div className={styles.helperText}>
          No project selected. Omni creates a fresh session workspace when this routine runs.
        </div>
      ) : null}
      <Field label="Sandbox profile">
        <div className={styles.sandboxRow}>
          <SandboxPicker
            value={value.profileName}
            onChange={(profileName) => setField('profileName', profileName)}
            context={sandboxContext}
          />
          <span className={styles.muted}>{getProfileMenuLabel(value.profileName, machines)}</span>
        </div>
      </Field>
      <Field label="Approvals">
        <Select
          value={value.permissionMode}
          onChange={(event) => setField('permissionMode', event.currentTarget.value as ScheduledTaskPermissionMode)}
        >
          <option value="ask">Ask when required</option>
        </Select>
      </Field>
      <div className={styles.helperText}>
        Uses the agent&apos;s built-in safe tools. Function tools can be always allowed by tool name; MCP tools can be
        always allowed only for a specific server and tool pair.
      </div>
      <Field label="Schedule">
        <Select
          value={value.scheduleKind}
          onChange={(event) => setField('scheduleKind', event.currentTarget.value as ScheduleKind)}
        >
          <option value="manual">Manual</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Weekly</option>
        </Select>
      </Field>
      {value.scheduleKind !== 'manual' && value.scheduleKind !== 'hourly' ? (
        <Field label="Time">
          <Input type="time" value={value.time} onChange={(_, data) => setField('time', data.value)} />
        </Field>
      ) : null}
      {value.scheduleKind === 'weekly' ? (
        <Field label="Day">
          <Select value={value.dayOfWeek} onChange={(event) => setField('dayOfWeek', event.currentTarget.value)}>
            <option value="1">Monday</option>
            <option value="2">Tuesday</option>
            <option value="3">Wednesday</option>
            <option value="4">Thursday</option>
            <option value="5">Friday</option>
            <option value="6">Saturday</option>
            <option value="0">Sunday</option>
          </Select>
        </Field>
      ) : null}
      {showEnabled ? (
        <Switch
          checked={value.enabled}
          label={value.enabled ? 'Active' : 'Paused'}
          onChange={(_, data) => setField('enabled', data.checked)}
        />
      ) : null}
      {error ? <div className={styles.muted}>{error}</div> : null}
      <div className={styles.row}>
        <Button
          appearance="primary"
          onClick={onSubmit}
          disabled={busy || !value.name.trim() || !value.instructions.trim()}
        >
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button appearance="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
};

type RunHistoryProps = {
  styles: ReturnType<typeof useStyles>;
  task: ScheduledTask;
  onOpenSession: (task: ScheduledTask, run: ScheduledTaskRun) => Promise<void>;
  onAllowTool: (task: ScheduledTask, toolName: string) => Promise<void>;
  onAllowMcpTool: (task: ScheduledTask, tool: ScheduledTaskAllowedMcpTool) => Promise<void>;
};

const RunHistory = ({ styles, task, onOpenSession, onAllowTool, onAllowMcpTool }: RunHistoryProps) => (
  <div className={styles.runHistory} aria-label={`${task.name} recent runs`}>
    <div className={styles.runHeading}>Recent runs</div>
    {(task.history ?? []).length === 0 ? <div className={styles.muted}>No runs yet.</div> : null}
    {(task.history ?? []).slice(0, 5).map((run) => (
      <div key={run.id} className={mergeClasses(styles.runItem, isWaitingForApproval(run) && styles.approvalRunItem)}>
        <div className={styles.runSummary}>
          <span className={mergeClasses(styles.statusPill, isWaitingForApproval(run) && styles.approvalStatusPill)}>
            Status: {formatRunStatus(run.status)}
          </span>
          <span className={styles.muted}>{formatRunTime(run)}</span>
        </div>
        {isWaitingForApproval(run) ? (
          <div className={styles.helperText}>
            {run.pendingApprovalKind === 'mcp'
              ? run.pendingApprovalServerLabel && run.pendingApprovalToolName
                ? `Waiting on MCP tool “${run.pendingApprovalServerLabel} / ${run.pendingApprovalToolName}”. You can always allow this exact server and tool pair for future runs; approve the current request in the session.`
                : 'Waiting on an MCP approval. Approve the current request in the session.'
              : run.pendingApprovalToolName
                ? `Waiting on function tool “${run.pendingApprovalToolName}”. You can always allow it for future runs; approve the current request in the session.`
                : 'Waiting on a function tool approval. Approve the current request in the session.'}
          </div>
        ) : null}
        {run.reason ? <div className={styles.muted}>Reason: {run.reason}</div> : null}
        <div className={styles.runMeta}>
          {run.sessionId ? (
            <span className={styles.muted}>
              Session: <code className={styles.mono}>{shortId(run.sessionId)}</code>
            </span>
          ) : null}
          {run.runId ? (
            <span className={styles.muted}>
              Run: <code className={styles.mono}>{shortId(run.runId)}</code>
            </span>
          ) : null}
          {run.sessionId ? (
            <Button size="small" appearance="subtle" onClick={() => void onOpenSession(task, run)}>
              Open session
            </Button>
          ) : null}
          {isWaitingForApproval(run) && run.pendingApprovalKind !== 'mcp' && run.pendingApprovalToolName ? (
            <Button
              size="small"
              appearance="subtle"
              onClick={() => void onAllowTool(task, run.pendingApprovalToolName!)}
            >
              Always allow for this routine
            </Button>
          ) : null}
          {isWaitingForApproval(run) &&
          run.pendingApprovalKind === 'mcp' &&
          run.pendingApprovalServerLabel &&
          run.pendingApprovalToolName ? (
            <Button
              size="small"
              appearance="subtle"
              onClick={() =>
                void onAllowMcpTool(task, {
                  serverLabel: run.pendingApprovalServerLabel!,
                  toolName: run.pendingApprovalToolName!,
                })
              }
            >
              Always allow this MCP tool for this routine
            </Button>
          ) : null}
        </div>
      </div>
    ))}
  </div>
);

type AllowedToolsPanelProps = {
  styles: ReturnType<typeof useStyles>;
  task: ScheduledTask;
  onRevokeTool: (task: ScheduledTask, toolName: string) => Promise<void>;
  onRevokeMcpTool: (task: ScheduledTask, tool: ScheduledTaskAllowedMcpTool) => Promise<void>;
};

const AllowedToolsPanel = ({ styles, task, onRevokeTool, onRevokeMcpTool }: AllowedToolsPanelProps) => {
  const allowedToolNames = task.allowedToolNames ?? [];
  const allowedMcpTools = task.allowedMcpTools ?? [];
  return (
    <>
      <div className={styles.allowedTools} aria-label={`${task.name} always allowed function tools`}>
        <div className={styles.runHeading}>Always allowed function tools</div>
        {allowedToolNames.length === 0 ? (
          <div className={styles.muted}>No function tools are always allowed for this routine.</div>
        ) : null}
        {allowedToolNames.map((toolName) => (
          <div key={toolName} className={styles.allowedToolItem}>
            <code className={styles.mono}>{toolName}</code>
            <Button size="small" appearance="subtle" onClick={() => void onRevokeTool(task, toolName)}>
              Revoke
            </Button>
          </div>
        ))}
      </div>
      <div className={styles.allowedTools} aria-label={`${task.name} always allowed MCP tools`}>
        <div className={styles.runHeading}>Always allowed MCP tools</div>
        <div className={styles.helperText}>MCP approvals are scoped to the exact server label and tool name.</div>
        {allowedMcpTools.length === 0 ? (
          <div className={styles.muted}>No MCP server and tool pairs are always allowed for this routine.</div>
        ) : null}
        {allowedMcpTools.map((tool) => (
          <div key={`${tool.serverLabel}\u0000${tool.toolName}`} className={styles.allowedToolItem}>
            <code className={styles.mono}>
              {tool.serverLabel} / {tool.toolName}
            </code>
            <Button size="small" appearance="subtle" onClick={() => void onRevokeMcpTool(task, tool)}>
              Revoke
            </Button>
          </div>
        ))}
      </div>
    </>
  );
};

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

function formatSchedule(task: ScheduledTask): string {
  if (!task.enabled) {
    return 'Paused';
  }
  const next = task.nextRunAt ? ` · next ${new Date(task.nextRunAt).toLocaleString()}` : '';
  const schedule = task.schedule;
  if (schedule.kind === 'manual') {
    return 'Manual';
  }
  if (schedule.kind === 'interval') {
    return `Every ${schedule.everyMinutes} minutes${next}`;
  }
  if (schedule.kind === 'daily') {
    return `${schedule.weekdaysOnly ? 'Weekdays' : 'Daily'} at ${schedule.time}${next}`;
  }
  return `Weekly on ${formatDayOfWeek(schedule.dayOfWeek)} at ${schedule.time}${next}`;
}

function formatDayOfWeek(dayOfWeek: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek] ?? 'Monday';
}

function formatProject(task: ScheduledTask, projects: Project[]): string {
  if (!task.projectId) {
    return 'No project';
  }
  return projects.find((project) => project.id === task.projectId)?.label ?? 'Unknown project';
}

async function ensureRoutineSessionTab(
  task: ScheduledTask,
  sessionId: string,
  store: ReturnType<typeof persistedStoreApi.get>,
  activate = false
): Promise<CodeTab> {
  const tabs = persistedStoreApi.getKey('codeTabs') ?? [];
  const existing = tabs.find((tab) => tab.sessionId === sessionId);
  if (existing) {
    const nextExisting = {
      ...existing,
      routineId: task.id,
      routineName: task.name,
      routineSchedule: formatSchedule(task),
    };
    if (
      existing.routineId !== nextExisting.routineId ||
      existing.routineName !== nextExisting.routineName ||
      existing.routineSchedule !== nextExisting.routineSchedule
    ) {
      await persistedStoreApi.setKey(
        'codeTabs',
        tabs.map((tab) => (tab.id === existing.id ? nextExisting : tab))
      );
    }
    if (activate) {
      await persistedStoreApi.setKey('activeCodeTabId', existing.id);
    }
    return nextExisting;
  }
  const workspaceDir = await resolveRoutineWorkspaceDir(task, sessionId, store);
  const tab: CodeTab = {
    id: `routine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    projectId: task.projectId ?? null,
    sessionId,
    routineId: task.id,
    routineName: task.name,
    routineSchedule: formatSchedule(task),
    profileName: task.profileName ?? store.defaultProfileName ?? 'host',
    profileNameExplicit: Boolean(task.profileName),
    createdAt: Date.now(),
    ...(workspaceDir ? { workspaceDir } : {}),
  };
  await persistedStoreApi.setKey('codeTabs', [...tabs, tab]);
  if (activate) {
    await persistedStoreApi.setKey('activeCodeTabId', tab.id);
  }
  return tab;
}

async function resolveRoutineWorkspaceDir(
  task: ScheduledTask,
  sessionId: string,
  store: ReturnType<typeof persistedStoreApi.get>
): Promise<string | undefined> {
  if (task.projectId) {
    const project = store.projects.find((item) => item.id === task.projectId);
    const source = firstSource(project);
    if (source?.kind === 'local') {
      return source.workspaceDir;
    }
    if (store.workspaceDir && project) {
      return `${store.workspaceDir.replace(/[/\\]+$/, '')}/Projects/${project.slug}`;
    }
    return undefined;
  }
  if (!store.workspaceDir) {
    return undefined;
  }
  try {
    return await emitter.invoke('util:session-workspace-dir', store.workspaceDir, sessionId);
  } catch {
    return undefined;
  }
}

function lastRunLabel(run: ScheduledTask['history'][number]): string {
  return `Last ${formatRunStatus(run.status)} ${new Date(run.startedAt).toLocaleString()}`;
}

function formatRunStatus(status: ScheduledTaskRun['status']): string {
  if (status === 'waiting_for_approval') {
    return 'Waiting for approval';
  }
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function isWaitingForApproval(run: ScheduledTaskRun): boolean {
  return run.status === 'waiting_for_approval';
}

function formatRunTime(run: ScheduledTaskRun): string {
  const started = new Date(run.startedAt).toLocaleString();
  if (!run.completedAt) {
    return `Started ${started}`;
  }
  return `Started ${started} · Completed ${new Date(run.completedAt).toLocaleString()}`;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}
