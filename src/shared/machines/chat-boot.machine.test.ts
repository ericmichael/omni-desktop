import { describe, expect, it, vi } from 'vitest';
import { createActor, fromCallback, getNextSnapshot } from 'xstate';

import {
  type ChatBootContext,
  type ChatBootEvent,
  chatBootMachine,
} from './chat-boot.machine';

// ---------------------------------------------------------------------------
// Test helpers — the machine's invokers are stubs in the pure definition.
// The hook layer provides real implementations. These tests exercise the
// state transitions without starting real services.
// ---------------------------------------------------------------------------

/** A machine with no-op invokers so tests only drive transitions via events. */
const stubMachine = chatBootMachine.provide({
  actors: {
    waitForConnection: fromCallback<ChatBootEvent>(() => () => {}),
    bootstrap: fromCallback<ChatBootEvent>(() => () => {}),
    loadSession: fromCallback<ChatBootEvent>(() => () => {}),
  },
});

function createTestActor() {
  const actor = createActor(stubMachine, { input: { sessionId: 'sess-1' } });
  actor.start();
  return actor;
}

function next(snapshot: any, event: ChatBootEvent) {
  return getNextSnapshot(stubMachine, snapshot, event);
}

function initialSnap(): any;
function initialSnap(sessionId: string | undefined): any;
function initialSnap(...args: [string | undefined] | []) {
  const sessionId = args.length === 0 ? 'sess-1' : args[0];
  const actor = createActor(stubMachine, { input: { sessionId } });
  actor.start();
  const snap = actor.getSnapshot();
  actor.stop();
  return snap;
}

function phase(snap: any): string {
  return typeof snap.value === 'string' ? snap.value : JSON.stringify(snap.value);
}

