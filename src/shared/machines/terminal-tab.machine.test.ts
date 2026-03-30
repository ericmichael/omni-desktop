import { createActor, getNextSnapshot } from 'xstate';
import { describe, expect, it } from 'vitest';

import {
  getTerminalConnectionStatus,
  terminalTabMachine,
  type TerminalTabEvent,
} from './terminal-tab.machine';

const input = { tabId: 'tab-1' };

function next(snapshot: any, event: TerminalTabEvent) {
  return getNextSnapshot(terminalTabMachine, snapshot, event);
}

function createTestActor() {
  const actor = createActor(terminalTabMachine, { input });
  actor.start();
  return actor;
}

function getInitialSnapshot() {
  const actor = createTestActor();
  const snap = actor.getSnapshot();
  actor.stop();
  return snap;
}

function disconnectedSnap() {
  return getInitialSnapshot();
}

function ensuringSessionSnap() {
  return next(disconnectedSnap(), { type: 'CONNECT' });
}

function creatingTerminalSnap() {
  return next(ensuringSessionSnap(), { type: 'SESSION_OK', sessionId: 'sess-1' });
}

function connectingWsSnap() {
  return next(creatingTerminalSnap(), {
    type: 'TERMINAL_CREATED',
    terminalId: 'term-1',
    token: 'tok-1',
    path: '/ws/terminal',
    cwd: '/home/user',
  });
}

function connectedSnap() {
  return next(connectingWsSnap(), { type: 'WS_OPEN' });
}

