import { describe, expect, it } from 'vitest';
import { createActor, getNextSnapshot } from 'xstate';

import type { MessageItem } from '@/shared/chat-types';

import {
  type ChatSessionContext,
  type ChatSessionEvent,
  chatSessionMachine,
  isThinking,
} from './chat-session.machine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function next(snapshot: any, event: ChatSessionEvent) {
  return getNextSnapshot(chatSessionMachine, snapshot, event);
}

function createTestActor() {
  const actor = createActor(chatSessionMachine);
  actor.start();
  return actor;
}

function getInitialSnapshot() {
  const actor = createTestActor();
  const snap = actor.getSnapshot();
  actor.stop();
  return snap;
}

/** Raw machine initial state — `initializing`. */
function initializingSnap() {
  return getInitialSnapshot();
}

/** Move into `ready.idle` via NEW_SESSION. The default test starting point. */
function idleSnap(sessionId = 'sess-1') {
  return next(initializingSnap(), { type: 'NEW_SESSION', sessionId });
}

function startingSnap(sessionId = 'sess-1') {
  return next(idleSnap(sessionId), { type: 'SUBMIT', text: 'hello' });
}

function runningSnap(sessionId = 'sess-1') {
  return next(startingSnap(sessionId), {
    type: 'RUN_STARTED',
    run_id: 'run-1',
    session_id: sessionId,
  });
}

function awaitingApprovalSnap(sessionId = 'sess-1') {
  return next(runningSnap(sessionId), {
    type: 'REQUEST_APPROVAL',
    request_id: 'req-1',
    tool: 'bash',
    session_id: sessionId,
  });
}

function stoppingSnap(sessionId = 'sess-1') {
  return next(runningSnap(sessionId), { type: 'STOP' });
}

/** Fire SELECT_SESSION from the initial state to enter `initializing`. */
function loadingHistorySnap() {
  return next(initializingSnap(), { type: 'SELECT_SESSION', id: 'sess-2' });
}

function ctx(snap: any): ChatSessionContext {
  return snap.context;
}

/**
 * Flattened view of the hierarchical state. Returns the nested
 * `ready.*` sub-state as a bare string when in `ready`, otherwise the
 * top-level state name (`initializing`, `initError`).
 */
