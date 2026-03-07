/**
 * Tests for FleetManager's per-ticket lock (withTicketLock) and the
 * concurrency invariants it enforces. These tests exercise the lock
 * mechanism in isolation — no real SandboxManager, TicketMachine, or
 * electron-store is involved.
 */
import { describe, expect, it, vi } from 'vitest';

import type { TicketPhase } from '@/shared/ticket-phase';
import { isValidTransition } from '@/shared/ticket-phase';

// ---------------------------------------------------------------------------
// Minimal FleetManager-style per-ticket lock — extracted for unit testing.
// This mirrors the implementation in fleet-manager.ts exactly.
// ---------------------------------------------------------------------------

type TicketId = string;

class TicketLock {
  private locks = new Map<TicketId, Promise<void>>();

  withLock<T>(ticketId: TicketId, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(ticketId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      ticketId,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('per-ticket lock', () => {
  it('serializes operations for the same ticket', async () => {
    const lock = new TicketLock();
    const order: number[] = [];

    const op1 = lock.withLock('t1', async () => {
      await delay(50);
      order.push(1);
    });

    const op2 = lock.withLock('t1', async () => {
      order.push(2);
    });

    await Promise.all([op1, op2]);
    expect(order).toEqual([1, 2]); // op1 finishes before op2 starts
  });

  it('allows parallel operations for different tickets', async () => {
    const lock = new TicketLock();
    const order: string[] = [];

    const op1 = lock.withLock('t1', async () => {
      await delay(50);
      order.push('t1');
    });

    const op2 = lock.withLock('t2', async () => {
      order.push('t2');
    });

    await Promise.all([op1, op2]);
    // t2 should finish first since it has no delay and a different ticket
    expect(order).toEqual(['t2', 't1']);
  });

  it('does not deadlock when fn throws', async () => {
    const lock = new TicketLock();

    const op1 = lock.withLock('t1', async () => {
      throw new Error('boom');
    });

    await expect(op1).rejects.toThrow('boom');

    // Subsequent operation should still proceed
    const op2 = lock.withLock('t1', async () => 42);
    await expect(op2).resolves.toBe(42);
  });

  it('serializes 10 rapid-fire operations in order', async () => {
    const lock = new TicketLock();
    const order: number[] = [];

    const ops = Array.from({ length: 10 }, (_, i) =>
      lock.withLock('t1', async () => {
        await delay(1);
        order.push(i);
      })
    );

    await Promise.all(ops);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('returns the value from the locked function', async () => {
    const lock = new TicketLock();
    const result = await lock.withLock('t1', async () => 'hello');
    expect(result).toBe('hello');
  });

  it('propagates errors from the locked function', async () => {
    const lock = new TicketLock();
    await expect(
      lock.withLock('t1', async () => {
        throw new Error('fail');
      })
    ).rejects.toThrow('fail');
  });
});

// ---------------------------------------------------------------------------
// Simulated supervisor lifecycle race conditions.
// These test the patterns found in FleetManager using simplified stubs.
// ---------------------------------------------------------------------------

describe('supervisor lifecycle races', () => {
  /**
   * Simulates a minimal TicketMachine with phase tracking.
   */
  class FakeMachine {
    phase: TicketPhase = 'idle';
    disposed = false;
    startCount = 0;
    stopCount = 0;

    isActive(): boolean {
      return this.phase !== 'idle' && this.phase !== 'error' && this.phase !== 'completed';
    }

    isStreaming(): boolean {
      return this.phase === 'running' || this.phase === 'continuing';
    }

    async start(): Promise<void> {
      this.startCount++;
      this.phase = 'running';
    }

    async stop(): Promise<void> {
      this.stopCount++;
      this.phase = 'idle';
    }

    async dispose(): Promise<void> {
      this.disposed = true;
      this.phase = 'idle';
    }
  }

  /**
   * Simulates FleetManager's start/stop with the per-ticket lock.
   */
  class FakeFleetManager {
    lock = new TicketLock();
    machines = new Map<string, FakeMachine>();
    sandboxStartDelay = 50; // simulate sandbox startup time

    async startSupervisor(ticketId: string): Promise<void> {
      return this.lock.withLock(ticketId, async () => {
        // Check if already active (like validateDispatchPreflight)
        const existing = this.machines.get(ticketId);
        if (existing?.isActive()) {
          throw new Error(`Already active: ${existing.phase}`);
        }

        // Simulate sandbox provisioning (takes time)
        await delay(this.sandboxStartDelay);

        const machine = new FakeMachine();
        this.machines.set(ticketId, machine);
        await machine.start();
      });
    }

    async stopSupervisor(ticketId: string): Promise<void> {
      return this.lock.withLock(ticketId, async () => {
        const machine = this.machines.get(ticketId);
        if (!machine) return;
        await machine.stop();
      });
    }

    handleRunEnd(ticketId: string, action: 'continue' | 'complete' | 'retry'): Promise<void> {
      return this.lock.withLock(ticketId, async () => {
        const machine = this.machines.get(ticketId);
        if (!machine) return;

        // Guard: ignore if no longer streaming
        if (!machine.isStreaming()) return;

        if (action === 'complete') {
          machine.phase = 'completed';
        } else if (action === 'continue') {
          machine.phase = 'continuing';
          await delay(5);
          await machine.start();
        } else {
          machine.phase = 'retrying';
        }
      });
    }
  }

  it('double-start for same ticket: second call gets rejected', async () => {
    const fm = new FakeFleetManager();
    fm.sandboxStartDelay = 30;

    const p1 = fm.startSupervisor('t1');
    const p2 = fm.startSupervisor('t1');

    await p1;
    await expect(p2).rejects.toThrow('Already active');

    // Only ONE machine should exist, started exactly once
    const machine = fm.machines.get('t1')!;
    expect(machine.startCount).toBe(1);
  });

  it('stop during start: stop waits for start to finish', async () => {
    const fm = new FakeFleetManager();
    fm.sandboxStartDelay = 50;

    const pStart = fm.startSupervisor('t1');
    // Stop fires while start is still provisioning
    const pStop = fm.stopSupervisor('t1');

    await pStart;
    await pStop;

    const machine = fm.machines.get('t1')!;
    expect(machine.phase).toBe('idle');
    expect(machine.startCount).toBe(1);
    expect(machine.stopCount).toBe(1);
  });

  it('run_end + stop race: only one wins', async () => {
    const fm = new FakeFleetManager();
    fm.sandboxStartDelay = 5;

    await fm.startSupervisor('t1');
    const machine = fm.machines.get('t1')!;
    expect(machine.phase).toBe('running');

    // Fire run_end (continue) and stop concurrently
    const pEnd = fm.handleRunEnd('t1', 'continue');
    const pStop = fm.stopSupervisor('t1');

    await Promise.all([pEnd, pStop]);

    // The stop should have won (or run_end continued then stop fired)
    // Either way, the final state should be deterministic: idle
    expect(machine.phase).toBe('idle');
  });

  it('run_end after stop: run_end is no-op due to streaming guard', async () => {
    const fm = new FakeFleetManager();
    fm.sandboxStartDelay = 5;

    await fm.startSupervisor('t1');
    await fm.stopSupervisor('t1');

    const machine = fm.machines.get('t1')!;
    expect(machine.phase).toBe('idle');

    // run_end arrives late — machine is idle, guard should skip it
    await fm.handleRunEnd('t1', 'continue');
    expect(machine.phase).toBe('idle'); // unchanged
    expect(machine.startCount).toBe(1); // no extra start
  });

  it('rapid start/stop/start does not corrupt state', async () => {
    const fm = new FakeFleetManager();
    fm.sandboxStartDelay = 10;

    const p1 = fm.startSupervisor('t1');
    const p2 = fm.stopSupervisor('t1');
    // Wait for stop to clear the active flag before starting again
    await p1;
    await p2;
    const p3 = fm.startSupervisor('t1');
    await p3;

    const machine = fm.machines.get('t1')!;
    expect(machine.phase).toBe('running');
  });

  it('parallel starts for DIFFERENT tickets both succeed', async () => {
    const fm = new FakeFleetManager();
    fm.sandboxStartDelay = 20;

    await Promise.all([fm.startSupervisor('t1'), fm.startSupervisor('t2')]);

    expect(fm.machines.get('t1')!.phase).toBe('running');
    expect(fm.machines.get('t2')!.phase).toBe('running');
  });

  it('stall detection + retry race: stall check re-validates under lock', async () => {
    const fm = new FakeFleetManager();
    fm.sandboxStartDelay = 5;

    await fm.startSupervisor('t1');
    const machine = fm.machines.get('t1')!;

    // Simulate: stop fires first, then stall check runs
    const pStop = fm.stopSupervisor('t1');
    const pStall = fm.lock.withLock('t1', async () => {
      // Re-check under lock (mirrors checkForStalledSupervisors fix)
      if (!machine.isStreaming()) return;
      machine.phase = 'retrying';
    });

    await Promise.all([pStop, pStall]);
    // Stop won → machine is idle; stall check's re-check skipped it
    expect(machine.phase).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Transition table integration: verify key lifecycle paths are valid
// ---------------------------------------------------------------------------

describe('lifecycle transition paths', () => {
  const validPath = (phases: TicketPhase[]): void => {
    for (let i = 0; i < phases.length - 1; i++) {
      const from = phases[i]!;
      const to = phases[i + 1]!;
      expect(isValidTransition(from, to), `${from} → ${to}`).toBe(true);
    }
  };

  it('happy path: idle → provisioning → connecting → session_creating → ready → running → completed → idle', () => {
    validPath(['idle', 'provisioning', 'connecting', 'session_creating', 'ready', 'running', 'completed', 'idle']);
  });

  it('continuation: running → continuing → running → completed', () => {
    validPath(['running', 'continuing', 'running', 'completed']);
  });

  it('retry from error: running → error → provisioning → connecting → session_creating → ready → running', () => {
    validPath(['running', 'error', 'provisioning', 'connecting', 'session_creating', 'ready', 'running']);
  });

  it('retry with backoff: running → retrying → running', () => {
    validPath(['running', 'retrying', 'running']);
  });

  it('user input flow: running → awaiting_input → running → completed', () => {
    validPath(['running', 'awaiting_input', 'running', 'completed']);
  });

  it('stop from any active phase goes to idle', () => {
    const activePhases: TicketPhase[] = [
      'provisioning',
      'connecting',
      'session_creating',
      'ready',
      'running',
      'continuing',
      'awaiting_input',
      'retrying',
    ];
    for (const phase of activePhases) {
      expect(isValidTransition(phase, 'idle'), `${phase} → idle`).toBe(true);
    }
  });

  it('retrying → completed (work finished during retry wait)', () => {
    expect(isValidTransition('retrying', 'completed')).toBe(true);
  });

  it('max continuation turns: running → continuing → completed', () => {
    validPath(['running', 'continuing', 'completed']);
  });

  it('error recovery: error → idle (manual reset)', () => {
    validPath(['error', 'idle']);
  });

  it('completed → idle (cleanup)', () => {
    validPath(['completed', 'idle']);
  });

  // Verify some known INVALID paths
  it('rejects idle → running (must provision first)', () => {
    expect(isValidTransition('idle', 'running')).toBe(false);
  });

  it('rejects completed → running (must go through idle)', () => {
    expect(isValidTransition('completed', 'running')).toBe(false);
  });

  it('rejects error → running (must re-provision)', () => {
    expect(isValidTransition('error', 'running')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
