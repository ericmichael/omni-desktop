import type { IIpcListener } from '@/shared/ipc-listener';
import type {
  IpcRendererEvents,
  RunOverrides,
  SupervisorBridgeEvent,
  SupervisorBridgeRequest,
  TicketId,
} from '@/shared/types';

// Inlined instead of imported from @/lib/project-manager-deps to avoid a type-level
// cycle (deps → bridge → deps). Matches the exported type there exactly.
type IWindowSender = <T extends keyof IpcRendererEvents>(channel: T, ...args: IpcRendererEvents[T]) => void;

export type SupervisorBridgeEventHandler = (event: SupervisorBridgeEvent) => void;

/**
 * Thin main→renderer bridge for autopilot orchestration.
 *
 * The Code column owns the session id, the sandbox WebSocket, and all tool /
 * approval handling. Main only issues commands ("ensure a column exists",
 * "submit this prompt", "stop", "reset") and observes a narrow set of
 * forwarded events (run_started, run_end, token_usage, disconnected). No
 * session filtering lives here — the column forwards events for its own
 * single session.
 */
export class SupervisorBridge {
  private pending = new Map<
    string,
    {
      resolve: (v: { runId?: string }) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private eventHandlers = new Set<SupervisorBridgeEventHandler>();
  private nextRequestId = 0;

  constructor(
    private readonly sendToWindow: IWindowSender,
    private readonly requestTimeoutMs = 120_000
  ) {}

  /**
   * Register the bridge IPC handlers. `resolve(event)` picks the bridge
   * instance to act on — defaults to `this` (single-manager Electron app); the
   * per-tenant server passes a resolver that selects the caller's tenant
   * bridge from the HandlerContext. Accessing another instance's private
   * fields is fine here — TS scopes `private` to the class, not the instance.
   */
  registerIpc(ipc: IIpcListener, resolve: (event: unknown) => SupervisorBridge = () => this): string[] {
    ipc.handle(
      'supervisor:dispatch-result',
      (event: unknown, requestId: string, ok: boolean, result?: { runId?: string }, error?: string) => {
        const bridge = resolve(event);
        const pending = bridge.pending.get(requestId);
        if (!pending) {
          return;
        }
        bridge.pending.delete(requestId);
        clearTimeout(pending.timer);
        if (ok) {
          pending.resolve(result ?? {});
        } else {
          pending.reject(new Error(error ?? 'Supervisor bridge request failed'));
        }
      }
    );
    ipc.handle('supervisor:event', (event: unknown, payload: SupervisorBridgeEvent) => {
      for (const handler of resolve(event).eventHandlers) {
        try {
          handler(payload);
        } catch (err) {
          console.error('[SupervisorBridge] event handler threw:', err);
        }
      }
    });
    return ['supervisor:dispatch-result', 'supervisor:event'];
  }

  onEvent(handler: SupervisorBridgeEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  private dispatch(request: SupervisorBridgeRequest): Promise<{ runId?: string }> {
    const requestId = `sup-${++this.nextRequestId}-${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Supervisor bridge request timed out: ${request.kind}`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.sendToWindow('supervisor:dispatch', requestId, request);
    });
  }

  ensureColumn(arg: { ticketId: TicketId; workspaceDir?: string; profileName?: string }): Promise<void> {
    return this.dispatch({ kind: 'ensure-column', ...arg }).then(() => {});
  }

  run(arg: { ticketId: TicketId; prompt: string; runOverrides?: RunOverrides }): Promise<{ runId: string }> {
    return this.dispatch({ kind: 'run', ...arg }).then((r) => {
      if (!r.runId) {
        throw new Error('Supervisor run ack missing runId');
      }
      return { runId: r.runId };
    });
  }

  /**
   * Start an autopilot ``/goal`` loop on the ticket's session. The
   * agent-side server function takes over from there — see
   * ``server_functions/goal.py`` in omni-code. Returns when the
   * ``/goal`` call has been acked (not when the loop completes).
   */
  startGoal(arg: {
    ticketId: TicketId;
    prompt: string;
    maxTurns?: number;
    tickInterval?: number;
    runOverrides?: RunOverrides;
  }): Promise<void> {
    return this.dispatch({ kind: 'goal-start', ...arg }).then(() => {});
  }

  /** Cancel the running ``/goal`` loop on the ticket's session. */
  stopGoal(ticketId: TicketId): Promise<void> {
    return this.dispatch({ kind: 'goal-stop', ticketId }).then(() => {});
  }

  send(ticketId: TicketId, message: string): Promise<void> {
    return this.dispatch({ kind: 'send', ticketId, message }).then(() => {});
  }

  stop(ticketId: TicketId): Promise<void> {
    return this.dispatch({ kind: 'stop', ticketId }).then(() => {});
  }

  reset(ticketId: TicketId): Promise<void> {
    return this.dispatch({ kind: 'reset', ticketId }).then(() => {});
  }

  dispose(ticketId: TicketId): Promise<void> {
    return this.dispatch({ kind: 'dispose', ticketId }).then(() => {});
  }

  disposeAll(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('SupervisorBridge disposed'));
    }
    this.pending.clear();
    this.eventHandlers.clear();
  }
}
