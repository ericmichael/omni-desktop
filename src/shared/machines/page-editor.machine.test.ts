import { describe, expect, it, vi } from 'vitest';
import { createActor, fromCallback, fromPromise } from 'xstate';

import type { PageId } from '@/shared/types';

import { type PageEditorEvent, pageEditorMachine, SAVE_DEBOUNCE_MS } from './page-editor.machine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_ID = 'page-test' as PageId;

type StubActors = {
  load?: (pageId: PageId) => Promise<string>;
  save?: (pageId: PageId, content: string) => Promise<void>;
  watch?: (pageId: PageId, sendBack: (ev: unknown) => void) => () => void;
};

function makeMachine(stubs: StubActors = {}) {
  const load = stubs.load ?? (async () => '');
  const save = stubs.save ?? (async () => {});
  const watch = stubs.watch ?? (() => () => {});
  return pageEditorMachine.provide({
    actors: {
      loadPage: fromPromise<string, { pageId: PageId }>(async ({ input }) => load(input.pageId)),
      saveContent: fromPromise<void, { pageId: PageId; content: string }>(async ({ input }) =>
        save(input.pageId, input.content),
      ),
      watchExternal: fromCallback<PageEditorEvent, { pageId: PageId }>(({ input, sendBack }) => {
        return watch(input.pageId, sendBack as (ev: unknown) => void);
      }),
    },
  });
}

function startActor(stubs: StubActors = {}) {
  const actor = createActor(makeMachine(stubs), { input: { pageId: PAGE_ID } });
  actor.start();
  return actor;
}

