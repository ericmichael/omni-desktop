import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScheduledTaskManager } from '@/main/scheduled-task-manager';
import type { Project, ScheduledTask, StoreData } from '@/shared/types';

const now = 1_700_000_000_000;

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'routine-1',
    name: 'Routine',
    description: '',
    instructions: 'Do work',
    schedule: { kind: 'manual' },
    permissionMode: 'ask',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    allowedToolNames: [],
    allowedMcpTools: [],
    history: [],
    ...overrides,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    label: 'Project',
    slug: 'project',
    sources: [],
    createdAt: now,
    ...overrides,
  };
}

function createStore(storeData: Partial<StoreData>) {
  return {
    get: <Key extends keyof StoreData>(key: Key): StoreData[Key] => storeData[key] as StoreData[Key],
    set: <Key extends keyof StoreData>(key: Key, value: StoreData[Key]): void => {
      storeData[key] = value;
    },
  } as any;
}

describe('ScheduledTaskManager workspace resolution', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('launches project routines in the project local source directory', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'routine-project-'));
    let capturedWorkspaceDir: string | undefined;
    const storeData: Partial<StoreData> = {
      workspaceDir: join(tempDir, 'omni-root'),
      scheduledTasks: [createTask({ projectId: 'project-1' })],
    };
    const manager = new ScheduledTaskManager({
      store: createStore(storeData),
      processManager: {
        start: async (_processId: string, opts: { workspaceDir: string }) => {
          capturedWorkspaceDir = opts.workspaceDir;
          throw new Error('stop after capture');
        },
        stop: vi.fn(),
        getStatus: vi.fn(),
      } as any,
      getProjects: () => [
        createProject({
          sources: [{ kind: 'local', id: 'src-1', mountName: 'project', workspaceDir: join(tempDir!, 'project') }],
        }),
      ],
      now: () => now,
    });

    manager.runNow('routine-1');

    await vi.waitFor(() => expect(capturedWorkspaceDir).toBe(join(tempDir!, 'project')));
  });

  it('launches projectless routines in a per-session scratch workspace', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'routine-session-'));
    let capturedWorkspaceDir: string | undefined;
    const storeData: Partial<StoreData> = {
      workspaceDir: join(tempDir, 'omni-root'),
      scheduledTasks: [createTask()],
    };
    const manager = new ScheduledTaskManager({
      store: createStore(storeData),
      processManager: {
        start: async (_processId: string, opts: { workspaceDir: string }) => {
          capturedWorkspaceDir = opts.workspaceDir;
          throw new Error('stop after capture');
        },
        stop: vi.fn(),
        getStatus: vi.fn(),
      } as any,
      getProjects: () => [],
      now: () => now,
    });

    manager.runNow('routine-1');

    await vi.waitFor(() => {
      expect(capturedWorkspaceDir).toContain(join(tempDir!, 'omni-root', 'Sessions'));
    });
  });
});
