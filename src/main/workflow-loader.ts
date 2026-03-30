/**
 * Loads and watches FLEET.md workflow files per project.
 *
 * Inspired by Symphony's dynamic WORKFLOW.md reload:
 * - Watches for file changes and re-applies config without restart
 * - Invalid reloads keep the last known good config
 * - Provides merged config (workflow overrides → defaults)
 */
import type { FSWatcher } from 'fs';
import { watch } from 'fs';
import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

import type { Workflow, WorkflowConfig } from '@/lib/workflow';
import { parseWorkflow } from '@/lib/workflow';
import type { ProjectId } from '@/shared/types';

const FLEET_WORKFLOW_FILENAME = 'FLEET.md';
const DEBOUNCE_MS = 500;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

type WatcherEntry = {
  watcher: FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  workflow: Workflow;
  workspaceDir: string;
};

export class WorkflowLoader {
  private entries = new Map<ProjectId, WatcherEntry>();
  private onChange?: (projectId: ProjectId, workflow: Workflow) => void;

  constructor(opts?: { onChange?: (projectId: ProjectId, workflow: Workflow) => void }) {
    this.onChange = opts?.onChange;
  }

  /**
   * Load FLEET.md for a project. If the file exists, parses it and starts watching.
   * If it doesn't exist, returns empty defaults and watches for creation.
   */
  async load(projectId: ProjectId, workspaceDir: string): Promise<Workflow> {
    // Stop existing watcher if any
    this.unload(projectId);

    const filePath = path.join(workspaceDir, FLEET_WORKFLOW_FILENAME);
    let workflow: Workflow;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      workflow = parseWorkflow(content);
      console.log(`[WorkflowLoader] Loaded ${filePath} for project ${projectId}`);
    } catch {
      // File doesn't exist — use empty defaults
      workflow = { config: {}, promptTemplate: '' };
    }

    const entry: WatcherEntry = {
      watcher: null,
      debounceTimer: null,
      workflow,
      workspaceDir,
    };

    this.entries.set(projectId, entry);

    // Start watching
    this.startWatching(projectId, entry, filePath);

    return workflow;
  }

  /** Get the current workflow for a project (from cache, no I/O). */
  get(projectId: ProjectId): Workflow | null {
    return this.entries.get(projectId)?.workflow ?? null;
  }

  /** Get a specific config value with fallback. */
  getConfig(projectId: ProjectId): WorkflowConfig {
    return this.entries.get(projectId)?.workflow.config ?? {};
  }

  /** Get the custom prompt template, or empty string if none. */
  getPromptTemplate(projectId: ProjectId): string {
    return this.entries.get(projectId)?.workflow.promptTemplate ?? '';
  }

  /** Stop watching a project's workflow file. */
  unload(projectId: ProjectId): void {
    const entry = this.entries.get(projectId);
    if (!entry) {
      return;
    }

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    if (entry.watcher) {
      entry.watcher.close();
    }
    this.entries.delete(projectId);
  }

  /** Clean up all watchers. */
  dispose(): void {
    for (const [projectId] of this.entries) {
      this.unload(projectId);
    }
  }

  /**
   * Execute a hook script in the project workspace directory.
   * Returns true if the hook succeeded, false if it failed or timed out.
   */
  async runHook(
    projectId: ProjectId,
    hookName: 'after_create' | 'before_run' | 'after_run' | 'before_remove',
    workspaceDir: string
  ): Promise<boolean> {
    const config = this.getConfig(projectId);
    const script = config.hooks?.[hookName];

    if (!script) {
      return true; // No hook configured — success
    }

    const timeoutMs = config.hooks?.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS;

    console.log(`[WorkflowLoader] Running ${hookName} hook for project ${projectId}`);

    return new Promise((resolve) => {
      const child = exec(script, {
        cwd: workspaceDir,
        timeout: timeoutMs,
        shell: '/bin/bash',
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          console.log(`[WorkflowLoader] ${hookName} hook completed successfully for project ${projectId}`);
          resolve(true);
        } else {
          const truncatedStderr = stderr.slice(0, 500);
          console.warn(
            `[WorkflowLoader] ${hookName} hook failed for project ${projectId} (exit code ${code}): ${truncatedStderr}`
          );
          resolve(false);
        }
      });

      child.on('error', (err) => {
        console.warn(`[WorkflowLoader] ${hookName} hook error for project ${projectId}: ${err.message}`);
        resolve(false);
      });
    });
  }

  // --- Private ---

  private startWatching(projectId: ProjectId, entry: WatcherEntry, filePath: string): void {
    const dir = path.dirname(filePath);
    const filename = path.basename(filePath);

    // Watch the directory so we catch file creation too
    try {
      const watcher = watch(dir, { persistent: false }, (_eventType, changedFile) => {
        // Only react to changes to FLEET.md itself
        if (changedFile && changedFile !== filename) {
          return;
        }

        // Debounce
        if (entry.debounceTimer) {
          clearTimeout(entry.debounceTimer);
        }

        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = null;
          void this.reload(projectId, filePath, entry);
        }, DEBOUNCE_MS);
      });

      watcher.on('error', () => {
        // Silently ignore watch errors
      });

      entry.watcher = watcher;
    } catch {
      // Can't watch — that's okay, config will just be static
    }
  }

  private async reload(projectId: ProjectId, filePath: string, entry: WatcherEntry): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const workflow = parseWorkflow(content);
      entry.workflow = workflow;
      console.log(`[WorkflowLoader] Reloaded ${filePath} for project ${projectId}`);
      this.onChange?.(projectId, workflow);
    } catch {
      // File was deleted or unreadable — keep last known good config
      console.warn(`[WorkflowLoader] Failed to reload ${filePath} — keeping last config`);
    }
  }
}