async function flushMicrotasks() {
  // Let the loadPage fromPromise settle.
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pageEditorMachine', () => {
  describe('load lifecycle', () => {
    it('loading → clean with disk content', async () => {
      const actor = startActor({ load: async () => 'hello from disk' });
      await flushMicrotasks();
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('clean');
      expect(snap.context.content).toBe('hello from disk');
      expect(snap.context.revision).toBeGreaterThan(0);
      expect(snap.context.error).toBeNull();
      actor.stop();
    });

    it('loading → clean with error on failure', async () => {
      const actor = startActor({
        load: async () => {
          throw new Error('kaboom');
        },
      });
      await flushMicrotasks();
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('clean');
      expect(snap.context.error).toContain('kaboom');
      actor.stop();
    });
  });

  describe('local edits', () => {
    it('clean → dirty.debouncing on first LOCAL_EDIT', async () => {
      const actor = startActor({ load: async () => 'base' });
      await flushMicrotasks();
      actor.send({ type: 'LOCAL_EDIT', content: 'base+' });
      const snap = actor.getSnapshot();
      expect(snap.matches({ dirty: 'debouncing' })).toBe(true);
      expect(snap.context.content).toBe('base+');
      actor.stop();
    });

    it('identical content is a no-op (does not transition to dirty)', async () => {
      const actor = startActor({ load: async () => 'same' });
      await flushMicrotasks();
      actor.send({ type: 'LOCAL_EDIT', content: 'same' });
      expect(actor.getSnapshot().value).toBe('clean');
      actor.stop();
    });
  });

  describe('debounced save', () => {
    it('fires saveContent after SAVE_DEBOUNCE_MS with the latest content', async () => {
      vi.useFakeTimers();
      const save = vi.fn(async () => {});
      try {
        const actor = startActor({ load: async () => 'base', save });
        await flushMicrotasks();
        actor.send({ type: 'LOCAL_EDIT', content: 'base+a' });
        // LOCAL_EDIT again before debounce elapses — should restart timer.
        vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 100);
        actor.send({ type: 'LOCAL_EDIT', content: 'base+ab' });
        vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 100);
        expect(save).not.toHaveBeenCalled();
        // Now let the full debounce elapse.
        vi.advanceTimersByTime(200);
        // saveContent is invoked — advance microtasks so fromPromise resolves.
        await vi.runAllTimersAsync();
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenLastCalledWith(PAGE_ID, 'base+ab');
        expect(actor.getSnapshot().value).toBe('clean');
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('lands in dirty.error on save failure, without retrying', async () => {
      vi.useFakeTimers();
      const save = vi.fn(async () => {
        throw new Error('disk full');
      });
      try {
        const actor = startActor({ load: async () => 'base', save });
        await vi.runAllTimersAsync();
        actor.send({ type: 'LOCAL_EDIT', content: 'base+a' });
        vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
        await vi.runAllTimersAsync();
        // Advance further — no retry should happen without a new edit.
        vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 5);
        await vi.runAllTimersAsync();
        expect(save).toHaveBeenCalledTimes(1);
        const snap = actor.getSnapshot();
        expect(snap.matches({ dirty: 'error' })).toBe(true);
        expect(snap.context.error).toContain('disk full');
        // A new LOCAL_EDIT re-enters debouncing and eventually retries.
        actor.send({ type: 'LOCAL_EDIT', content: 'base+ab' });
        expect(actor.getSnapshot().matches({ dirty: 'debouncing' })).toBe(true);
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('external changes', () => {
    it('clean → clean, silently adopts disk content and bumps revision', async () => {
      let emit: ((ev: unknown) => void) | undefined;
      const actor = startActor({
        load: async () => 'v1',
        watch: (_id, sendBack) => {
          emit = sendBack;
          return () => {};
        },
      });
      await flushMicrotasks();
      const beforeRev = actor.getSnapshot().context.revision;
      emit?.({ type: 'EXTERNAL_CHANGE', content: 'v2' });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('clean');
      expect(snap.context.content).toBe('v2');
      expect(snap.context.revision).toBe(beforeRev + 1);
      actor.stop();
    });

    it('dirty → conflict on external change, preserving local buffer', async () => {
      let emit: ((ev: unknown) => void) | undefined;
      const actor = startActor({
        load: async () => 'v1',
        watch: (_id, sendBack) => {
          emit = sendBack;
          return () => {};
        },
      });
      await flushMicrotasks();
      actor.send({ type: 'LOCAL_EDIT', content: 'v1+local' });
      emit?.({ type: 'EXTERNAL_CHANGE', content: 'v2' });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('conflict');
      expect(snap.context.content).toBe('v1+local');
      expect(snap.context.diskContent).toBe('v2');
      actor.stop();
    });

    it('resolve-use-disk: conflict → clean with disk content, revision bumps', async () => {
      let emit: ((ev: unknown) => void) | undefined;
      const actor = startActor({
        load: async () => 'v1',
        watch: (_id, sendBack) => {
          emit = sendBack;
          return () => {};
        },
      });
      await flushMicrotasks();
      actor.send({ type: 'LOCAL_EDIT', content: 'v1+local' });
      emit?.({ type: 'EXTERNAL_CHANGE', content: 'v2' });
      const revBefore = actor.getSnapshot().context.revision;
      actor.send({ type: 'RESOLVE_USE_DISK' });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('clean');
      expect(snap.context.content).toBe('v2');
      expect(snap.context.diskContent).toBe('');
      expect(snap.context.revision).toBe(revBefore + 1);
      actor.stop();
    });

    it('resolve-keep-local: conflict → dirty with local content', async () => {
      let emit: ((ev: unknown) => void) | undefined;
      const actor = startActor({
        load: async () => 'v1',
        watch: (_id, sendBack) => {
          emit = sendBack;
          return () => {};
        },
      });
      await flushMicrotasks();
      actor.send({ type: 'LOCAL_EDIT', content: 'v1+local' });
      emit?.({ type: 'EXTERNAL_CHANGE', content: 'v2' });
      actor.send({ type: 'RESOLVE_KEEP_LOCAL' });
      const snap = actor.getSnapshot();
      expect(snap.matches('dirty')).toBe(true);
      expect(snap.context.content).toBe('v1+local');
      expect(snap.context.diskContent).toBe('');
      actor.stop();
    });

    it('typing through the conflict banner implicitly keeps local', async () => {
      let emit: ((ev: unknown) => void) | undefined;
      const actor = startActor({
        load: async () => 'v1',
        watch: (_id, sendBack) => {
          emit = sendBack;
          return () => {};
        },
      });
      await flushMicrotasks();
      actor.send({ type: 'LOCAL_EDIT', content: 'v1+local' });
      emit?.({ type: 'EXTERNAL_CHANGE', content: 'v2' });
      expect(actor.getSnapshot().value).toBe('conflict');
      actor.send({ type: 'LOCAL_EDIT', content: 'v1+local++' });
      const snap = actor.getSnapshot();
      expect(snap.matches('dirty')).toBe(true);
      expect(snap.context.content).toBe('v1+local++');
      expect(snap.context.diskContent).toBe('');
      actor.stop();
    });
  });

  describe('external delete', () => {
    it('clean → clean with empty content', async () => {
      let emit: ((ev: unknown) => void) | undefined;
      const actor = startActor({
        load: async () => 'v1',
        watch: (_id, sendBack) => {
          emit = sendBack;
          return () => {};
        },
      });
      await flushMicrotasks();
      emit?.({ type: 'EXTERNAL_DELETE' });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('clean');
      expect(snap.context.content).toBe('');
      actor.stop();
    });

    it('dirty → conflict with empty disk side', async () => {
      let emit: ((ev: unknown) => void) | undefined;
      const actor = startActor({
        load: async () => 'v1',
        watch: (_id, sendBack) => {
          emit = sendBack;
          return () => {};
        },
      });
      await flushMicrotasks();
      actor.send({ type: 'LOCAL_EDIT', content: 'v1+local' });
      emit?.({ type: 'EXTERNAL_DELETE' });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('conflict');
      expect(snap.context.content).toBe('v1+local');
      expect(snap.context.diskContent).toBe('');
      actor.stop();
    });
  });

  describe('disposal and flush', () => {
    it('clean → disposed without firing save', async () => {
      const save = vi.fn(async () => {});
      const actor = startActor({ load: async () => 'v1', save });
      await flushMicrotasks();
      actor.send({ type: 'DISPOSE' });
      expect(actor.getSnapshot().value).toBe('disposed');
      expect(save).not.toHaveBeenCalled();
      actor.stop();
    });

    it('dirty → flushing → disposed, firing saveContent once with latest buffer', async () => {
      vi.useFakeTimers();
      const save = vi.fn(async () => {});
      try {
        const actor = startActor({ load: async () => 'v1', save });
        await vi.runAllTimersAsync();
        actor.send({ type: 'LOCAL_EDIT', content: 'v1+unsaved' });
        // Dispose BEFORE debounce elapses — the dirty-level DISPOSE handler
        // transitions to flushing, which invokes saveContent with the
        // latest buffer regardless of debounce state.
        actor.send({ type: 'DISPOSE' });
        await vi.runAllTimersAsync();
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenLastCalledWith(PAGE_ID, 'v1+unsaved');
        expect(actor.getSnapshot().value).toBe('disposed');
        actor.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('loading → disposed while load is still in flight', async () => {
      // Never-resolving load: DISPOSE should still transition to disposed.
      const actor = startActor({ load: () => new Promise<string>(() => {}) });
      actor.send({ type: 'DISPOSE' });
      expect(actor.getSnapshot().value).toBe('disposed');
      actor.stop();
    });
  });

  describe('watcher lifecycle', () => {
    it('starts watchExternal on entering clean and tears it down on disposal', async () => {
      const cleanup = vi.fn();
      const actor = startActor({
        load: async () => 'v1',
        watch: () => cleanup,
      });
      await flushMicrotasks();
      expect(actor.getSnapshot().value).toBe('clean');
      // Cleanup should fire when the actor stops.
      actor.stop();
      expect(cleanup).toHaveBeenCalled();
    });
  });
});
