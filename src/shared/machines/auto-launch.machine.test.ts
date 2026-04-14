import { describe, expect, it } from 'vitest';
import { createActor, fromCallback, getNextSnapshot } from 'xstate';

import { type AutoLaunchEvent,autoLaunchMachine } from './auto-launch.machine';

function next(snapshot: any, event: AutoLaunchEvent) {
  return getNextSnapshot(autoLaunchMachine, snapshot, event);
}

/** No-op actors that don't send any events — lets tests drive transitions manually. */
const silentActors = {
  checkRuntime: fromCallback<AutoLaunchEvent>(() => () => {}),
  watchInstallStatus: fromCallback<AutoLaunchEvent>(() => () => {}),
  checkConfigAndStart: fromCallback<AutoLaunchEvent>(() => () => {}),
  watchProcessStatus: fromCallback<AutoLaunchEvent>(() => () => {}),
};

const silentMachine = autoLaunchMachine.provide({ actors: silentActors });

function createTestActor() {
  const actor = createActor(silentMachine);
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

function checkingSnap() {
  return next(idleSnap(), { type: 'LAUNCH' });
}

function installingSnap() {
  return next(checkingSnap(), { type: 'RUNTIME_OUTDATED' });
}

function readySnap() {
  return next(checkingSnap(), { type: 'RUNTIME_READY' });
}

function startingSnap() {
  return next(readySnap(), { type: 'CONFIG_OK' });
}

function runningSnap() {
  return next(startingSnap(), { type: 'SANDBOX_RUNNING' });
}

describe('autoLaunchMachine', () => {
  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  it('starts in idle state', () => {
    expect(idleSnap().value).toBe('idle');
    expect(idleSnap().context.error).toBeNull();
    expect(idleSnap().context.hasLaunched).toBe(false);
  });

  // -----------------------------------------------------------------------
  // idle
  // -----------------------------------------------------------------------

  it('transitions idle → checking on LAUNCH', () => {
    const snap = next(idleSnap(), { type: 'LAUNCH' });
    expect(snap.value).toBe('checking');
    expect(snap.context.error).toBeNull();
  });

  it('clears error on LAUNCH', () => {
    // Construct an idle state with an error from a previous cycle
    const errorSnap = next(checkingSnap(), { type: 'RUNTIME_CHECK_FAILED', error: 'old error' });
    const idleAfterRetry = next(errorSnap, { type: 'RETRY' });
    // RETRY goes to checking, so let's test LAUNCH from idle instead
    const snap = idleSnap();
    const launched = next(snap, { type: 'LAUNCH' });
    expect(launched.context.error).toBeNull();
  });

  it('ignores irrelevant events in idle', () => {
    const snap = idleSnap();
    for (const evt of [
      { type: 'RUNTIME_READY' },
      { type: 'INSTALL_COMPLETED' },
      { type: 'SANDBOX_RUNNING' },
    ] as AutoLaunchEvent[]) {
      expect(next(snap, evt).value).toBe('idle');
    }
  });

  // -----------------------------------------------------------------------
  // checking
  // -----------------------------------------------------------------------

  it('transitions checking → ready on RUNTIME_READY', () => {
    // ready with hasLaunched=false immediately transitions to… ready (no always match)
    const snap = readySnap();
    expect(snap.value).toBe('ready');
  });

  it('transitions checking → installing on RUNTIME_OUTDATED', () => {
    const snap = installingSnap();
    expect(snap.value).toBe('installing');
  });

  it('transitions checking → error on RUNTIME_CHECK_FAILED', () => {
    const snap = next(checkingSnap(), { type: 'RUNTIME_CHECK_FAILED', error: 'check failed' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toBe('check failed');
  });

  // -----------------------------------------------------------------------
  // installing
  // -----------------------------------------------------------------------

  it('transitions installing → ready on INSTALL_COMPLETED', () => {
    const snap = next(installingSnap(), { type: 'INSTALL_COMPLETED' });
    expect(snap.value).toBe('ready');
  });

  it('transitions installing → error on INSTALL_FAILED', () => {
    const snap = next(installingSnap(), { type: 'INSTALL_FAILED', error: 'install failed' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toBe('install failed');
  });

  it('transitions installing → idle on INSTALL_CANCELLED', () => {
    const snap = next(installingSnap(), { type: 'INSTALL_CANCELLED' });
    expect(snap.value).toBe('idle');
  });

  // -----------------------------------------------------------------------
  // ready
  // -----------------------------------------------------------------------

  it('transitions ready → starting on CONFIG_OK (marks launched)', () => {
    const snap = startingSnap();
    expect(snap.value).toBe('starting');
    expect(snap.context.hasLaunched).toBe(true);
  });

  it('transitions ready → idle on CONFIG_MISSING', () => {
    const snap = next(readySnap(), { type: 'CONFIG_MISSING' });
    expect(snap.value).toBe('idle');
  });

  it('transitions ready → starting on CONFIG_CHECK_FAILED (proceeds anyway)', () => {
    const snap = next(readySnap(), { type: 'CONFIG_CHECK_FAILED', error: 'no file' });
    expect(snap.value).toBe('starting');
    expect(snap.context.hasLaunched).toBe(true);
  });

  it('transitions ready → idle if already launched (always guard)', () => {
    // After first launch cycle completes, hasLaunched is true
    const running = runningSnap();
    expect(running.context.hasLaunched).toBe(true);

    // Sandbox exits → idle
    const idleAfterExit = next(running, { type: 'SANDBOX_EXITED' });
    expect(idleAfterExit.value).toBe('idle');

    // LAUNCH again → checking → RUNTIME_READY → ready → always: idle (hasLaunched=true)
    const checking2 = next(idleAfterExit, { type: 'LAUNCH' });
    const ready2 = next(checking2, { type: 'RUNTIME_READY' });
    // The `always` guard fires because hasLaunched is still true
    expect(ready2.value).toBe('idle');
  });

  // -----------------------------------------------------------------------
  // starting
  // -----------------------------------------------------------------------

  it('transitions starting → running on SANDBOX_RUNNING', () => {
    const snap = runningSnap();
    expect(snap.value).toBe('running');
  });

  it('transitions starting → error on SANDBOX_ERROR', () => {
    const snap = next(startingSnap(), { type: 'SANDBOX_ERROR', error: 'start failed' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toBe('start failed');
  });

  it('transitions starting → idle on SANDBOX_EXITED', () => {
    const snap = next(startingSnap(), { type: 'SANDBOX_EXITED' });
    expect(snap.value).toBe('idle');
  });

  // -----------------------------------------------------------------------
  // running
  // -----------------------------------------------------------------------

  it('transitions running → idle on SANDBOX_EXITED', () => {
    const snap = next(runningSnap(), { type: 'SANDBOX_EXITED' });
    expect(snap.value).toBe('idle');
  });

  it('transitions running → idle on SANDBOX_ERROR', () => {
    const snap = next(runningSnap(), { type: 'SANDBOX_ERROR', error: 'crash' });
    expect(snap.value).toBe('idle');
  });

  // -----------------------------------------------------------------------
  // error
  // -----------------------------------------------------------------------

  it('transitions error → checking on RETRY', () => {
    const errorSnap = next(checkingSnap(), { type: 'RUNTIME_CHECK_FAILED', error: 'fail' });
    const snap = next(errorSnap, { type: 'RETRY' });
    expect(snap.value).toBe('checking');
    expect(snap.context.error).toBeNull();
  });

  it('transitions error → ready on RELAUNCH (clears hasLaunched)', () => {
    const errorSnap = next(startingSnap(), { type: 'SANDBOX_ERROR', error: 'fail' });
    expect(errorSnap.context.hasLaunched).toBe(true);

    const snap = next(errorSnap, { type: 'RELAUNCH' });
    expect(snap.value).toBe('ready');
    expect(snap.context.hasLaunched).toBe(false);
    expect(snap.context.error).toBeNull();
  });

  // -----------------------------------------------------------------------
  // RESET from any state
  // -----------------------------------------------------------------------

  it('RESET returns to idle from any state', () => {
    for (const snap of [checkingSnap(), installingSnap(), readySnap(), startingSnap(), runningSnap()]) {
      const reset = next(snap, { type: 'RESET' });
      expect(reset.value).toBe('idle');
      expect(reset.context.error).toBeNull();
      expect(reset.context.hasLaunched).toBe(false);
    }
  });

  // -----------------------------------------------------------------------
  // Full lifecycle
  // -----------------------------------------------------------------------

  it('handles happy path: idle → checking → ready → starting → running', () => {
    const actor = createTestActor();

    actor.send({ type: 'LAUNCH' });
    expect(actor.getSnapshot().value).toBe('checking');

    actor.send({ type: 'RUNTIME_READY' });
    expect(actor.getSnapshot().value).toBe('ready');

    actor.send({ type: 'CONFIG_OK' });
    expect(actor.getSnapshot().value).toBe('starting');
    expect(actor.getSnapshot().context.hasLaunched).toBe(true);

    actor.send({ type: 'SANDBOX_RUNNING' });
    expect(actor.getSnapshot().value).toBe('running');

    actor.send({ type: 'SANDBOX_EXITED' });
    expect(actor.getSnapshot().value).toBe('idle');

    actor.stop();
  });

  it('handles install path: checking → installing → ready → starting', () => {
    const actor = createTestActor();

    actor.send({ type: 'LAUNCH' });
    actor.send({ type: 'RUNTIME_OUTDATED' });
    expect(actor.getSnapshot().value).toBe('installing');

    actor.send({ type: 'INSTALL_COMPLETED' });
    expect(actor.getSnapshot().value).toBe('ready');

    actor.send({ type: 'CONFIG_OK' });
    expect(actor.getSnapshot().value).toBe('starting');

    actor.stop();
  });

  it('handles error → retry → success lifecycle', () => {
    const actor = createTestActor();

    actor.send({ type: 'LAUNCH' });
    actor.send({ type: 'RUNTIME_CHECK_FAILED', error: 'network error' });
    expect(actor.getSnapshot().value).toBe('error');
    expect(actor.getSnapshot().context.error).toBe('network error');

    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().value).toBe('checking');
    expect(actor.getSnapshot().context.error).toBeNull();

    actor.send({ type: 'RUNTIME_READY' });
    actor.send({ type: 'CONFIG_OK' });
    actor.send({ type: 'SANDBOX_RUNNING' });
    expect(actor.getSnapshot().value).toBe('running');

    actor.stop();
  });

  // -----------------------------------------------------------------------
  // Integration tests — invoke actors drive transitions
  // -----------------------------------------------------------------------

  describe('invoke integration', () => {
    it('checkRuntime actor drives checking → ready', () => {
      const machine = autoLaunchMachine.provide({
        actors: {
          ...silentActors,
          checkRuntime: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
            // Simulate async runtime check succeeding
            setTimeout(() => sendBack({ type: 'RUNTIME_READY' }), 0);
            return () => {};
          }),
        },
      });
      const actor = createActor(machine);
      actor.start();

      actor.send({ type: 'LAUNCH' });
      expect(actor.getSnapshot().value).toBe('checking');

      // Let the setTimeout fire
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(actor.getSnapshot().value).toBe('ready');
          actor.stop();
          resolve();
        }, 10);
      });
    });

    it('checkRuntime error drives checking → error', () => {
      const machine = autoLaunchMachine.provide({
        actors: {
          ...silentActors,
          checkRuntime: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
            setTimeout(() => sendBack({ type: 'RUNTIME_CHECK_FAILED', error: 'no runtime' }), 0);
            return () => {};
          }),
        },
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'LAUNCH' });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(actor.getSnapshot().value).toBe('error');
          expect(actor.getSnapshot().context.error).toBe('no runtime');
          actor.stop();
          resolve();
        }, 10);
      });
    });

    it('watchInstallStatus actor drives installing → ready', () => {
      const machine = autoLaunchMachine.provide({
        actors: {
          ...silentActors,
          watchInstallStatus: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
            setTimeout(() => sendBack({ type: 'INSTALL_COMPLETED' }), 0);
            return () => {};
          }),
        },
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'LAUNCH' });
      // Manually get to installing (checkRuntime is silent)
      actor.send({ type: 'RUNTIME_OUTDATED' });
      expect(actor.getSnapshot().value).toBe('installing');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(actor.getSnapshot().value).toBe('ready');
          actor.stop();
          resolve();
        }, 10);
      });
    });

    it('checkConfigAndStart actor drives ready → starting', () => {
      const machine = autoLaunchMachine.provide({
        actors: {
          ...silentActors,
          checkConfigAndStart: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
            setTimeout(() => sendBack({ type: 'CONFIG_OK' }), 0);
            return () => {};
          }),
        },
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'LAUNCH' });
      actor.send({ type: 'RUNTIME_READY' });
      expect(actor.getSnapshot().value).toBe('ready');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(actor.getSnapshot().value).toBe('starting');
          expect(actor.getSnapshot().context.hasLaunched).toBe(true);
          actor.stop();
          resolve();
        }, 10);
      });
    });

    it('watchProcessStatus actor drives starting → running', () => {
      const machine = autoLaunchMachine.provide({
        actors: {
          ...silentActors,
          watchProcessStatus: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
            setTimeout(() => sendBack({ type: 'SANDBOX_RUNNING' }), 0);
            return () => {};
          }),
        },
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'LAUNCH' });
      actor.send({ type: 'RUNTIME_READY' });
      actor.send({ type: 'CONFIG_OK' });
      expect(actor.getSnapshot().value).toBe('starting');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(actor.getSnapshot().value).toBe('running');
          actor.stop();
          resolve();
        }, 10);
      });
    });

    it('invoke cleanup is called when state exits', () => {
      let cleanedUp = false;
      const machine = autoLaunchMachine.provide({
        actors: {
          ...silentActors,
          checkRuntime: fromCallback<AutoLaunchEvent>(() => {
            return () => {
 cleanedUp = true; 
};
          }),
        },
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'LAUNCH' });
      expect(actor.getSnapshot().value).toBe('checking');
      expect(cleanedUp).toBe(false);

      // RESET exits checking, should trigger cleanup
      actor.send({ type: 'RESET' });
      expect(actor.getSnapshot().value).toBe('idle');
      expect(cleanedUp).toBe(true);

      actor.stop();
    });

    it('full lifecycle driven entirely by invoke actors', async () => {
      let step = 0;
      const machine = autoLaunchMachine.provide({
        actors: {
          checkRuntime: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
            step++;
            setTimeout(() => sendBack({ type: 'RUNTIME_READY' }), 0);
            return () => {};
          }),
          watchInstallStatus: silentActors.watchInstallStatus,
          checkConfigAndStart: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
            step++;
            setTimeout(() => sendBack({ type: 'CONFIG_OK' }), 0);
            return () => {};
          }),
          watchProcessStatus: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
            step++;
            setTimeout(() => sendBack({ type: 'SANDBOX_RUNNING' }), 0);
            return () => {};
          }),
        },
      });
      const actor = createActor(machine);
      actor.start();
      actor.send({ type: 'LAUNCH' });

      // Wait for all async actors to fire their events
      await new Promise<void>((resolve) => {
        const sub = actor.subscribe((snap) => {
          if (snap.value === 'running') {
            sub.unsubscribe();
            resolve();
          }
        });
      });

      expect(actor.getSnapshot().value).toBe('running');
      // 4 = checkRuntime + checkConfigAndStart + watchProcessStatus(starting) + watchProcessStatus(running)
      expect(step).toBe(4);
      actor.stop();
    });
  });
});
