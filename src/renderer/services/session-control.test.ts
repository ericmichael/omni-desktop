import { describe, expect, it } from 'vitest';

import {
  createCursorAssigner,
  fullEntry,
  getSessionController,
  lastEntrySignal,
  listSessionRunStates,
  registerSessionController,
  type SessionController,
  transcriptPage,
} from '@/renderer/services/session-control';
import type { MessageItem } from '@/shared/chat-types';

const stub = (over?: Partial<SessionController>): SessionController => ({
  sendMessage: () => {},
  decideApproval: () => {},
  stopRun: () => {},
  getState: () => ({ running: false, awaitingApproval: [], transcript: { total: 0, latestCursor: null } }),
  getTranscript: () => ({ total: 0, latestCursor: null, entries: [], hasMore: false }),
  getEntry: () => null,
  notify: () => Promise.resolve(),
  newSession: () => {},
  ...over,
});

const items = (...xs: MessageItem[]): MessageItem[] => xs;

/** Assign cursors the same way the controller does. */
const withCursors = (xs: MessageItem[]) => {
  const cursors = createCursorAssigner().assign(xs);
  return { xs, cursors };
};

describe('session-control registry', () => {
  it('registers and resolves a controller by tabId', () => {
    const c = stub();
    const unregister = registerSessionController('tab-A', c);
    expect(getSessionController('tab-A')).toBe(c);
    unregister();
    expect(getSessionController('tab-A')).toBeUndefined();
  });

  it('unregister only removes the controller if it is still the current one', () => {
    const first = stub();
    const second = stub();
    const unregisterFirst = registerSessionController('tab-B', first);
    registerSessionController('tab-B', second); // replaces first
    unregisterFirst(); // stale — must not evict `second`
    expect(getSessionController('tab-B')).toBe(second);
    registerSessionController('tab-B', stub())(); // cleanup
  });

  it('listSessionRunStates snapshots every registered column', () => {
    registerSessionController(
      'tab-run',
      stub({
        getState: () => ({
          running: true,
          runId: 'r1',
          awaitingApproval: [],
          transcript: { total: 3, latestCursor: 3 },
        }),
      })
    );
    const states = listSessionRunStates();
    expect(states['tab-run']?.transcript).toEqual({ total: 3, latestCursor: 3 });
  });

  it('a throwing getState degrades to a safe empty state', () => {
    registerSessionController(
      'tab-bad',
      stub({
        getState: () => {
          throw new Error('boom');
        },
      })
    );
    expect(listSessionRunStates()['tab-bad']).toEqual({
      running: false,
      awaitingApproval: [],
      transcript: { total: 0, latestCursor: null },
    });
  });
});

describe('createCursorAssigner', () => {
  it('assigns monotonic cursors in append order', () => {
    const a = createCursorAssigner();
    expect(
      a.assign(items({ type: 'chat', role: 'user', content: 'a' }, { type: 'chat', role: 'assistant', content: 'b' }))
    ).toEqual([1, 2]);
  });

  it('keeps a tool cursor stable across called → result (object is replaced)', () => {
    const a = createCursorAssigner();
    const called: MessageItem[] = [{ type: 'tool', tool: 'bash', status: 'called', call_id: 'c1', input: 'ls' }];
    expect(a.assign(called)).toEqual([1]);
    // result is a NEW object with the same call_id — cursor must not change.
    const result: MessageItem[] = [{ type: 'tool', tool: 'bash', status: 'result', call_id: 'c1', output: 'ok' }];
    expect(a.assign(result)).toEqual([1]);
  });

  it('survives approval removal — surviving entries keep their cursor', () => {
    const a = createCursorAssigner();
    const msg: MessageItem = { type: 'chat', role: 'user', content: 'hi' };
    const appr: MessageItem = { type: 'approval', request_id: 'r1', tool: 'rm' };
    const after: MessageItem = { type: 'chat', role: 'assistant', content: 'done' };
    expect(a.assign([msg, appr, after])).toEqual([1, 2, 3]);
    // approval decided → removed; later entry keeps cursor 3, not shifted to 2.
    expect(a.assign([msg, after])).toEqual([1, 3]);
  });
});

