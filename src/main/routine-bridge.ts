import type { IIpcListener } from '@/shared/ipc-listener';
import type { IpcRendererEvents, RoutineBridgeEvent, RoutineBridgeRequest, RunOverrides } from '@/shared/types';

// Inlined to avoid a type-level cycle (deps → bridge → deps). Matches the
// `IWindowSender` exported by the manager deps exactly.
type IWindowSender = <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;

export type RoutineBridgeEventHandler = (event: RoutineBridgeEvent) => void;

/**
 * Thin main→renderer bridge for Routines (scheduled tasks).
 *
 * Same ownership model as `SupervisorBridge`: the Code column owns the session
 * id, the sandbox WebSocket, and all tool / approval handling. Main only issues
 * commands ("ensure a column exists", "start this run", "stop") and observes a
 * narrow set of forwarded events (run-started, run-end, approval-requested,
 * approval-resolved, disconnected) to drive routine history / status / toasts.
 *
 * This replaces the manager's old private agent process + WebSocket: the
 * routine now runs inside the same omni-serve session the user sees, so the
 * conversation streams into the live UI.
 */
export class RoutineBridge {
  private pending = new Map<
    string,
    {
      resolve: (v: { runId?: string }) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private eventHandlers = new Set<RoutineBridgeEventHandler>();
  private nextRequestId = 0;
  /**
   * Flipped by `routine:renderer-ready`. Until then dispatches queue instead
   * of being sent — at boot the ScheduledTaskManager's first tick (missed-run
   * catch-up) runs before the window exists, and `sendToWindow` into the void
   * drops the message with no retry.
   */
  private rendererReady = false;
  private sendQueue: Array<{ requestId: string; request: RoutineBridgeRequest }> = [];
  /** Dispatches already claimed by a client (multi-client dedup). */
  private claimed = new Set<string>();

  constructor(
    private readonly sendToWindow: IWindowSender,
    private readonly requestTimeoutMs = 120_000
  ) {}

  /**
   * Register the bridge IPC handlers. `resolve(event)` picks the bridge
   * instance to act on — defaults to `this` (single-manager Electron app); the
   * per-tenant server passes a resolver that selects the caller's tenant bridge.
   */
  registerIpc(ipc: IIpcListener, resolve: (event: unknown) => RoutineBridge = () => this): string[] {
    ipc.handle(
      'routine:dispatch-result',
      (event: unknown, requestId: string, ok: boolean, result?: { runId?: string }, error?: string) => {
        const bridge = resolve(event);
        const pending = bridge.pending.get(requestId);
        if (!pending) {
          return;
        }
        bridge.pending.delete(requestId);
        bridge.claimed.delete(requestId);
        clearTimeout(pending.timer);
        if (ok) {
          pending.resolve(result ?? {});
        } else {
          pending.reject(new Error(error ?? 'Routine bridge request failed'));
        }
      }
    );
    ipc.handle('routine:event', (event: unknown, payload: RoutineBridgeEvent) => {
      for (const handler of resolve(event).eventHandlers) {
        try {
          handler(payload);
        } catch (err) {
          console.error('[RoutineBridge] event handler threw:', err);
        }
      }
    });
    ipc.handle('routine:renderer-ready', (event: unknown) => {
      const bridge = resolve(event);
      bridge.rendererReady = true;
      const queued = bridge.sendQueue.splice(0);
      for (const item of queued) {
        bridge.sendToWindow('routine:dispatch', item.requestId, item.request);
      }
    });
    ipc.handle('routine:claim-dispatch', (event: unknown, requestId: string) => {
      const bridge = resolve(event);
      // A settled/timed-out request is no longer claimable either.
      if (bridge.claimed.has(requestId) || !bridge.pending.has(requestId)) {
        return false;
      }
      bridge.claimed.add(requestId);
      return true;
    });
    return ['routine:dispatch-result', 'routine:event', 'routine:renderer-ready', 'routine:claim-dispatch'];
  }

  onEvent(handler: RoutineBridgeEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  private dispatch(request: RoutineBridgeRequest): Promise<{ runId?: string }> {
    const requestId = `routine-${++this.nextRequestId}-${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.claimed.delete(requestId);
        this.sendQueue = this.sendQueue.filter((q) => q.requestId !== requestId);
        reject(new Error(`Routine bridge request timed out: ${request.kind}`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      if (this.rendererReady) {
        this.sendToWindow('routine:dispatch', requestId, request);
      } else {
        this.sendQueue.push({ requestId, request });
      }
    });
  }

  ensureColumn(arg: { taskId: string; sessionId: string; activate?: boolean }): Promise<void> {
    return this.dispatch({ kind: 'ensure-column', ...arg }).then(() => {});
  }

  startRun(arg: {
    taskId: string;
    prompt: string;
    safeToolOverrides?: RunOverrides['safeToolOverrides'];
  }): Promise<{ runId: string }> {
    return this.dispatch({ kind: 'start-run', ...arg }).then((r) => ({ runId: r.runId ?? '' }));
  }

  stop(taskId: string): Promise<void> {
    return this.dispatch({ kind: 'stop', taskId }).then(() => {});
  }

  dispose(taskId: string): Promise<void> {
    return this.dispatch({ kind: 'dispose', taskId }).then(() => {});
  }

  disposeAll(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('RoutineBridge disposed'));
    }
    this.pending.clear();
    this.sendQueue = [];
    this.claimed.clear();
    this.eventHandlers.clear();
  }
}
