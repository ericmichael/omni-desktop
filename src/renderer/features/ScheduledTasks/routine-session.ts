import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CodeTab, ScheduledTask } from '@/shared/types';
import { firstSource } from '@/shared/types';

/**
 * Ensure a Code tab exists for a routine run, keyed by `sessionId`. Idempotent:
 * an existing tab is refreshed with the latest routine metadata. The tab is the
 * surface the routine's conversation streams into — it owns the omni-serve
 * session the agent runs in (see `RoutineBridge`).
 */
export async function ensureRoutineSessionTab(
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

export async function resolveRoutineWorkspaceDir(
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

export function formatSchedule(task: ScheduledTask): string {
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

export function formatDayOfWeek(dayOfWeek: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek] ?? 'Monday';
}