describe('transcriptPage', () => {
  const build = () =>
    withCursors(
      items(
        { type: 'chat', role: 'user', content: 'fix the build' },
        { type: 'tool', tool: 'bash', status: 'called', call_id: 'c1', input: 'npm run build' },
        { type: 'approval', request_id: 'req-1', tool: 'rm', argumentsText: '-rf node_modules', kind: 'function' },
        { type: 'artifact', title: 'PR body', content: '...' }
      )
    );

  it('maps each kind, tags stable cursors + live indices, reports the high-water cursor', () => {
    const { xs, cursors } = build();
    const page = transcriptPage(xs, cursors);
    expect(page.total).toBe(4);
    expect(page.latestCursor).toBe(4);
    expect(page.hasMore).toBe(false);
    expect(page.entries).toEqual([
      { cursor: 1, index: 0, kind: 'message', role: 'user', text: 'fix the build' },
      { cursor: 2, index: 1, kind: 'tool', tool: 'bash', status: 'called', input: 'npm run build', output: undefined },
      { cursor: 3, index: 2, kind: 'approval', requestId: 'req-1', tool: 'rm', args: '-rf node_modules' },
      { cursor: 4, index: 3, kind: 'artifact', title: 'PR body', artifactId: undefined },
    ]);
  });

  it('polls forward with `after`, returning only newer entries (oldest-first)', () => {
    const { xs, cursors } = build();
    const page = transcriptPage(xs, cursors, { after: 2 });
    expect(page.entries.map((e) => e.cursor)).toEqual([3, 4]);
    expect(page.hasMore).toBe(false);
    // caught up: nothing newer than the latest cursor
    expect(transcriptPage(xs, cursors, { after: 4 }).entries).toEqual([]);
  });

  it('after-polling respects limit and flags has_more', () => {
    const many = items(
      ...Array.from({ length: 10 }, (_, i): MessageItem => ({ type: 'chat', role: 'assistant', content: `m${i}` }))
    );
    const cursors = createCursorAssigner().assign(many);
    const page = transcriptPage(many, cursors, { after: 0, limit: 4 });
    expect(page.entries.map((e) => e.cursor)).toEqual([1, 2, 3, 4]);
    expect(page.hasMore).toBe(true);
  });

  it('defaults to the tail and pages backward with `before`', () => {
    const many = items(
      ...Array.from({ length: 30 }, (_, i): MessageItem => ({ type: 'chat', role: 'assistant', content: `m${i}` }))
    );
    const cursors = createCursorAssigner().assign(many);
    const tail = transcriptPage(many, cursors, { limit: 5 });
    expect(tail.entries.map((e) => e.cursor)).toEqual([26, 27, 28, 29, 30]);
    expect(tail.hasMore).toBe(true);
    const back = transcriptPage(many, cursors, { before: 26, limit: 5 });
    expect(back.entries.map((e) => e.cursor)).toEqual([21, 22, 23, 24, 25]);
    expect(back.hasMore).toBe(true);
  });

  it('quantifies truncation instead of silently dropping bytes', () => {
    const big = 'x'.repeat(5000);
    const xs = items({ type: 'tool', tool: 'bash', status: 'result', call_id: 'c1', output: big });
    const cursors = createCursorAssigner().assign(xs);
    const entry = transcriptPage(xs, cursors).entries[0] as { output: string; truncated?: Record<string, number> };
    expect(entry.output.length).toBe(2000);
    expect(entry.truncated).toEqual({ output: 5000 });
  });
});

describe('fullEntry', () => {
  it('returns one entry untruncated by cursor, or null when the cursor is gone', () => {
    const big = 'y'.repeat(5000);
    const xs = items({ type: 'tool', tool: 'bash', status: 'result', call_id: 'c1', output: big });
    const cursors = createCursorAssigner().assign(xs);
    expect(fullEntry(xs, cursors, 1)).toMatchObject({ cursor: 1, index: 0, total: 1, kind: 'tool', output: big });
    expect(fullEntry(xs, cursors, 99)).toBeNull();
  });
});

describe('lastEntrySignal', () => {
  it('points at the newest entry with its cursor, without pre-digesting it', () => {
    const xs = items(
      { type: 'chat', role: 'user', content: 'a' },
      { type: 'tool', tool: 'bash', status: 'result', call_id: 'c1' }
    );
    const cursors = createCursorAssigner().assign(xs);
    expect(lastEntrySignal(xs, cursors)).toEqual({ cursor: 2, kind: 'tool', tool: 'bash', status: 'result' });
    expect(lastEntrySignal([], [])).toBeUndefined();
  });
});
