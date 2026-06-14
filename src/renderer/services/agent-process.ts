import { objectEquals } from '@observ33r/object-equals';
import { Terminal } from '@xterm/xterm';
import { map } from 'nanostores';

import { DEFAULT_XTERM_OPTIONS } from '@/renderer/constants';
import { emitter, ipc } from '@/renderer/services/ipc';
import type {
  AgentProcessStartOptions,
  AgentProcessStatus,
  SandboxPauseResult,
  SandboxSwitchResult,
  WithTimestamp,
} from '@/shared/types';

/** Statuses for all agent processes, keyed by processId. */
export const $agentStatuses = map<Record<string, WithTimestamp<AgentProcessStatus>>>({});

/** Terminal instances for all agent processes, keyed by processId. */
export const $agentXTerms = map<Record<string, Terminal>>({});

const xtermSubscriptions = new Map<string, Set<() => void>>();

export const initializeTerminal = (processId: string): Terminal => {
  const existing = $agentXTerms.get()[processId];
  if (existing) {
    return existing;
  }

  const xterm = new Terminal({ ...DEFAULT_XTERM_OPTIONS, disableStdin: true });
  const subs = new Set<() => void>();

  subs.add(
    ipc.on('agent-process:raw-output', (id, data) => {
      if (id === processId) {
        xterm.write(data);
      }
    })
  );

  subs.add(
    xterm.onResize(({ cols, rows }) => {
      emitter.invoke('agent-process:resize', processId, cols, rows);
    }).dispose
  );

  xtermSubscriptions.set(processId, subs);
  $agentXTerms.setKey(processId, xterm);
  return xterm;
};

export const teardownTerminal = (processId: string): void => {
  const subs = xtermSubscriptions.get(processId);
  if (subs) {
    for (const unsub of subs) {
      unsub();
    }
    subs.clear();
    xtermSubscriptions.delete(processId);
  }

  const xterm = $agentXTerms.get()[processId];
  if (xterm) {
    xterm.dispose();
    const next = { ...$agentXTerms.get() };
    delete next[processId];
    $agentXTerms.set(next);
  }
};

export const agentProcessApi = {
  start: (processId: string, arg: AgentProcessStartOptions) => {
    initializeTerminal(processId);
    emitter.invoke('agent-process:start', processId, arg);
  },

  stop: async (processId: string) => {
    await emitter.invoke('agent-process:stop', processId);
    teardownTerminal(processId);
  },

  rebuild: (processId: string, arg: AgentProcessStartOptions) => {
    initializeTerminal(processId);
    emitter.invoke('agent-process:rebuild', processId, arg);
  },

  pause: (processId: string): Promise<SandboxPauseResult> => {
    return emitter.invoke('agent-process:pause', processId);
  },

  unpause: (processId: string): Promise<SandboxPauseResult> => {
    return emitter.invoke('agent-process:unpause', processId);
  },

  switchSandbox: (processId: string, profileName: string): Promise<SandboxSwitchResult> => {
    return emitter.invoke('agent-process:switch-sandbox', processId, profileName);
  },

  notifyActivity: (processId: string): void => {
    void emitter.invoke('agent-process:notify-activity', processId);
  },

  getStatus: (processId: string): WithTimestamp<AgentProcessStatus> => {
    return $agentStatuses.get()[processId] ?? { type: 'uninitialized', timestamp: Date.now() };
  },
};

/** Clear stale status for a process (prevents spurious events from prior runs). */
export const clearStatus = (processId: string): void => {
  const statuses = { ...$agentStatuses.get() };
  delete statuses[processId];
  $agentStatuses.set(statuses);
};

const listen = () => {
  // Log raw output to console in dev mode for debugging
  if (import.meta.env.MODE === 'development') {
    ipc.on('agent-process:raw-output', (processId, data) => {
      // eslint-disable-next-line no-control-regex -- Strips ANSI escape sequences from process output.
      const line = data.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (line) {
        console.debug(`[agent:${processId}]`, line);
      }
    });
  }

  // Push events for real-time updates
  ipc.on('agent-process:status', (processId, status) => {
    $agentStatuses.setKey(processId, status);
    if (status.type === 'exited') {
      teardownTerminal(processId);
    }
  });

  // Polling fallback is handled by Code/state.ts, which iterates the
  // ``codeTabs`` list — the reserved chat record included (chat unification).
};

listen();

/** Poll status for a specific processId. Exported for Code/state.ts to call for its tabs. */
export const pollProcessStatus = async (processId: string): Promise<void> => {
  const current = $agentStatuses.get()[processId];
  if (current?.type === 'running') {
    return;
  }
  try {
    const status = await emitter.invoke('agent-process:get-status', processId);
    if (!status || status.type === 'uninitialized') {
      return;
    }
    const old = $agentStatuses.get()[processId];
    if (!objectEquals(old, status)) {
      $agentStatuses.setKey(processId, status);
    }
  } catch {
    // ignore
  }
};