describe('terminalTabMachine', () => {
  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  it('starts in disconnected state', () => {
    expect(disconnectedSnap().value).toBe('disconnected');
  });

  it('initializes context from input', () => {
    const ctx = disconnectedSnap().context;
    expect(ctx.tabId).toBe('tab-1');
    expect(ctx.sessionId).toBeNull();
    expect(ctx.terminalId).toBeNull();
    expect(ctx.error).toBeNull();
    expect(ctx.exitCode).toBeNull();
  });

  // -----------------------------------------------------------------------
  // disconnected → ensuringSession
  // -----------------------------------------------------------------------

  it('transitions disconnected → ensuringSession on CONNECT', () => {
    const snap = next(disconnectedSnap(), { type: 'CONNECT' });
    expect(snap.value).toBe('ensuringSession');
    expect(snap.context.error).toBeNull();
  });

  it('transitions disconnected → closed on CLOSE', () => {
    const snap = next(disconnectedSnap(), { type: 'CLOSE' });
    expect(snap.value).toBe('closed');
  });

  // -----------------------------------------------------------------------
  // ensuringSession
  // -----------------------------------------------------------------------

  it('transitions ensuringSession → creatingTerminal on SESSION_OK', () => {
    const snap = next(ensuringSessionSnap(), { type: 'SESSION_OK', sessionId: 'sess-1' });
    expect(snap.value).toBe('creatingTerminal');
    expect(snap.context.sessionId).toBe('sess-1');
  });

  it('transitions ensuringSession → error on SESSION_ERROR', () => {
    const snap = next(ensuringSessionSnap(), { type: 'SESSION_ERROR', error: 'session failed' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toBe('session failed');
  });

  it('transitions ensuringSession → closed on CLOSE', () => {
    const snap = next(ensuringSessionSnap(), { type: 'CLOSE' });
    expect(snap.value).toBe('closed');
  });

  // -----------------------------------------------------------------------
  // creatingTerminal
  // -----------------------------------------------------------------------

  it('transitions creatingTerminal → connectingWs on TERMINAL_CREATED', () => {
    const snap = next(creatingTerminalSnap(), {
      type: 'TERMINAL_CREATED',
      terminalId: 'term-1',
      token: 'tok-1',
      path: '/ws/terminal',
      cwd: '/home/user',
    });
    expect(snap.value).toBe('connectingWs');
    expect(snap.context.terminalId).toBe('term-1');
    expect(snap.context.terminalToken).toBe('tok-1');
    expect(snap.context.terminalPath).toBe('/ws/terminal');
    expect(snap.context.cwd).toBe('/home/user');
  });

  it('overrides sessionId from TERMINAL_CREATED if provided', () => {
    const snap = next(creatingTerminalSnap(), {
      type: 'TERMINAL_CREATED',
      terminalId: 'term-1',
      token: 'tok-1',
      path: '/ws/terminal',
      sessionId: 'new-sess',
    });
    expect(snap.context.sessionId).toBe('new-sess');
  });

  it('keeps existing sessionId if TERMINAL_CREATED has no sessionId', () => {
    const snap = next(creatingTerminalSnap(), {
      type: 'TERMINAL_CREATED',
      terminalId: 'term-1',
      token: 'tok-1',
      path: '/ws/terminal',
    });
    expect(snap.context.sessionId).toBe('sess-1');
  });

  it('transitions creatingTerminal → error on TERMINAL_CREATE_ERROR', () => {
    const snap = next(creatingTerminalSnap(), {
      type: 'TERMINAL_CREATE_ERROR',
      error: 'creation failed',
    });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toBe('creation failed');
  });

  // -----------------------------------------------------------------------
  // connectingWs
  // -----------------------------------------------------------------------

  it('transitions connectingWs → connected on WS_OPEN', () => {
    const snap = next(connectingWsSnap(), { type: 'WS_OPEN' });
    expect(snap.value).toBe('connected');
  });

  it('transitions connectingWs → error on WS_ERROR', () => {
    const snap = next(connectingWsSnap(), { type: 'WS_ERROR', error: 'ws failed' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toBe('ws failed');
  });

  it('transitions connectingWs → error on WS_CLOSE', () => {
    const snap = next(connectingWsSnap(), { type: 'WS_CLOSE' });
    expect(snap.value).toBe('error');
    expect(snap.context.error).toContain('WebSocket closed');
  });

  // -----------------------------------------------------------------------
  // connected
  // -----------------------------------------------------------------------

  it('transitions connected → exited on EXIT', () => {
    const snap = next(connectedSnap(), { type: 'EXIT', code: 0 });
    expect(snap.value).toBe('exited');
    expect(snap.context.exitCode).toBe(0);
  });

  it('transitions connected → exited on EXIT with no code', () => {
    const snap = next(connectedSnap(), { type: 'EXIT' });
    expect(snap.value).toBe('exited');
    expect(snap.context.exitCode).toBeNull();
  });

  it('transitions connected → disconnected on WS_CLOSE', () => {
    const snap = next(connectedSnap(), { type: 'WS_CLOSE' });
    expect(snap.value).toBe('disconnected');
  });

  it('transitions connected → disconnected on WS_ERROR (clears connection state)', () => {
    const snap = next(connectedSnap(), { type: 'WS_ERROR', error: 'unexpected' });
    expect(snap.value).toBe('disconnected');
    expect(snap.context.sessionId).toBeNull();
    expect(snap.context.terminalId).toBeNull();
  });

  it('transitions connected → closed on CLOSE', () => {
    const snap = next(connectedSnap(), { type: 'CLOSE' });
    expect(snap.value).toBe('closed');
  });

  // -----------------------------------------------------------------------
  // error
  // -----------------------------------------------------------------------

  it('transitions error → disconnected on RETRY (clears state)', () => {
    const errorSnap = next(ensuringSessionSnap(), {
      type: 'SESSION_ERROR',
      error: 'fail',
    });
    const snap = next(errorSnap, { type: 'RETRY' });
    expect(snap.value).toBe('disconnected');
    expect(snap.context.error).toBeNull();
    expect(snap.context.sessionId).toBeNull();
  });

  it('transitions error → closed on CLOSE', () => {
    const errorSnap = next(ensuringSessionSnap(), {
      type: 'SESSION_ERROR',
      error: 'fail',
    });
    const snap = next(errorSnap, { type: 'CLOSE' });
    expect(snap.value).toBe('closed');
  });

  // -----------------------------------------------------------------------
  // exited (final state)
  // -----------------------------------------------------------------------

  it('exited is a final state', () => {
    const snap = next(connectedSnap(), { type: 'EXIT', code: 0 });
    expect(snap.status).toBe('done');
  });

  // -----------------------------------------------------------------------
  // Full lifecycle
  // -----------------------------------------------------------------------

  it('handles full connect lifecycle', () => {
    const actor = createTestActor();

    actor.send({ type: 'CONNECT' });
    expect(actor.getSnapshot().value).toBe('ensuringSession');

    actor.send({ type: 'SESSION_OK', sessionId: 'sess-1' });
    expect(actor.getSnapshot().value).toBe('creatingTerminal');

    actor.send({
      type: 'TERMINAL_CREATED',
      terminalId: 'term-1',
      token: 'tok-1',
      path: '/ws/terminal',
      cwd: '/workspace',
    });
    expect(actor.getSnapshot().value).toBe('connectingWs');

    actor.send({ type: 'WS_OPEN' });
    expect(actor.getSnapshot().value).toBe('connected');
    expect(actor.getSnapshot().context.cwd).toBe('/workspace');

    actor.send({ type: 'EXIT', code: 0 });
    expect(actor.getSnapshot().value).toBe('exited');
    expect(actor.getSnapshot().context.exitCode).toBe(0);

    actor.stop();
  });

  it('handles disconnect + reconnect lifecycle', () => {
    const actor = createTestActor();

    // Connect
    actor.send({ type: 'CONNECT' });
    actor.send({ type: 'SESSION_OK', sessionId: 'sess-1' });
    actor.send({
      type: 'TERMINAL_CREATED',
      terminalId: 'term-1',
      token: 'tok-1',
      path: '/ws/terminal',
    });
    actor.send({ type: 'WS_OPEN' });
    expect(actor.getSnapshot().value).toBe('connected');

    // Disconnect
    actor.send({ type: 'WS_CLOSE' });
    expect(actor.getSnapshot().value).toBe('disconnected');

    // Reconnect
    actor.send({ type: 'CONNECT' });
    expect(actor.getSnapshot().value).toBe('ensuringSession');

    actor.stop();
  });

  it('handles error + retry lifecycle', () => {
    const actor = createTestActor();

    actor.send({ type: 'CONNECT' });
    actor.send({ type: 'SESSION_ERROR', error: 'unavailable' });
    expect(actor.getSnapshot().value).toBe('error');
    expect(actor.getSnapshot().context.error).toBe('unavailable');

    actor.send({ type: 'RETRY' });
    expect(actor.getSnapshot().value).toBe('disconnected');
    expect(actor.getSnapshot().context.error).toBeNull();

    // Can reconnect after retry
    actor.send({ type: 'CONNECT' });
    expect(actor.getSnapshot().value).toBe('ensuringSession');

    actor.stop();
  });

  // -----------------------------------------------------------------------
  // getTerminalConnectionStatus
  // -----------------------------------------------------------------------

  it('maps state values to connection status', () => {
    expect(getTerminalConnectionStatus('disconnected')).toBe('disconnected');
    expect(getTerminalConnectionStatus('ensuringSession')).toBe('connecting');
    expect(getTerminalConnectionStatus('creatingTerminal')).toBe('connecting');
    expect(getTerminalConnectionStatus('connectingWs')).toBe('connecting');
    expect(getTerminalConnectionStatus('connected')).toBe('connected');
    expect(getTerminalConnectionStatus('exited')).toBe('exited');
    expect(getTerminalConnectionStatus('error')).toBe('error');
    expect(getTerminalConnectionStatus('closed')).toBe('closed');
    expect(getTerminalConnectionStatus('unknown')).toBe('disconnected');
  });
});
