/**
 * Renderer-side routine bridge.
 *
 * Mirrors `supervisor-bridge.ts` but for Routines (scheduled tasks). Main asks
 * the renderer to ensure a Code column exists for a routine run (creating the
 * tab on demand) and to start a single run on that column's live session. The
 * run therefore streams into the visible UI exactly like a user-driven session,
 * and tool approvals surface in the column UI. A narrow set of run/approval
 * events is forwarded back to main so it can drive routine history / status /
 * toasts.
 *
 * No session id or tool-call routing lives here — the column owns both.
 */

import { ensureRoutineSessionTab } from '@/renderer/features/ScheduledTasks/routine-session';
import { emitter, ipc } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { RoutineBridgeEvent, RoutineBridgeRequest, RunOverrides } from '@/shared/types';

export type RoutineActor = {
  taskId: string;
  /**
   * Start a single run on the column's session through the same handleSubmit
   * path the user's keyboard uses. `safeToolOverrides` carries the routine's
   * always-allow list. Resolves with the runId once `start_run` is acked.
   */
  startRun: (prompt: string, safeToolOverrides?: RunOverrides['safeToolOverrides']) => Promise<{ runId: string }>;
  /** Stop any in-flight run on the column's session. */
  stop: () => Promise<void>;
};

const actors = new Map<string, RoutineActor>();
const waiters = new Map<string, Array<(a: RoutineActor) => void>>();

/** Register a routine column actor. Returns an unregister fn. */
export function registerRoutineActor(actor: RoutineActor): () => void {
  actors.set(actor.taskId, actor);
  const resolvers = waiters.get(actor.taskId);
  if (resolvers) {
    for (const r of resolvers) {
      r(actor);
    }
    waiters.delete(actor.taskId);
  }
  return () => {
    queueMicrotask(() => {
      if (actors.get(actor.taskId) === actor) {
        actors.delete(actor.taskId);
        void forwardRoutineEvent({ kind: 'disconnected', taskId: actor.taskId });
      }
    });
  };
}

function awaitActor(taskId: string, timeoutMs: number): Promise<RoutineActor> {
  const existing = actors.get(taskId);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const list = waiters.get(taskId) ?? [];
    waiters.set(taskId, list);
    const onResolve = (a: RoutineActor): void => {
      clearTimeout(timer);
      resolve(a);
    };
    list.push(onResolve);
    const timer = setTimeout(() => {
      const curr = waiters.get(taskId);
      if (curr) {
        const idx = curr.indexOf(onResolve);
        if (idx >= 0) {
          curr.splice(idx, 1);
        }
      }
      reject(new Error(`Timed out waiting for routine actor: ${taskId}`));
    }, timeoutMs);
  });
}

export async function forwardRoutineEvent(event: RoutineBridgeEvent): Promise<void> {
  try {
    await emitter.invoke('routine:event', event);
  } catch {
    /* server may be mid-reconnect; best-effort */
  }
}

async function ensureColumn(request: Extract<RoutineBridgeRequest, { kind: 'ensure-column' }>): Promise<void> {
  const store = persistedStoreApi.$atom.get();
  const task = (store.scheduledTasks ?? []).find((t) => t.id === request.taskId);
  if (!task) {
    throw new Error(`Routine not found: ${request.taskId}`);
  }
  const activate = request.activate ?? false;
  await ensureRoutineSessionTab(task, request.sessionId, store, activate);
  // Only steal the user's view for manual runs / explicit opens — a scheduled
  // run fires unattended and shouldn't yank the layout out from under them. The
  // tab is still created so the run streams the moment they switch to it.
  if (activate) {
    await persistedStoreApi.setKey('layoutMode', 'spaces');
  }
}

const DISPATCH_TIMEOUT_MS = 90_000;

async function handleDispatch(requestId: string, request: RoutineBridgeRequest): Promise<void> {
  try {
    if (request.kind === 'ensure-column') {
      await ensureColumn(request);
      // Don't await the actor — the column may still be booting. Main awaits
      // the actor registration implicitly on its next command (`start-run`).
      await emitter.invoke('routine:dispatch-result', requestId, true, {}, undefined);
      return;
    }
    if (request.kind === 'dispose') {
      await emitter.invoke('routine:dispatch-result', requestId, true, {}, undefined);
      return;
    }
    const actor = await awaitActor(request.taskId, DISPATCH_TIMEOUT_MS);
    let result: { runId?: string } = {};
    switch (request.kind) {
      case 'start-run': {
        const res = await actor.startRun(request.prompt, request.safeToolOverrides);
        result = { runId: res.runId };
        break;
      }
      case 'stop':
        await actor.stop();
        break;
    }
    await emitter.invoke('routine:dispatch-result', requestId, true, result, undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emitter.invoke('routine:dispatch-result', requestId, false, undefined, msg);
  }
}

let wired = false;
export function startRoutineBridge(): void {
  if (wired) {
    return;
  }
  wired = true;
  ipc.on('routine:dispatch', (requestId, request) => {
    void handleDispatch(requestId, request);
  });
}

startRoutineBridge();
