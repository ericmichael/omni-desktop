/**
 * XState v5 machine for a single page editor.
 *
 * One actor per page — entity-scoped state lives here, not in a React
 * component. The component becomes a view over `useSelector(actor)`, which
 * makes it structurally impossible for one page's buffer to be written to
 * another page's file on a navigation race.
 *
 * States: loading → clean ⇄ dirty(.debouncing | .saving) ; clean|dirty ⇄ conflict.
 * Disposal is an explicit event so dirty state can fire a final save.
 *
 * Side effects (disk read, file watch, debounced save) are invoked actors.
 * Placeholder implementations live in `setup()`; real IPC-bound actors are
 * injected at `createActor` time via `.provide({ actors })`, matching the
 * convention used by the other machines in this directory.
 */
import { type ActorRefFrom, assign, fromCallback, fromPromise, setup } from 'xstate';

import type { PageId } from '@/shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PageEditorContext = {
  pageId: PageId;
  /** Authoritative editor buffer. In `clean` mirrors disk; in `dirty` is the local edit. */
  content: string;
  /** Disk-side content, only populated while in `conflict`. */
  diskContent: string;
  /**
   * Incremented whenever `content` changes in a way that the editor must
   * pick up as its `initialMarkdown` (load, silent auto-reload, resolve).
   * Used by the view as part of the ContextEditor's `key`.
   */
  revision: number;
  error: string | null;
};

export type PageEditorEvent =
  // Load lifecycle (from invoked loadPage actor)
  | { type: 'LOADED'; content: string }
  | { type: 'LOAD_FAILED'; error: string }
  // User edits (from the view)
  | { type: 'LOCAL_EDIT'; content: string }
  // Save lifecycle (from invoked saveContent actor)
  | { type: 'SAVE_DONE' }
  | { type: 'SAVE_ERROR'; error: string }
  // External file-system events (from invoked watchExternal actor)
  | { type: 'EXTERNAL_CHANGE'; content: string }
  | { type: 'EXTERNAL_DELETE' }
  // Conflict resolution (from the view)
  | { type: 'RESOLVE_USE_DISK' }
  | { type: 'RESOLVE_KEEP_LOCAL' }
  // Registry-driven teardown
  | { type: 'DISPOSE' };

