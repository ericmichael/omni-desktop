import { createActor, getNextSnapshot } from 'xstate';
import { describe, expect, it } from 'vitest';

import {
  mapMachineStateToStatusType,
  sandboxMachine,
  type SandboxMachineEvent,
} from './sandbox.machine';

function next(snapshot: any, event: SandboxMachineEvent) {
  return getNextSnapshot(sandboxMachine, snapshot, event);
}

function createTestActor() {
  const actor = createActor(sandboxMachine);
  actor.start();
  return actor;
}

function getInitialSnapshot() {
  const actor = createTestActor();
  const snap = actor.getSnapshot();
  actor.stop();
  return snap;
}

function idleSnap() {
  return getInitialSnapshot();
}

function startingSnap() {
  return next(idleSnap(), { type: 'START' });
}

function spawningSnap() {
  return next(startingSnap(), { type: 'PROCESS_SPAWNED' });
}

function connectingSnap() {
  return next(spawningSnap(), { type: 'JSON_PARSED' });
}

function runningSnap() {
  return next(connectingSnap(), { type: 'SERVICES_READY' });
}

describe('sandboxMachine', () => {
  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  it('starts in idle state', () => {
    expect(idleSnap().value).toBe('idle');
    expect(idleSnap().context.error).toBeNull();
    expect(idleSnap().context.startedAt).toBeNull();
  });

  // -----------------------------------------------------------------------
  // idle
  // -----------------------------------------------------------------------

  it('transitions idle → starting on START', () => {
    const snap = startingSnap();
    expect(snap.value).toBe('starting');
    expect(snap.context.error).toBeNull();
    expect(snap.context.startedAt).toBeGreaterThan(0);
  });

  it('ignores irrelevant events in idle', () => {
    const snap = idleSnap();
    for (const evt of [
      { type: 'PROCESS_SPAWNED' },
      { type: 'JSON_PARSED' },
      { type: 'SERVICES_READY' },
      { type: 'STOP' },
    ] as SandboxMachineEvent[]) {
      expect(next(snap, evt).value).toBe('idle');
    }
  });

  // -----------------------------------------------------------------------
  // starting
  // -----------------------------------------------------------------------

  it('transitions starting → spawning on PROCESS_SPAWNED', () => {
    expect(spawningSnap().value).toBe('spawning');
  });

  it('transitions starting → error on PROCESS_ERROR', () => {
    const snap = next(startingSnap(), { type: 'PROCESS_ERROR', error: 'docker not found' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toBe('docker not found');
  });

  it('transitions starting → idle on STOP', () => {
    const snap = next(startingSnap(), { type: 'STOP' });
    expect(snap.value).toBe('idle');
  });

  // -----------------------------------------------------------------------
  // spawning
  // -----------------------------------------------------------------------

  it('transitions spawning → connecting on JSON_PARSED', () => {
    expect(connectingSnap().value).toBe('connecting');
  });

  it('transitions spawning → error on PROCESS_ERROR', () => {
    const snap = next(spawningSnap(), { type: 'PROCESS_ERROR', error: 'port conflict' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toBe('port conflict');
  });

  it('transitions spawning → error on PROCESS_EXITED', () => {
    const snap = next(spawningSnap(), { type: 'PROCESS_EXITED' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toContain('unexpectedly');
  });

  it('transitions spawning → stopping on STOP', () => {
    const snap = next(spawningSnap(), { type: 'STOP' });
    expect(snap.value).toBe('stopping');
  });

  // -----------------------------------------------------------------------
  // connecting
  // -----------------------------------------------------------------------

  it('transitions connecting → running on SERVICES_READY', () => {
    expect(runningSnap().value).toBe('running');
  });

  it('transitions connecting → error on SERVICES_TIMEOUT', () => {
    const snap = next(connectingSnap(), { type: 'SERVICES_TIMEOUT' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toContain('did not become ready');
  });

  it('transitions connecting → error on PROCESS_ERROR', () => {
    const snap = next(connectingSnap(), { type: 'PROCESS_ERROR', error: 'crash' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toBe('crash');
  });

  it('transitions connecting → error on PROCESS_EXITED', () => {
    const snap = next(connectingSnap(), { type: 'PROCESS_EXITED' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toContain('waiting for services');
  });

  it('transitions connecting → stopping on STOP', () => {
    const snap = next(connectingSnap(), { type: 'STOP' });
    expect(snap.value).toBe('stopping');
  });

  // -----------------------------------------------------------------------
  // running
  // -----------------------------------------------------------------------

  it('transitions running → stopping on STOP', () => {
    const snap = next(runningSnap(), { type: 'STOP' });
    expect(snap.value).toBe('stopping');
  });

  it('transitions running → exited on PROCESS_EXITED', () => {
    const snap = next(runningSnap(), { type: 'PROCESS_EXITED' });
    expect(snap.value).toBe('exited');
  });

  it('transitions running → error on PROCESS_ERROR', () => {
    const snap = next(runningSnap(), { type: 'PROCESS_ERROR', error: 'OOM' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toBe('OOM');
  });

  // -----------------------------------------------------------------------
  // stopping
  // -----------------------------------------------------------------------

  it('transitions stopping → exited on PROCESS_EXITED', () => {
    const stoppingSnap = next(runningSnap(), { type: 'STOP' });
    const snap = next(stoppingSnap, { type: 'PROCESS_EXITED' });
    expect(snap.value).toBe('exited');
  });

  it('transitions stopping → exited on FORCE_EXITED', () => {
    const stoppingSnap = next(runningSnap(), { type: 'STOP' });
    const snap = next(stoppingSnap, { type: 'FORCE_EXITED' });
    expect(snap.value).toBe('exited');
  });

  // -----------------------------------------------------------------------
  // exited
  // -----------------------------------------------------------------------

  it('transitions exited → starting on START', () => {
    const exitedSnap = next(runningSnap(), { type: 'PROCESS_EXITED' });
    const snap = next(exitedSnap, { type: 'START' });
    expect(snap.value).toBe('starting');
    expect(snap.context.error).toBeNull();
  });

  // -----------------------------------------------------------------------
  // error
  // -----------------------------------------------------------------------

  it('transitions error → starting on RETRY', () => {
    const errorSnap = next(startingSnap(), { type: 'PROCESS_ERROR', error: 'fail' });
    const snap = next(errorSnap, { type: 'RETRY' });
    expect(snap.value).toBe('starting');
    expect(snap.context.error).toBeNull();
  });

  it('transitions error → idle on DISMISS', () => {
    const errorSnap = next(startingSnap(), { type: 'PROCESS_ERROR', error: 'fail' });
    const snap = next(errorSnap, { type: 'DISMISS' });
    expect(snap.value).toBe('idle');
    expect(snap.context.error).toBeNull();
  });

  it('transitions error → starting on START', () => {
    const errorSnap = next(startingSnap(), { type: 'PROCESS_ERROR', error: 'fail' });
    const snap = next(errorSnap, { type: 'START' });
    expect(snap.value).toBe('starting');
  });

  // -----------------------------------------------------------------------
  // Full lifecycle
  // -----------------------------------------------------------------------

  it('handles happy path lifecycle', () => {
    const actor = createTestActor();

    actor.send({ type: 'START' });
    expect(actor.getSnapshot().value).toBe('starting');

    actor.send({ type: 'PROCESS_SPAWNED' });
    expect(actor.getSnapshot().value).toBe('spawning');

    actor.send({ type: 'JSON_PARSED' });
    expect(actor.getSnapshot().value).toBe('connecting');

    actor.send({ type: 'SERVICES_READY' });
    expect(actor.getSnapshot().value).toBe('running');

    actor.send({ type: 'STOP' });
    expect(actor.getSnapshot().value).toBe('stopping');

    actor.send({ type: 'PROCESS_EXITED' });
    expect(actor.getSnapshot().value).toBe('exited');

    actor.stop();
  });

  it('handles error → retry → success lifecycle', () => {
    const actor = createTestActor();

    actor.send({ type: 'START' });
    actor.send({ type: 'PROCESS_ERROR', error: 'docker not running' });
    expect(actor.getSnapshot().value).toBe('error');
    expect(actor.getSnapshot().context.error).toBe('docker not running');

    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().value).toBe('starting');
    expect(actor.getSnapshot().context.error).toBeNull();

    actor.send({ type: 'PROCESS_SPAWNED' });
    actor.send({ type: 'JSON_PARSED' });
    actor.send({ type: 'SERVICES_READY' });
    expect(actor.getSnapshot().value).toBe('running');

    actor.stop();
  });

  // -----------------------------------------------------------------------
  // mapMachineStateToStatusType
  // -----------------------------------------------------------------------

  it('maps machine states to IPC status types', () => {
    expect(mapMachineStateToStatusType('idle')).toBe('uninitialized');
    expect(mapMachineStateToStatusType('starting')).toBe('starting');
    expect(mapMachineStateToStatusType('spawning')).toBe('starting');
    expect(mapMachineStateToStatusType('waitingForJson')).toBe('starting');
    expect(mapMachineStateToStatusType('connecting')).toBe('connecting');
    expect(mapMachineStateToStatusType('running')).toBe('running');
    expect(mapMachineStateToStatusType('stopping')).toBe('stopping');
    expect(mapMachineStateToStatusType('exited')).toBe('exited');
    expect(mapMachineStateToStatusType('error')).toBe('error');
  });
});
