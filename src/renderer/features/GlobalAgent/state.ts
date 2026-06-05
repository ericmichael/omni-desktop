/**
 * Headless global-orchestrator session state.
 *
 * The global agent is a normal agent process keyed `"global"` (alongside
 * `"chat"` and the per-column CodeTabIds), booted on the Devbox profile and
 * voice-first. It owns no column; it observes and drives the whole Tile
 * workspace through the superuser client-tool handler.
 *
 * Its session id + container id are renderer-local (not part of the synced
 * store model), so we persist them in localStorage rather than the store
 * schema.
 */
import { atom, computed } from 'nanostores';

import { uuidv4 } from '@/lib/uuid';
import { $agentStatuses } from '@/renderer/services/agent-process';
import type { AgentProcessStatus, WithTimestamp } from '@/shared/types';

export const GLOBAL_PROCESS_ID = 'global';

/** Sandbox profile the orchestrator runs on — a full Devbox so it has real tools. */
export const GLOBAL_AGENT_PROFILE = 'devbox';

const SESSION_KEY = 'omni.globalAgent.sessionId';
const CONTAINER_KEY = 'omni.globalAgent.containerId';

/** Stable conversation/session id for the orchestrator (minted once, persisted). */
export function getGlobalSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing) {
      return existing;
    }
    const fresh = uuidv4();
    localStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    return uuidv4();
  }
}

/** Persist the orchestrator's current session id so it resumes on next launch. */
export function setGlobalSessionId(id: string | undefined): void {
  try {
    if (id) {
      localStorage.setItem(SESSION_KEY, id);
    }
  } catch {
    /* ignore */
  }
}

/** Last container id, for warm reattach. Null when none stored. */
export function getGlobalContainerId(): string | null {
  try {
    return localStorage.getItem(CONTAINER_KEY);
  } catch {
    return null;
  }
}

export function setGlobalContainerId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(CONTAINER_KEY, id);
    } else {
      localStorage.removeItem(CONTAINER_KEY);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Whether the orchestrator is *mounted* — its session is live (booting/running)
 * and its mic is registered, even when the panel isn't visible. Set on first
 * open OR on first background voice activation; stays true so the session
 * persists. Distinct from `$globalAgentOpen` (panel visibility).
 */
export const $globalAgentActive = atom<boolean>(false);

/** Whether the orchestrator panel is *visible* (slid out). */
export const $globalAgentOpen = atom<boolean>(false);

/** Mount/keep the orchestrator alive in the background without showing the panel. */
export function activateGlobalAgent(): void {
  if (!$globalAgentActive.get()) {
    $globalAgentActive.set(true);
  }
}

/** Toggle panel visibility. Opening also mounts it. */
export function toggleGlobalAgent(): void {
  const next = !$globalAgentOpen.get();
  if (next) {
    activateGlobalAgent();
  }
  $globalAgentOpen.set(next);
}

/** Global process status — derived view into the shared agent statuses map. */
export const $globalProcessStatus = computed(
  $agentStatuses,
  (statuses): WithTimestamp<AgentProcessStatus> =>
    statuses[GLOBAL_PROCESS_ID] ?? { type: 'uninitialized', timestamp: 0 }
);