function phase(snap: any): string {
  const v = snap.value;
  if (typeof v === 'string') {
    return v;
  }
  if (v && typeof v === 'object' && typeof v.ready === 'string') {
    return v.ready;
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('chatSessionMachine', () => {
  describe('initial state', () => {
    it('starts in initializing', () => {
      expect(phase(initializingSnap())).toBe('initializing');
    });

    it('has empty context in initializing', () => {
      const c = ctx(initializingSnap());
      expect(c.sessionId).toBeUndefined();
      expect(c.runId).toBeUndefined();
      expect(c.items).toEqual([]);
      expect(c.preambleBuffer).toEqual([]);
      expect(c.pendingApprovals.size).toBe(0);
      expect(c.status).toBeUndefined();
    });

    it('idleSnap helper reaches ready.idle with sessionId from NEW_SESSION', () => {
      const c = ctx(idleSnap('sess-abc'));
      expect(phase(idleSnap('sess-abc'))).toBe('idle');
      expect(c.sessionId).toBe('sess-abc');
    });
  });

  // -----------------------------------------------------------------------
  // SUBMIT: ready.idle → ready.starting
  // -----------------------------------------------------------------------

  describe('SUBMIT', () => {
    it('transitions idle → starting', () => {
      const snap = startingSnap();
      expect(phase(snap)).toBe('starting');
    });

    it('appends user message to items', () => {
      const snap = startingSnap();
      // NEW_SESSION clears items, then SUBMIT appends exactly one user msg
      expect(ctx(snap).items).toHaveLength(1);
      expect(ctx(snap).items[0]).toMatchObject({ type: 'chat', role: 'user', content: 'hello' });
    });

    it('preserves sessionId from the prior NEW_SESSION / SELECT_SESSION', () => {
      const snap = startingSnap('my-session');
      expect(ctx(snap).sessionId).toBe('my-session');
    });

    it('preserves attachments', () => {
      const snap = next(idleSnap(), {
        type: 'SUBMIT',
        text: 'look',
        attachments: [{ type: 'image', url: 'data:...' }],
      });
      expect((ctx(snap).items[0] as any).attachments).toHaveLength(1);
    });

    it('is silently dropped from initializing (structural enforcement)', () => {
      // SUBMIT only lives on ready.idle. From initializing, it's a no-op —
      // the dropped-event detector will warn in dev, which is the correct
      // signal that upstream loadSession was skipped.
      const snap = next(initializingSnap(), { type: 'SUBMIT', text: 'hi' });
      expect(phase(snap)).toBe('initializing');
      expect(ctx(snap).items).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // RUN_STARTED: starting → running
  // -----------------------------------------------------------------------

  describe('RUN_STARTED', () => {
    it('transitions starting → running', () => {
      const snap = runningSnap();
      expect(phase(snap)).toBe('running');
    });

    it('sets runId and sessionId', () => {
      const snap = runningSnap();
      expect(ctx(snap).runId).toBe('run-1');
      expect(ctx(snap).sessionId).toBe('sess-1');
    });

    it('rejects mismatched session', () => {
      const snap = next(startingSnap('sess-1'), {
        type: 'RUN_STARTED',
        run_id: 'run-x',
        session_id: 'sess-other',
      });
      // Should stay in starting (event rejected by guard)
      expect(phase(snap)).toBe('starting');
    });

    it('accepts event during startingRun even without prior sessionId', () => {
      // Simulate: submit set sessionId, then run_started comes with matching session
      const snap = next(startingSnap('sess-1'), {
        type: 'RUN_STARTED',
        run_id: 'run-1',
        session_id: 'sess-1',
      });
      expect(phase(snap)).toBe('running');
    });
  });

  // -----------------------------------------------------------------------
  // RUN_END
  // -----------------------------------------------------------------------

  describe('RUN_END', () => {
    it('transitions running → idle', () => {
      const snap = next(runningSnap(), { type: 'RUN_END', session_id: 'sess-1' });
      expect(phase(snap)).toBe('idle');
    });

    it('transitions starting → idle', () => {
      const snap = next(startingSnap(), { type: 'RUN_END', session_id: 'sess-1' });
      expect(phase(snap)).toBe('idle');
    });

    it('transitions awaitingApproval → idle', () => {
      const snap = next(awaitingApprovalSnap(), { type: 'RUN_END', session_id: 'sess-1' });
      expect(phase(snap)).toBe('idle');
    });

    it('transitions stopping → idle', () => {
      const snap = next(stoppingSnap(), { type: 'RUN_END', session_id: 'sess-1' });
      expect(phase(snap)).toBe('idle');
    });

    it('flushes non-superseded preamble to items on run_end', () => {
      // Buffer a preamble, then end run
      let snap = runningSnap();
      snap = next(snap, { type: 'MESSAGE_OUTPUT', content: 'thinking out loud', session_id: 'sess-1' });
      expect(ctx(snap).preambleBuffer).toHaveLength(1);

      snap = next(snap, { type: 'RUN_END', session_id: 'sess-1' });
      expect(ctx(snap).preambleBuffer).toEqual([]);
      // User message + flushed preamble
      expect(ctx(snap).items).toHaveLength(2);
      expect(ctx(snap).items[1]).toMatchObject({
        type: 'chat',
        role: 'assistant',
        content: 'thinking out loud',
      });
    });

    it('does not flush superseded preamble', () => {
      let snap = runningSnap();
      snap = next(snap, { type: 'MESSAGE_OUTPUT', content: 'will be superseded', session_id: 'sess-1' });
      // Tool call supersedes the preamble
      snap = next(snap, {
        type: 'TOOL_CALLED',
        call_id: 'c1',
        tool: 'bash',
        input: 'ls',
        session_id: 'sess-1',
      });
      snap = next(snap, { type: 'RUN_END', session_id: 'sess-1' });
      // Only user message + tool item, no flushed preamble
      expect(ctx(snap).items).toHaveLength(2);
      expect(ctx(snap).items[0]!.type).toBe('chat');
      expect(ctx(snap).items[1]!.type).toBe('tool');
    });

    it('clears run state', () => {
      const snap = next(runningSnap(), { type: 'RUN_END', session_id: 'sess-1' });
      expect(ctx(snap).runId).toBeUndefined();
      expect(ctx(snap).status).toBeUndefined();
      expect(ctx(snap).statusSpinner).toBe(false);
      expect(ctx(snap).toolStatus).toBeUndefined();
    });

    it('rejects mismatched session', () => {
      const snap = next(runningSnap('sess-1'), { type: 'RUN_END', session_id: 'sess-other' });
      // Should stay in running
      expect(phase(snap)).toBe('running');
    });
  });

  // -----------------------------------------------------------------------
  // MESSAGE_OUTPUT (preamble buffering)
  // -----------------------------------------------------------------------

  describe('MESSAGE_OUTPUT', () => {
    it('buffers preamble in running state', () => {
      const snap = next(runningSnap(), {
        type: 'MESSAGE_OUTPUT',
        content: 'chunk 1',
        session_id: 'sess-1',
      });
      expect(ctx(snap).preambleBuffer).toHaveLength(1);
      expect(ctx(snap).preamble).toBe('chunk 1');
    });

    it('buffers preamble in starting state', () => {
      const snap = next(startingSnap(), {
        type: 'MESSAGE_OUTPUT',
        content: 'early',
        session_id: 'sess-1',
      });
      expect(ctx(snap).preambleBuffer).toHaveLength(1);
    });

    it('clears status when preamble arrives', () => {
      let snap = runningSnap();
      snap = next(snap, { type: 'RUN_STATUS', text: 'Working...', session_id: 'sess-1' });
      expect(ctx(snap).status).toBe('Working...');
      snap = next(snap, { type: 'MESSAGE_OUTPUT', content: 'text', session_id: 'sess-1' });
      expect(ctx(snap).status).toBeUndefined();
    });

    it('rejects mismatched session in running', () => {
      const snap = next(runningSnap('sess-1'), {
        type: 'MESSAGE_OUTPUT',
        content: 'nope',
        session_id: 'sess-other',
      });
      expect(ctx(snap).preambleBuffer).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // TOOL_CALLED / TOOL_RESULT
  // -----------------------------------------------------------------------

  describe('TOOL_CALLED', () => {
    it('appends tool item and supersedes preamble', () => {
      let snap = runningSnap();
      snap = next(snap, { type: 'MESSAGE_OUTPUT', content: 'thinking', session_id: 'sess-1' });
      snap = next(snap, {
        type: 'TOOL_CALLED',
        call_id: 'c1',
        tool: 'bash',
        input: 'ls',
        session_id: 'sess-1',
      });
      // Preamble superseded
      expect(ctx(snap).preambleBuffer[0]!.superseded).toBe(true);
      // Tool item added
      const tool = ctx(snap).items.find((it) => it.type === 'tool') as any;
      expect(tool).toBeDefined();
      expect(tool.tool).toBe('bash');
      expect(tool.status).toBe('called');
    });
  });

  describe('TOOL_RESULT', () => {
    it('updates existing tool item', () => {
      let snap = runningSnap();
      snap = next(snap, {
        type: 'TOOL_CALLED',
        call_id: 'c1',
        tool: 'bash',
        input: 'ls',
        session_id: 'sess-1',
      });
      snap = next(snap, {
        type: 'TOOL_RESULT',
        call_id: 'c1',
        tool: 'bash',
        output: 'file.txt',
        session_id: 'sess-1',
      });
      const tool = ctx(snap).items.find(
        (it) => it.type === 'tool' && (it as any).call_id === 'c1',
      ) as any;
      expect(tool.status).toBe('result');
      expect(tool.output).toBe('file.txt');
    });

    it('appends new tool item if call_id not found', () => {
      let snap = runningSnap();
      snap = next(snap, {
        type: 'TOOL_RESULT',
        call_id: 'unknown',
        tool: 'read',
        output: 'content',
        session_id: 'sess-1',
      });
      const tool = ctx(snap).items.find((it) => it.type === 'tool') as any;
      expect(tool).toBeDefined();
      expect(tool.status).toBe('result');
    });
  });

  // -----------------------------------------------------------------------
  // RUN_STATUS
  // -----------------------------------------------------------------------

  describe('RUN_STATUS', () => {
    it('updates status text and spinner', () => {
      const snap = next(runningSnap(), {
        type: 'RUN_STATUS',
        text: 'Generating...',
        session_id: 'sess-1',
      });
      expect(ctx(snap).status).toBe('Generating...');
      expect(ctx(snap).statusSpinner).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Approval flow: running → awaitingApproval → running
  // -----------------------------------------------------------------------

  describe('approval flow', () => {
    it('transitions running → awaitingApproval on REQUEST_APPROVAL', () => {
      const snap = awaitingApprovalSnap();
      expect(phase(snap)).toBe('awaitingApproval');
      expect(ctx(snap).pendingApprovals.size).toBe(1);
      expect(ctx(snap).items.some((it) => it.type === 'approval')).toBe(true);
    });

    it('transitions awaitingApproval → running on APPROVAL_DECIDED', () => {
      const snap = next(awaitingApprovalSnap(), {
        type: 'APPROVAL_DECIDED',
        request_id: 'req-1',
        value: 'yes',
      });
      expect(phase(snap)).toBe('running');
      expect(ctx(snap).pendingApprovals.size).toBe(0);
      expect(ctx(snap).items.some((it) => it.type === 'approval')).toBe(false);
    });

    it('approving one of multiple queued approvals leaves machine awaiting and allows approving the rest', () => {
      // Two approvals queued
      let snap = runningSnap();
      snap = next(snap, {
        type: 'REQUEST_APPROVAL',
        request_id: 'req-1',
        tool: 'bash',
        session_id: 'sess-1',
      });
      snap = next(snap, {
        type: 'REQUEST_APPROVAL',
        request_id: 'req-2',
        tool: 'bash',
        session_id: 'sess-1',
      });
      expect(phase(snap)).toBe('awaitingApproval');
      expect(ctx(snap).pendingApprovals.size).toBe(2);

      // Decide first — should STAY in awaitingApproval
      snap = next(snap, { type: 'APPROVAL_DECIDED', request_id: 'req-1', value: 'yes' });
      expect(phase(snap)).toBe('awaitingApproval');
      expect(ctx(snap).pendingApprovals.size).toBe(1);
      expect(ctx(snap).pendingApprovals.has('req-2')).toBe(true);

      // Decide second — now should transition to running
      snap = next(snap, { type: 'APPROVAL_DECIDED', request_id: 'req-2', value: 'yes' });
      expect(phase(snap)).toBe('running');
      expect(ctx(snap).pendingApprovals.size).toBe(0);
    });

    it('removes approval on APPROVAL_RESOLVED', () => {
      const snap = next(awaitingApprovalSnap(), {
        type: 'APPROVAL_RESOLVED',
        request_id: 'req-1',
      });
      expect(ctx(snap).pendingApprovals.size).toBe(0);
      // Stays in awaitingApproval (no decision, just resolved externally)
      expect(phase(snap)).toBe('awaitingApproval');
    });
  });

  // -----------------------------------------------------------------------
  // STOP flow: running → stopping → idle
  // -----------------------------------------------------------------------

  describe('stop flow', () => {
    it('transitions running → stopping', () => {
      expect(phase(stoppingSnap())).toBe('stopping');
    });

    it('supersedes preamble on stop', () => {
      let snap = runningSnap();
      snap = next(snap, { type: 'MESSAGE_OUTPUT', content: 'pending', session_id: 'sess-1' });
      snap = next(snap, { type: 'STOP' });
      expect(ctx(snap).preambleBuffer[0]!.superseded).toBe(true);
    });

    it('transitions stopping → idle on RUN_END', () => {
      const snap = next(stoppingSnap(), { type: 'RUN_END', session_id: 'sess-1' });
      expect(phase(snap)).toBe('idle');
    });
  });

  // -----------------------------------------------------------------------
  // Session management: SELECT_SESSION, NEW_SESSION
  // -----------------------------------------------------------------------

  describe('session management', () => {
    it('SELECT_SESSION from initial → initializing', () => {
      const snap = loadingHistorySnap();
      expect(phase(snap)).toBe('initializing');
      expect(ctx(snap).sessionId).toBe('sess-2');
      expect(ctx(snap).items).toEqual([]);
    });

    it('HISTORY_LOADED in initializing → ready.idle with items', () => {
      const items: MessageItem[] = [{ type: 'chat', role: 'user', content: 'old message' }];
      const snap = next(loadingHistorySnap(), { type: 'HISTORY_LOADED', items });
      expect(phase(snap)).toBe('idle');
      expect(ctx(snap).items).toEqual(items);
    });

    it('HISTORY_ERROR in initializing → initError', () => {
      const snap = next(loadingHistorySnap(), { type: 'HISTORY_ERROR', error: 'fail' });
      expect(phase(snap)).toBe('initError');
    });

    it('SELECT_SESSION from initError re-enters initializing', () => {
      let snap = next(loadingHistorySnap(), { type: 'HISTORY_ERROR', error: 'fail' });
      expect(phase(snap)).toBe('initError');
      snap = next(snap, { type: 'SELECT_SESSION', id: 'sess-3' });
      expect(phase(snap)).toBe('initializing');
      expect(ctx(snap).sessionId).toBe('sess-3');
    });

    it('applies HISTORY_LOADED while idle (mount rehydration path)', () => {
      // On mount with a persisted sessionId, App.tsx sends SET_SESSION_ID
      // (which does not transition out of idle) then HISTORY_LOADED. The
      // machine must accept HISTORY_LOADED from idle so past messages show.
      let snap = next(idleSnap(), { type: 'SET_SESSION_ID', sessionId: 'sess-mounted' });
      expect(phase(snap)).toBe('idle');
      const items: MessageItem[] = [
        { type: 'chat', role: 'user', content: 'hi from last session' },
        { type: 'chat', role: 'assistant', content: 'hello again' },
      ];
      snap = next(snap, { type: 'HISTORY_LOADED', items });
      expect(phase(snap)).toBe('idle');
      expect(ctx(snap).items).toEqual(items);
    });

    // These events are defined at the machine root so they apply from any
    // state. XState silently drops unhandled events, and we've lost days to
    // bugs in that class. If one of these regresses to state-scoped only,
    // the assertion here should fail.
    it('accepts root-level idempotent events from running and awaitingApproval', () => {
      const items: MessageItem[] = [{ type: 'chat', role: 'user', content: 'hi' }];

      // From running
      let snap = runningSnap();
      snap = next(snap, { type: 'SET_SESSION_ID', sessionId: 'sess-new' });
      expect(ctx(snap).sessionId).toBe('sess-new');
      snap = next(snap, { type: 'HISTORY_LOADED', items });
      expect(ctx(snap).items).toEqual(items);
      snap = next(snap, { type: 'APPEND_RESPONSE', content: 'from slash cmd' });
      expect(ctx(snap).items.at(-1)).toMatchObject({ role: 'assistant', content: 'from slash cmd' });

      // From awaitingApproval
      let snap2 = awaitingApprovalSnap();
      const before = ctx(snap2).sessionId;
      snap2 = next(snap2, { type: 'SET_SESSION_ID', sessionId: 'sess-other' });
      expect(ctx(snap2).sessionId).toBe('sess-other');
      expect(ctx(snap2).sessionId).not.toBe(before);
    });

    it('resets state on NEW_SESSION (stays idle)', () => {
      // First put some state in
      let snap = runningSnap();
      snap = next(snap, { type: 'RUN_END', session_id: 'sess-1' });
      expect(ctx(snap).items.length).toBeGreaterThan(0);

      snap = next(snap, { type: 'NEW_SESSION', sessionId: 'sess-new' });
      expect(phase(snap)).toBe('idle');
      expect(ctx(snap).sessionId).toBe('sess-new');
      expect(ctx(snap).items).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Session filter guards
  // -----------------------------------------------------------------------

  describe('session filter guards', () => {
    it('rejects stale session events during run (strict)', () => {
      const snap = next(runningSnap('sess-1'), {
        type: 'TOOL_CALLED',
        call_id: 'c1',
        tool: 'bash',
        input: 'ls',
        session_id: 'sess-old',
      });
      // Tool should NOT be added
      expect(ctx(snap).items.filter((it) => it.type === 'tool')).toHaveLength(0);
    });

    it('accepts events without session_id (legacy compat)', () => {
      const snap = next(runningSnap('sess-1'), {
        type: 'MESSAGE_OUTPUT',
        content: 'legacy',
        // No session_id
      });
      expect(ctx(snap).preambleBuffer).toHaveLength(1);
    });

    it('rejects loose events with mismatched session', () => {
      const snap = next(runningSnap('sess-1'), {
        type: 'RUN_STATUS',
        text: 'from other',
        session_id: 'sess-other',
      });
      expect(ctx(snap).status).toBeUndefined();
    });

    it('accepts loose events without session_id', () => {
      const snap = next(runningSnap('sess-1'), {
        type: 'RUN_STATUS',
        text: 'ok',
      });
      expect(ctx(snap).status).toBe('ok');
    });
  });

  // -----------------------------------------------------------------------
  // SUBMIT_ERROR
  // -----------------------------------------------------------------------

  describe('SUBMIT_ERROR', () => {
    it('transitions starting → idle and appends error message', () => {
      const snap = next(startingSnap(), { type: 'SUBMIT_ERROR', error: 'Network error' });
      expect(phase(snap)).toBe('idle');
      const lastItem = ctx(snap).items[ctx(snap).items.length - 1] as any;
      expect(lastItem.type).toBe('chat');
      expect(lastItem.role).toBe('assistant');
      expect(lastItem.content).toContain('Network error');
    });
  });

  // -----------------------------------------------------------------------
  // SET_STATUS
  // -----------------------------------------------------------------------

  describe('SET_STATUS', () => {
    it('updates status and toolStatus in running state', () => {
      const snap = next(runningSnap(), {
        type: 'SET_STATUS',
        text: 'Reading file...',
        showSpinner: true,
        session_id: 'sess-1',
      });
      expect(ctx(snap).status).toBe('Reading file...');
      expect(ctx(snap).statusSpinner).toBe(true);
      expect(ctx(snap).toolStatus).toBe('Reading file...');
    });
  });

  // -----------------------------------------------------------------------
  // isThinking helper
  // -----------------------------------------------------------------------

  describe('isThinking', () => {
    it('returns true for running/starting/stopping', () => {
      expect(isThinking('running')).toBe(true);
      expect(isThinking('starting')).toBe(true);
      expect(isThinking('stopping')).toBe(true);
    });

    it('returns false for idle/awaitingApproval', () => {
      expect(isThinking('idle')).toBe(false);
      expect(isThinking('awaitingApproval')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Hierarchical invariants — run lifecycle is nested inside `ready`
  // -----------------------------------------------------------------------
  //
  // Run sub-states exist only inside `ready`, which means being in
  // `starting`, `running`, etc. structurally implies `context.sessionId`
  // is defined. The only way out of `ready` is via SELECT_SESSION or
  // NEW_SESSION at the root — both of which abort any in-flight run.

  describe('hierarchical invariants', () => {
    it('SELECT_SESSION from any ready sub-state aborts run and re-enters initializing', () => {
      let snap = runningSnap('sess-1');
      expect(phase(snap)).toBe('running');
      expect(ctx(snap).runId).toBe('run-1');

      snap = next(snap, { type: 'SELECT_SESSION', id: 'sess-2' });
      expect(phase(snap)).toBe('initializing');
      expect(ctx(snap).sessionId).toBe('sess-2');
      expect(ctx(snap).runId).toBeUndefined();
    });

    it('SELECT_SESSION from awaitingApproval aborts and clears the pending queue', () => {
      let snap = awaitingApprovalSnap('sess-1');
      expect(phase(snap)).toBe('awaitingApproval');
      expect(ctx(snap).pendingApprovals.size).toBe(1);

      snap = next(snap, { type: 'SELECT_SESSION', id: 'sess-2' });
      expect(phase(snap)).toBe('initializing');
      expect(ctx(snap).pendingApprovals.size).toBe(0);
    });

    it('NEW_SESSION from running aborts and lands in ready.idle', () => {
      let snap = runningSnap('sess-1');
      snap = next(snap, { type: 'NEW_SESSION', sessionId: 'sess-fresh' });
      expect(phase(snap)).toBe('idle');
      expect(ctx(snap).sessionId).toBe('sess-fresh');
      expect(ctx(snap).runId).toBeUndefined();
      expect(ctx(snap).items).toEqual([]);
    });

    it('full init → submit → run flow transitions through the hierarchy', () => {
      // Mount path: SELECT_SESSION → HISTORY_LOADED → ready.idle → SUBMIT → starting → RUN_STARTED → running
      let snap = next(initializingSnap(), { type: 'SELECT_SESSION', id: 'sess-1' });
      expect(phase(snap)).toBe('initializing');

      snap = next(snap, { type: 'HISTORY_LOADED', items: [] });
      expect(phase(snap)).toBe('idle');

      snap = next(snap, { type: 'SUBMIT', text: 'hi' });
      expect(phase(snap)).toBe('starting');

      snap = next(snap, { type: 'RUN_STARTED', run_id: 'r1', session_id: 'sess-1' });
      expect(phase(snap)).toBe('running');
      expect(ctx(snap).runId).toBe('r1');
    });
  });

  // -----------------------------------------------------------------------
  // Full lifecycle scenario
  // -----------------------------------------------------------------------

  describe('full lifecycle', () => {
    it('init → new → submit → run_started → tool → result → message → run_end → idle', () => {
      const actor = createTestActor();
      const sid = 'lifecycle-session';

      // Initialize a session so SUBMIT has a place to land
      actor.send({ type: 'NEW_SESSION', sessionId: sid });
      expect(phase(actor.getSnapshot())).toBe('idle');

      // Submit
      actor.send({ type: 'SUBMIT', text: 'Do something' });
      expect(phase(actor.getSnapshot())).toBe('starting');

      // Run started
      actor.send({ type: 'RUN_STARTED', run_id: 'r1', session_id: sid });
      expect(phase(actor.getSnapshot())).toBe('running');

      // Tool called
      actor.send({
        type: 'TOOL_CALLED',
        call_id: 'c1',
        tool: 'bash',
        input: 'echo hi',
        session_id: sid,
      });

      // Tool result
      actor.send({
        type: 'TOOL_RESULT',
        call_id: 'c1',
        tool: 'bash',
        output: 'hi',
        session_id: sid,
      });

      // Message output (preamble)
      actor.send({ type: 'MESSAGE_OUTPUT', content: 'Done!', session_id: sid });
      expect(actor.getSnapshot().context.preamble).toBe('Done!');

      // Run end — should flush preamble
      actor.send({ type: 'RUN_END', session_id: sid });
      expect(phase(actor.getSnapshot())).toBe('idle');

      const items = actor.getSnapshot().context.items;
      expect(items).toHaveLength(3); // user msg + tool + flushed assistant msg
      expect(items[0]).toMatchObject({ type: 'chat', role: 'user' });
      expect(items[1]).toMatchObject({ type: 'tool', status: 'result' });
      expect(items[2]).toMatchObject({ type: 'chat', role: 'assistant', content: 'Done!' });

      actor.stop();
    });
  });
});
