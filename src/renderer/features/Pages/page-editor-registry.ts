/**
 * Per-page editor actor registry.
 *
 * The machine for each open page lives in this module — NOT in a React
 * component — so that navigating between pages cannot leak one page's
 * buffer into another page's file. Components acquire a reference, read
 * state via `useSelector`, and release on unmount.
 *
 * Design notes:
 * - Refcount, not LRU. When the last view for a page unmounts the actor
 *   disposes itself (flushing any dirty buffer via the machine's `flushing`
 *   state). An LRU cache would let rapid back-nav preserve dirty state, but
 *   correctness matters more than cache hits here.
 * - Real actor side-effects (IPC watch/write/subscribe) are injected via
 *   `.provide({ actors })` at creation time, keeping the machine pure.
 */
import { createActor, fromCallback, fromPromise } from 'xstate';

import { pageApi } from '@/renderer/features/Pages/state';
import {
  type PageEditorActor,
  type PageEditorEvent,
  pageEditorMachine,
} from '@/shared/machines/page-editor.machine';
import type { PageId } from '@/shared/types';

type Entry = {
  actor: PageEditorActor;
  refs: number;
};

const registry = new Map<PageId, Entry>();

/**
 * Build the real actor implementations for a given page. They close over
 * `pageId` so every invoked instance operates on the right file — there is
 * no way to accidentally reuse another page's IPC calls.
 */
function createPageActors(pageId: PageId) {
  return {
    loadPage: fromPromise<string, { pageId: PageId }>(async () => {
      return pageApi.watch(pageId);
    }),

    saveContent: fromPromise<void, { pageId: PageId; content: string }>(async ({ input }) => {
      await pageApi.writeContent(pageId, input.content);
    }),

    watchExternal: fromCallback<PageEditorEvent, { pageId: PageId }>(({ sendBack }) => {
      const offChange = pageApi.onExternalChange(pageId, (content) => {
        sendBack({ type: 'EXTERNAL_CHANGE', content });
      });
      const offDelete = pageApi.onExternalDelete(pageId, () => {
        sendBack({ type: 'EXTERNAL_DELETE' });
      });
      return () => {
        offChange();
        offDelete();
      };
    }),
  };
}

/**
 * Acquire (or create) the editor actor for a page. Callers MUST pair this
 * with `releasePageEditor` on unmount.
 */
export function acquirePageEditor(pageId: PageId): PageEditorActor {
  const existing = registry.get(pageId);
  if (existing) {
    existing.refs += 1;
    return existing.actor;
  }
  const actor = createActor(
    pageEditorMachine.provide({ actors: createPageActors(pageId) }),
    { input: { pageId } },
  );
  actor.start();
  registry.set(pageId, { actor, refs: 1 });
  return actor;
}

/**
 * Release one reference to a page's editor actor. When the last reference
 * is dropped, dispatch `DISPOSE` so the machine can flush any pending
 * save, stop the file watcher, and transition to its final state.
 */
export function releasePageEditor(pageId: PageId): void {
  const entry = registry.get(pageId);
  if (!entry) {
    return;
  }
  entry.refs -= 1;
  if (entry.refs > 0) {
    return;
  }
  // Send DISPOSE — the machine handles flushing from whatever state it's
  // in (dirty → flushing → disposed; clean/loading → disposed directly).
  entry.actor.send({ type: 'DISPOSE' });
  // Stop the actor after giving it a microtask to enter the flushing state
  // and fire the save IPC. The write is in flight by then; main-process
  // completion is independent of actor lifetime.
  queueMicrotask(() => {
    entry.actor.stop();
    // Unwatch at the transport level — paired with the watch started by
    // the loadPage actor. Idempotent in the main process.
    void pageApi.unwatch(pageId);
  });
  registry.delete(pageId);
}
