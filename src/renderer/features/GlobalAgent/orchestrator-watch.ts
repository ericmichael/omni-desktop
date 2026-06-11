/**
 * Push-driven orchestrator wakeups.
 *
 * When the headless orchestrator dispatches work to a column (`column_send`), it
 * registers a watch here. The moment that column's run ends, we push a framed
 * notification into the orchestrator's own session via its `notify` controller
 * method — which routes to omni-code's `notify` server function and flows
 * through the normal batched/assistant-role wakeup machinery. So the
 * orchestrator is woken to act, instead of polling `list_workspace`.
 *
 * Mirrors the bash-job / worker completion → `enqueue_notification` pattern in
 * omni-code, but bridges across sessions (column → orchestrator) since they run
 * in separate agent processes.
 */
import { onColumnRunEnd, onColumnRunStarted, type SessionController } from '@/renderer/services/session-control';

/** The headless orchestrator's controller (single session). */
let orchestratorController: SessionController | null = null;

/** Registered by the orchestrator panel via its `onController`. */
export function setOrchestratorController(controller: SessionController | null): void {
  orchestratorController = controller;
}

/** The orchestrator's controller, or null if its session isn't mounted/running. */
export function getOrchestratorController(): SessionController | null {
  return orchestratorController;
}

/**
 * Per watched column: the run id we're waiting on, or `awaitingStart` when the
 * dispatch was queued behind an in-flight run and we must learn its run id from
 * the next `run_started` before we can match its end.
 */
type Watch = { target?: string; awaitingStart: boolean };
const watched = new Map<string, Watch>();

/**
 * Start watching a column for completion of the orchestrator's dispatch.
 *
 * - Idle column: `column_send` got the real `runId` (the run already started) —
 *   pin to it directly.
 * - Busy column: the message was queued, so `runId` is unknown; arm to capture
 *   the run id from the next `run_started`, so we don't mistake the run our
 *   dispatch is queued *behind* for ours.
 */
export function watchColumnRun(tabId: string, runId?: string): void {
  watched.set(tabId, runId ? { target: runId, awaitingStart: false } : { awaitingStart: true });
}

const framedDoneMessage = (tabId: string, reason: string): string =>
  `[column ${tabId}] the agent you dispatched has finished its run (${reason}). ` +
  `Review what it did with list_workspace and ` +
  `column_transcript(tab_id="${tabId}", after=<the cursor you last saw>), then decide the next ` +
  `step. If this completes the user's request, summarize briefly and stop.`;

// Subscribe once at module load.
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
  const controller = orchestratorController;
  if (!controller) {
    console.warn(`[orchestrator-watch] column ${tabId} finished but no orchestrator is registered; wakeup dropped.`);
    return;
  }
  console.debug(`[orchestrator-watch] column ${tabId} finished — waking orchestrator`);
  void controller.notify(framedDoneMessage(tabId, info.reason ?? 'completed'), 'column.done').catch((e) => {
    // Surface failures rather than swallowing them — a dropped wakeup is silent
    // otherwise and very hard to diagnose.
    console.warn(`[orchestrator-watch] failed to wake orchestrator for column ${tabId}:`, e);
  });
});
