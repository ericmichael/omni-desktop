/**
 * Renderer half of the superuser residents' workspace tools.
 *
 * A superuser resident's watcher (main) declares the workspace/column client
 * tools, but columns, apps, and terminals only exist in the renderer — so
 * main forwards each call here over `resident:workspace-tool`, this module
 * runs it through the superuser client-tool handler, and answers on
 * `resident:workspace-tool-result`.
 *
 * It also owns the column run-watches: when a resident dispatches work with
 * `column_send`, the moment that column's run ends we report it back
 * (`resident:column-done`) so main wakes the dispatcher with a `column_done`
 * event — push, not polling. Mirrors the bash-job / worker completion →
 * `enqueue_notification` pattern in omni-code, bridged across processes.
 *
 * Loaded for its side effects from App.tsx (the listener must exist whenever
 * a window does — the tools' availability IS the window's availability).
 */
import { buildClientToolHandler } from '@/renderer/features/Tickets/client-tool-handler';
import { emitter, ipc } from '@/renderer/services/ipc';
import { onColumnRunEnd, onColumnRunStarted } from '@/renderer/services/session-control';

/**
 * Per watched column: the dispatching agent and the run id we're waiting on,
 * or `awaitingStart` when the dispatch was queued behind an in-flight run and
 * we must learn its run id from the next `run_started` before we can match
 * its end (else we'd mistake the run we're queued *behind* for ours).
 */
type Watch = { agentId: string; target?: string; awaitingStart: boolean };
const watched = new Map<string, Watch>();

/** Start watching a column for completion of `agentId`'s dispatch. */
function watchColumnRun(agentId: string, tabId: string, runId?: string): void {
  watched.set(tabId, runId ? { agentId, target: runId, awaitingStart: false } : { agentId, awaitingStart: true });
}

onColumnRunStarted((tabId, runId) => {
  const w = watched.get(tabId);
  // The run that drains our queued dispatch — pin to it.
  if (w?.awaitingStart) {
    w.target = runId;
    w.awaitingStart = false;
  }
});

onColumnRunEnd((tabId, info) => {
  const w = watched.get(tabId);
  if (!w) {
    return;
  }
  // Our dispatched run hasn't started yet — this end is for the run we're
  // queued behind, not ours.
  if (w.awaitingStart) {
    return;
  }
  // Pinned to a specific run — ignore any other run's end.
  if (w.target && info.runId && info.runId !== w.target) {
    return;
  }
  watched.delete(tabId);
  void emitter.invoke('resident:column-done', w.agentId, tabId, info.reason ?? 'completed').catch((e) => {
    // Surface failures rather than swallowing them — a dropped wakeup is
    // silent otherwise and very hard to diagnose.
    console.warn(`[workspace-tool-bridge] failed to report column ${tabId} done for ${w.agentId}:`, e);
  });
});

/** One handler per agent, so column_send dispatches watch under the right id. */
const handlers = new Map<string, ReturnType<typeof buildClientToolHandler>>();
const handlerFor = (agentId: string): ReturnType<typeof buildClientToolHandler> => {
  let handler = handlers.get(agentId);
  if (!handler) {
    handler = buildClientToolHandler({
      superuser: true,
      onColumnDispatch: (tabId, runId) => watchColumnRun(agentId, tabId, runId),
    });
    handlers.set(agentId, handler);
  }
  return handler;
};

ipc.on('resident:workspace-tool', ({ requestId, agentId, tool, args }) => {
  void (async () => {
    let result: Record<string, unknown>;
    try {
      const res = await handlerFor(agentId)(tool, args);
      result = res.result ?? {};
    } catch (e) {
      result = { error: String(e) };
    }
    await emitter.invoke('resident:workspace-tool-result', requestId, result).catch((e) => {
      console.warn(`[workspace-tool-bridge] failed to answer ${tool} (${requestId}):`, e);
    });
  })();
});
