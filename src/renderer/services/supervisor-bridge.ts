/**
 * Renderer-side supervisor bridge.
 *
 * Dispatches commands from main to the live Code column: ensure the tab
 * exists (creating it on demand), submit through the same handleSubmit path
 * the user's keyboard uses, stop, reset, dispose. Forwards a narrow set of
 * sandbox run events (run_started, run_end, token_usage, disconnected) back
 * to main's orchestrator so it can drive phase / retry / stall.
 *
 * No session id lives here. No tool-call routing either — the column's
 * `buildClientToolHandler` handles tool dispatch locally.
 */

import { codeApi } from '@/renderer/features/Code/state';
import { emitter, ipc } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { RunOverrides, SupervisorBridgeEvent, SupervisorBridgeRequest, TicketId } from '@/shared/types';

export type ColumnActor = {
  ticketId: TicketId;
  /**
   * Submit a prompt through the column's own handleSubmit path. `runOverrides`
   * carries the orchestrator's intent for THIS specific run (autopilot framing,
   * approval policy) and is merged onto the column's locally owned variables.
   * For user-initiated submits, `runOverrides` is undefined and the column
   * uses steady-state mode (`ticket.autopilot`). Resolves with the runId once
   * `run_started` lands.
   */
  submit: (prompt: string, runOverrides?: RunOverrides) => Promise<{ runId: string }>;
  send: (message: string) => Promise<void>;
  stop: () => Promise<void>;
  /** Stop any in-flight run and mint a fresh session id on the column. */
  reset: () => Promise<void>;
};

const actors = new Map<TicketId, ColumnActor>();
const waiters = new Map<TicketId, Array<(a: ColumnActor) => void>>();

/** Register a column actor. Returns an unregister fn. */
export function registerColumnActor(actor: ColumnActor): () => void {
  actors.set(actor.ticketId, actor);
  const resolvers = waiters.get(actor.ticketId);
  if (resolvers) {
    for (const r of resolvers) {
      r(actor);
    }
    waiters.delete(actor.ticketId);
  }
  return () => {
    if (actors.get(actor.ticketId) === actor) {
      actors.delete(actor.ticketId);
      void forwardEvent({ kind: 'disconnected', ticketId: actor.ticketId });
    }
  };
}

function awaitActor(ticketId: TicketId, timeoutMs: number): Promise<ColumnActor> {
  const existing = actors.get(ticketId);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const list = waiters.get(ticketId) ?? [];
    waiters.set(ticketId, list);
    const onResolve = (a: ColumnActor): void => {
      clearTimeout(timer);
      resolve(a);
    };
    list.push(onResolve);
    const timer = setTimeout(() => {
      const curr = waiters.get(ticketId);
      if (curr) {
        const idx = curr.indexOf(onResolve);
        if (idx >= 0) {
          curr.splice(idx, 1);
        }
      }
      reject(new Error(`Timed out waiting for column actor: ${ticketId}`));
    }, timeoutMs);
  });
}

export async function forwardEvent(event: SupervisorBridgeEvent): Promise<void> {
  try {
    await emitter.invoke('supervisor:event', event);
  } catch {
    /* server may be mid-reconnect; best-effort */
  }
}

async function ensureColumn(request: Extract<SupervisorBridgeRequest, { kind: 'ensure-column' }>): Promise<void> {
  const tabs = persistedStoreApi.getKey('codeTabs') ?? [];
  const existing = tabs.find((t) => t.ticketId === request.ticketId);
  if (existing) {
    await persistedStoreApi.setKey('activeCodeTabId', existing.id);
    await persistedStoreApi.setKey('layoutMode', 'code');
    return;
  }
  const ticket = (persistedStoreApi.$atom.get().tickets ?? []).find((t) => t.id === request.ticketId);
  if (!ticket) {
    throw new Error(`Ticket not found: ${request.ticketId}`);
  }
  await codeApi.addTabForTicket(request.ticketId, ticket.projectId, {
    ticketTitle: ticket.title,
    workspaceDir: request.workspaceDir,
  });
  await persistedStoreApi.setKey('layoutMode', 'code');
}

const DISPATCH_TIMEOUT_MS = 90_000;

async function handleDispatch(requestId: string, request: SupervisorBridgeRequest): Promise<void> {
  try {
    if (request.kind === 'ensure-column') {
      await ensureColumn(request);
      // Don't await the actor — the column may still be booting. Main will
      // await the actor registration implicitly on its next command (run /
      // send / stop all call `awaitActor`).
      await emitter.invoke('supervisor:dispatch-result', requestId, true, {}, undefined);
      return;
    }
    if (request.kind === 'dispose') {
      await emitter.invoke('supervisor:dispatch-result', requestId, true, {}, undefined);
      return;
    }
    const actor = await awaitActor(request.ticketId, DISPATCH_TIMEOUT_MS);
    let result: { runId?: string } = {};
    switch (request.kind) {
      case 'run': {
        const res = await actor.submit(request.prompt, request.runOverrides);
        result = { runId: res.runId };
        break;
      }
      case 'send':
        await actor.send(request.message);
        break;
      case 'stop':
        await actor.stop();
        break;
      case 'reset':
        await actor.reset();
        break;
    }
    await emitter.invoke('supervisor:dispatch-result', requestId, true, result, undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emitter.invoke('supervisor:dispatch-result', requestId, false, undefined, msg);
  }
}

let wired = false;
export function startSupervisorBridge(): void {
  if (wired) {
    return;
  }
  wired = true;
  ipc.on('supervisor:dispatch', (requestId, request) => {
    void handleDispatch(requestId, request);
  });
}

startSupervisorBridge();