/** Debounce for auto-save after a local edit. */
export const SAVE_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export const pageEditorMachine = setup({
  types: {
    context: {} as PageEditorContext,
    events: {} as PageEditorEvent,
    input: {} as { pageId: PageId },
  },

  actors: {
    /**
     * Load initial content and start the file watcher. Replaced at
     * createActor time by a provider that calls `pageApi.watch(pageId)`.
     */
    loadPage: fromPromise<string, { pageId: PageId }>(async () => ''),

    /**
     * Persist `content` to disk. Replaced by a provider that calls
     * `pageApi.writeContent(pageId, content)`.
     */
    saveContent: fromPromise<void, { pageId: PageId; content: string }>(async () => {}),

    /**
     * Subscribe to external-edit events for the page. Replaced by a
     * provider that wires `pageApi.onExternalChange` / `onExternalDelete`.
     * Must return a cleanup function that unsubscribes.
     */
    watchExternal: fromCallback<PageEditorEvent, { pageId: PageId }>(() => () => {}),
  },

  actions: {
    setContentFromLoaded: assign({
      content: ({ event }) => (event as Extract<PageEditorEvent, { type: 'LOADED' }>).content,
      revision: ({ context }) => context.revision + 1,
      error: null,
    }),
    setContentFromLocal: assign({
      content: ({ event }) => (event as Extract<PageEditorEvent, { type: 'LOCAL_EDIT' }>).content,
    }),
    setContentFromExternal: assign({
      content: ({ event }) => (event as Extract<PageEditorEvent, { type: 'EXTERNAL_CHANGE' }>).content,
      revision: ({ context }) => context.revision + 1,
    }),
    clearContentFromExternalDelete: assign({
      content: '',
      revision: ({ context }) => context.revision + 1,
    }),
    enterConflictFromChange: assign({
      diskContent: ({ event }) => (event as Extract<PageEditorEvent, { type: 'EXTERNAL_CHANGE' }>).content,
    }),
    enterConflictFromDelete: assign({
      diskContent: '',
    }),
    resolveUseDisk: assign({
      content: ({ context }) => context.diskContent,
      diskContent: '',
      revision: ({ context }) => context.revision + 1,
    }),
    clearDisk: assign({
      diskContent: '',
    }),
    setError: assign({
      error: ({ event }) =>
        (event as Extract<PageEditorEvent, { type: 'LOAD_FAILED' | 'SAVE_ERROR' }>).error,
    }),
    clearError: assign({ error: null }),
  },
}).createMachine({
  id: 'pageEditor',
  initial: 'loading',
  context: ({ input }) => ({
    pageId: input.pageId,
    content: '',
    diskContent: '',
    revision: 0,
    error: null,
  }),

  states: {
    loading: {
      invoke: {
        src: 'loadPage',
        input: ({ context }) => ({ pageId: context.pageId }),
        onDone: {
          target: 'clean',
          actions: assign({
            content: ({ event }) => event.output,
            revision: ({ context }) => context.revision + 1,
            error: null,
          }),
        },
        onError: {
          target: 'clean',
          actions: assign({
            error: ({ event }) => String(event.error ?? 'load failed'),
            revision: ({ context }) => context.revision + 1,
          }),
        },
      },
      on: {
        DISPOSE: 'disposed',
      },
    },

    clean: {
      invoke: {
        src: 'watchExternal',
        input: ({ context }) => ({ pageId: context.pageId }),
      },
      on: {
        LOCAL_EDIT: [
          // No-op if content is identical (React/Yoopta can fire onChange
          // during initialization with the same content we just loaded).
          {
            guard: ({ context, event }) => event.content === context.content,
          },
          {
            target: 'dirty',
            actions: 'setContentFromLocal',
          },
        ],
        EXTERNAL_CHANGE: {
          // Silent auto-reload — the magic sync experience. Bumps revision
          // so the view re-keys the editor onto the new content.
          actions: 'setContentFromExternal',
        },
        EXTERNAL_DELETE: {
          actions: 'clearContentFromExternalDelete',
        },
        DISPOSE: 'disposed',
      },
    },

    dirty: {
      initial: 'debouncing',
      invoke: {
        src: 'watchExternal',
        input: ({ context }) => ({ pageId: context.pageId }),
      },
      on: {
        LOCAL_EDIT: {
          // External self-transition into .debouncing so `after` restarts,
          // but the parent `dirty` state is NOT re-entered — `watchExternal`
          // keeps running without teardown/rebuild.
          target: '.debouncing',
          actions: 'setContentFromLocal',
        },
        EXTERNAL_CHANGE: {
          target: 'conflict',
          actions: 'enterConflictFromChange',
        },
        EXTERNAL_DELETE: {
          target: 'conflict',
          actions: 'enterConflictFromDelete',
        },
        DISPOSE: {
          // Flush: transition to a final-save state that runs saveContent
          // once and then disposes. The invoked actor starts the IPC write
          // before the machine is stopped; if the caller stops us before
          // it completes, the write is already in flight at the main process.
          target: 'flushing',
        },
      },
      states: {
        debouncing: {
          after: {
            [SAVE_DEBOUNCE_MS]: 'saving',
          },
        },
        saving: {
          invoke: {
            src: 'saveContent',
            input: ({ context }) => ({ pageId: context.pageId, content: context.content }),
            onDone: {
              target: '#pageEditor.clean',
              actions: 'clearError',
            },
            onError: {
              // Surface the error and stop the debounce timer. We do NOT
              // retry automatically — that would flood the disk. The next
              // LOCAL_EDIT from the user naturally targets `.debouncing`
              // (via the dirty-level handler) and restarts the save cycle.
              target: 'error',
              actions: assign({
                error: ({ event }) => String(event.error ?? 'save failed'),
              }),
            },
          },
        },
        error: {
          // Terminal-ish: no `after` timer, no invoked actor. Waits for
          // the next LOCAL_EDIT (handled at the parent `dirty` level) or
          // an EXTERNAL_CHANGE / DISPOSE.
        },
      },
    },

    conflict: {
      invoke: {
        src: 'watchExternal',
        input: ({ context }) => ({ pageId: context.pageId }),
      },
      on: {
        EXTERNAL_CHANGE: {
          // Disk changed again while unresolved — refresh the disk side.
          actions: 'enterConflictFromChange',
        },
        EXTERNAL_DELETE: {
          actions: 'enterConflictFromDelete',
        },
        LOCAL_EDIT: {
          // Treat edit-through-conflict as "Keep my version" — local becomes
          // authoritative, disk side is dropped.
          target: 'dirty',
          actions: ['setContentFromLocal', 'clearDisk'],
        },
        RESOLVE_USE_DISK: {
          target: 'clean',
          actions: 'resolveUseDisk',
        },
        RESOLVE_KEEP_LOCAL: {
          target: 'dirty',
          actions: 'clearDisk',
        },
        DISPOSE: 'disposed',
      },
    },

    flushing: {
      invoke: {
        src: 'saveContent',
        input: ({ context }) => ({ pageId: context.pageId, content: context.content }),
        onDone: 'disposed',
        onError: 'disposed',
      },
    },

    disposed: {
      type: 'final',
    },
  },
});

export type PageEditorActor = ActorRefFrom<typeof pageEditorMachine>;