function ctx(snap: any): ChatBootContext {
  return snap.context;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('chatBootMachine', () => {
  describe('initial state', () => {
    it('starts in awaitingConnection', () => {
      expect(phase(initialSnap())).toBe('awaitingConnection');
    });

    it('seeds sessionId from input', () => {
      expect(ctx(initialSnap('abc')).sessionId).toBe('abc');
      expect(ctx(initialSnap(undefined)).sessionId).toBeUndefined();
    });

    it('starts with hasBooted = false', () => {
      expect(ctx(initialSnap()).hasBooted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: awaitingConnection → bootstrapping → loadingSession → ready
  // -------------------------------------------------------------------------

  describe('initial boot happy path', () => {
    it('awaitingConnection → bootstrapping on RPC_CONNECTED', () => {
      const snap = next(initialSnap(), { type: 'RPC_CONNECTED' });
      expect(phase(snap)).toBe('bootstrapping');
    });

    it('bootstrapping → loadingSession on BOOTSTRAP_OK when sessionId is set', () => {
      let snap = next(initialSnap(), { type: 'RPC_CONNECTED' });
      snap = next(snap, {
        type: 'BOOTSTRAP_OK',
        capabilities: { agentName: 'OmniAgent', voiceEnabled: false, workspaceSupported: true },
      });
      expect(phase(snap)).toBe('loadingSession');
      expect(ctx(snap).capabilities?.agentName).toBe('OmniAgent');
      expect(ctx(snap).capabilities?.workspaceSupported).toBe(true);
    });

    it('bootstrapping → loadingSession on BOOTSTRAP_OK even with no sessionId', () => {
      // New chat mount: chat-session still needs to leave `initializing`
      // via NEW_SESSION, so we still run the loadingSession step.
      let snap = next(initialSnap(undefined), { type: 'RPC_CONNECTED' });
      snap = next(snap, {
        type: 'BOOTSTRAP_OK',
        capabilities: { agentName: 'OmniAgent', voiceEnabled: false, workspaceSupported: false },
      });
      expect(phase(snap)).toBe('loadingSession');
      expect(ctx(snap).hasBooted).toBe(false);
    });

    it('loadingSession → ready on SESSION_LOADED', () => {
      let snap = next(initialSnap(), { type: 'RPC_CONNECTED' });
      snap = next(snap, {
        type: 'BOOTSTRAP_OK',
        capabilities: { agentName: 'A', voiceEnabled: false, workspaceSupported: false },
      });
      snap = next(snap, { type: 'SESSION_LOADED' });
      expect(phase(snap)).toBe('ready');
      expect(ctx(snap).hasBooted).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Error branches
  // -------------------------------------------------------------------------

  describe('error branches', () => {
    it('bootstrapping → bootstrapError on BOOTSTRAP_FAILED', () => {
      let snap = next(initialSnap(), { type: 'RPC_CONNECTED' });
      snap = next(snap, { type: 'BOOTSTRAP_FAILED', error: 'boom' });
      expect(phase(snap)).toBe('bootstrapError');
      expect(ctx(snap).error).toBe('boom');
    });

    it('loadingSession → sessionError on SESSION_ERROR', () => {
      let snap = next(initialSnap(), { type: 'RPC_CONNECTED' });
      snap = next(snap, {
        type: 'BOOTSTRAP_OK',
        capabilities: { agentName: 'A', voiceEnabled: false, workspaceSupported: false },
      });
      snap = next(snap, { type: 'SESSION_ERROR', error: 'not found' });
      expect(phase(snap)).toBe('sessionError');
      expect(ctx(snap).error).toBe('not found');
    });

    it('bootstrapError → bootstrapping on RETRY', () => {
      let snap = next(initialSnap(), { type: 'RPC_CONNECTED' });
      snap = next(snap, { type: 'BOOTSTRAP_FAILED', error: 'boom' });
      snap = next(snap, { type: 'RETRY' });
      expect(phase(snap)).toBe('bootstrapping');
      expect(ctx(snap).error).toBeNull();
    });

    it('sessionError → loadingSession on RETRY', () => {
      let snap = next(initialSnap(), { type: 'RPC_CONNECTED' });
      snap = next(snap, {
        type: 'BOOTSTRAP_OK',
        capabilities: { agentName: 'A', voiceEnabled: false, workspaceSupported: false },
      });
      snap = next(snap, { type: 'SESSION_ERROR', error: 'not found' });
      snap = next(snap, { type: 'RETRY' });
      expect(phase(snap)).toBe('loadingSession');
      expect(ctx(snap).error).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Disconnect handling — the core fix for HISTORY_ERROR races
  // -------------------------------------------------------------------------

  describe('disconnect unwinds to awaitingConnection', () => {
    it('bootstrapping → awaitingConnection on RPC_DISCONNECTED', () => {
      let snap = next(initialSnap(), { type: 'RPC_CONNECTED' });
      snap = next(snap, { type: 'RPC_DISCONNECTED' });
      expect(phase(snap)).toBe('awaitingConnection');
    });

    it('loadingSession → awaitingConnection on RPC_DISCONNECTED (no stale fetch)', () => {
      let snap = next(initialSnap(), { type: 'RPC_CONNECTED' });
      snap = next(snap, {
        type: 'BOOTSTRAP_OK',
        capabilities: { agentName: 'A', voiceEnabled: false, workspaceSupported: false },
      });
      expect(phase(snap)).toBe('loadingSession');
      snap = next(snap, { type: 'RPC_DISCONNECTED' });
      expect(phase(snap)).toBe('awaitingConnection');
    });

    it('ready → awaitingConnection on RPC_DISCONNECTED', () => {
      let snap = next(initialSnap(), { type: 'RPC_CONNECTED' });
      snap = next(snap, {
        type: 'BOOTSTRAP_OK',
        capabilities: { agentName: 'A', voiceEnabled: false, workspaceSupported: false },
      });
      snap = next(snap, { type: 'SESSION_LOADED' });
      expect(phase(snap)).toBe('ready');
      snap = next(snap, { type: 'RPC_DISCONNECTED' });
      expect(phase(snap)).toBe('awaitingConnection');
    });
  });

  // -------------------------------------------------------------------------
  // Reconnect skips session reload once already booted
  // -------------------------------------------------------------------------

  describe('reconnect after initial boot', () => {
    it('skips loadingSession on re-bootstrap when hasBooted is true', () => {
      // First boot through with a session
      let snap = next(initialSnap(), { type: 'RPC_CONNECTED' });
      snap = next(snap, {
        type: 'BOOTSTRAP_OK',
        capabilities: { agentName: 'A', voiceEnabled: false, workspaceSupported: false },
      });
      snap = next(snap, { type: 'SESSION_LOADED' });
      expect(phase(snap)).toBe('ready');
      expect(ctx(snap).hasBooted).toBe(true);

      // WS drops and reconnects
      snap = next(snap, { type: 'RPC_DISCONNECTED' });
      expect(phase(snap)).toBe('awaitingConnection');
      snap = next(snap, { type: 'RPC_CONNECTED' });
      expect(phase(snap)).toBe('bootstrapping');
      snap = next(snap, {
        type: 'BOOTSTRAP_OK',
        capabilities: { agentName: 'A', voiceEnabled: false, workspaceSupported: false },
      });
      // Skipped loadingSession — chat-session already has the items.
      expect(phase(snap)).toBe('ready');
    });
  });

  // -------------------------------------------------------------------------
  // SET_SESSION_ID allows the caller to update the target before boot
  // completes (e.g. ?session= parsed after mount).
  // -------------------------------------------------------------------------

  describe('SET_SESSION_ID', () => {
    it('updates sessionId from any state', () => {
      let snap = initialSnap(undefined);
      snap = next(snap, { type: 'SET_SESSION_ID', sessionId: 'later' });
      expect(ctx(snap).sessionId).toBe('later');

      // Also during bootstrapping
      snap = next(snap, { type: 'RPC_CONNECTED' });
      snap = next(snap, { type: 'SET_SESSION_ID', sessionId: 'even-later' });
      expect(ctx(snap).sessionId).toBe('even-later');
    });
  });

  // -------------------------------------------------------------------------
  // Integration: the invokers are actually called via createActor
  // -------------------------------------------------------------------------

  describe('invoker wiring', () => {
    it('invokes waitForConnection on entering awaitingConnection', () => {
      const spy = vi.fn(() => () => {});
      const m = chatBootMachine.provide({
        actors: {
          waitForConnection: fromCallback<ChatBootEvent>(spy),
          bootstrap: fromCallback<ChatBootEvent>(() => () => {}),
          loadSession: fromCallback<ChatBootEvent>(() => () => {}),
        },
      });
      const actor = createActor(m, { input: { sessionId: 'sess-1' } });
      actor.start();
      expect(spy).toHaveBeenCalledTimes(1);
      actor.stop();
    });

    it('invokes bootstrap on entering bootstrapping', () => {
      const spy = vi.fn(() => () => {});
      const m = chatBootMachine.provide({
        actors: {
          waitForConnection: fromCallback<ChatBootEvent>(({ sendBack }) => {
            sendBack({ type: 'RPC_CONNECTED' });
            return () => {};
          }),
          bootstrap: fromCallback<ChatBootEvent>(spy),
          loadSession: fromCallback<ChatBootEvent>(() => () => {}),
        },
      });
      const actor = createActor(m, { input: { sessionId: 'sess-1' } });
      actor.start();
      expect(spy).toHaveBeenCalledTimes(1);
      actor.stop();
    });

    it('invokes loadSession on entering loadingSession', () => {
      const spy = vi.fn(() => () => {});
      const m = chatBootMachine.provide({
        actors: {
          waitForConnection: fromCallback<ChatBootEvent>(({ sendBack }) => {
            sendBack({ type: 'RPC_CONNECTED' });
            return () => {};
          }),
          bootstrap: fromCallback<ChatBootEvent>(({ sendBack }) => {
            sendBack({
              type: 'BOOTSTRAP_OK',
              capabilities: { agentName: 'A', voiceEnabled: false, workspaceSupported: false },
            });
            return () => {};
          }),
          loadSession: fromCallback<ChatBootEvent>(spy),
        },
      });
      const actor = createActor(m, { input: { sessionId: 'sess-1' } });
      actor.start();
      expect(spy).toHaveBeenCalledTimes(1);
      actor.stop();
    });

    it('tears down loadSession invoker on disconnect (fixes stale-fetch race)', () => {
      const cleanup = vi.fn();
      const m = chatBootMachine.provide({
        actors: {
          waitForConnection: fromCallback<ChatBootEvent>(({ sendBack }) => {
            sendBack({ type: 'RPC_CONNECTED' });
            return () => {};
          }),
          bootstrap: fromCallback<ChatBootEvent>(({ sendBack }) => {
            sendBack({
              type: 'BOOTSTRAP_OK',
              capabilities: { agentName: 'A', voiceEnabled: false, workspaceSupported: false },
            });
            return () => {};
          }),
          loadSession: fromCallback<ChatBootEvent>(() => cleanup),
        },
      });
      const actor = createActor(m, { input: { sessionId: 'sess-1' } });
      actor.start();
      // We're now in loadingSession with the cleanup function armed.
      expect(cleanup).not.toHaveBeenCalled();
      actor.send({ type: 'RPC_DISCONNECTED' });
      // Cleanup should have fired — the in-flight fetch is abandoned.
      expect(cleanup).toHaveBeenCalledTimes(1);
      actor.stop();
    });
  });
});
