import type { TicketPhase } from '@/shared/ticket-phase';
import { isActivePhase, isStreamingPhase, isValidTransition } from '@/shared/ticket-phase';
import type { TicketId } from '@/shared/types';

export type SupervisorStateCallbacks = {
  onPhaseChange: (ticketId: TicketId, phase: TicketPhase) => void;
  onDispose?: (ticketId: TicketId) => void;
};

/**
 * Main's phase record for a ticket's autopilot lifecycle. Holds no
 * session id and no WebSocket — the Code column owns both. Driven entirely
 * by forwarded bridge events; continuation/retry/stall recovery live in
 * omni-code's ``/goal`` server function.
 */
export class SupervisorState {
  readonly ticketId: TicketId;

  private phase: TicketPhase = 'idle';
  private runId: string | null = null;

  lastActivity: number = Date.now();

  private callbacks: SupervisorStateCallbacks;
  private opLock: Promise<void> = Promise.resolve();

  constructor(ticketId: TicketId, callbacks: SupervisorStateCallbacks) {
    this.ticketId = ticketId;
    this.callbacks = callbacks;
  }

  getPhase(): TicketPhase {
    return this.phase;
  }

  getRunId(): string | null {
    return this.runId;
  }

  isActive(): boolean {
    return isActivePhase(this.phase);
  }

  isStreaming(): boolean {
    return isStreamingPhase(this.phase);
  }

  setRunId(runId: string | null): void {
    this.runId = runId;
  }

  transition(to: TicketPhase): void {
    if (this.phase === to) {
      return;
    }
    if (!isValidTransition(this.phase, to)) {
      console.warn(
        `[SupervisorState] Invalid transition for ${this.ticketId}: ${this.phase} → ${to}. Ignoring.`
      );
      return;
    }
    const from = this.phase;
    this.phase = to;
    console.log(`[SupervisorState] ${this.ticketId}: ${from} → ${to}`);
    this.callbacks.onPhaseChange(this.ticketId, to);
  }

  forcePhase(phase: TicketPhase): void {
    this.phase = phase;
    this.callbacks.onPhaseChange(this.ticketId, phase);
  }

  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opLock.then(fn, fn);
    this.opLock = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  recordActivity(): void {
    this.lastActivity = Date.now();
  }

  getLastActivity(): number {
    return this.lastActivity;
  }

  dispose(): void {
    this.runId = null;
    if (this.phase !== 'idle') {
      this.forcePhase('idle');
    }
    this.callbacks.onDispose?.(this.ticketId);
  }
}
