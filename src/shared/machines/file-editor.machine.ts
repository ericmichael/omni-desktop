/**
 * Explicit-save state machine for one workspace text file.
 *
 * The actor is permanently scoped to one `{ sessionId, path }` identity.
 * Views may come and go, but they never provide a path on edit/save events,
 * which prevents a navigation race from writing one buffer to another file.
 *
 * I/O is injected through `FileEditorIO`. An adapter around `FsClient` can
 * map `load` to `readTextFile`, `save` to `writeTextFile` (passing
 * `expectedVersion` as `expectedSha256`), and `watch` to a parent-directory
 * watch that re-reads this file before emitting `EXTERNAL_CHANGE`.
 */
import { type ActorRefFrom, assign, fromCallback, fromPromise, setup } from 'xstate';

export type FileEditorIdentity = Readonly<{
  sessionId: string;
  path: string;
}>;

export type FileEditorNewline = 'none' | 'lf' | 'crlf' | 'cr' | 'mixed';

export type FileEditorFile = Readonly<{
  content: string;
  /** Opaque content version; the FsClient adapter uses the SHA-256 digest. */
  version: string;
  encoding: 'utf-8' | 'utf-8-bom';
  newline: FileEditorNewline;
  trailingNewline: boolean;
}>;

export type FileEditorSaveInput = Readonly<{
  identity: FileEditorIdentity;
  content: string;
  /** `null` means the client last observed that the file did not exist. */
  expectedVersion: string | null;
  encoding: FileEditorFile['encoding'];
  newline: FileEditorNewline;
  trailingNewline: boolean;
}>;

export type FileEditorWatchEvent = { type: 'EXTERNAL_CHANGE'; file: FileEditorFile } | { type: 'EXTERNAL_DELETE' };

/**
 * Framework-independent adapter contract used by the machine and registry.
 * `watch` must return an idempotent unsubscribe function.
 */
export interface FileEditorIO {
  load(identity: FileEditorIdentity): Promise<FileEditorFile>;
  save(input: FileEditorSaveInput): Promise<FileEditorFile>;
  watch(identity: FileEditorIdentity, emit: (event: FileEditorWatchEvent) => void): () => void;
}

/**
 * A compare-and-swap save found a different disk version. Adapters should
 * re-read the current file and attach it here; `null` means it was deleted.
 */
export class FileEditorSaveConflictError extends Error {
  constructor(
    readonly diskFile: FileEditorFile | null,
    message = 'The file changed on disk before it could be saved'
  ) {
    super(message);
    this.name = 'FileEditorSaveConflictError';
  }
}

export type FileEditorContext = {
  identity: FileEditorIdentity;
  content: string;
  /** Version that `content` was originally based on. */
  baseVersion: string | null;
  encoding: FileEditorFile['encoding'];
  newline: FileEditorNewline;
  trailingNewline: boolean;
  /** Current disk side while resolving a conflict. */
  diskFile: FileEditorFile | null;
  diskDeleted: boolean;
  /** Captured buffer for the in-flight save. */
  savingContent: string | null;
  revision: number;
  error: string | null;
};

export type FileEditorEvent =
  | { type: 'EDIT'; content: string }
  | { type: 'SAVE' }
  | { type: 'RETRY_LOAD' }
  | FileEditorWatchEvent
  | { type: 'USE_DISK' }
  | { type: 'KEEP_LOCAL' }
  | { type: 'DISPOSE' };

const EMPTY_FORMAT = {
  encoding: 'utf-8' as const,
  newline: 'none' as const,
  trailingNewline: false,
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
}

function actorOutput(event: unknown): FileEditorFile {
  return (event as { output: FileEditorFile }).output;
}

function actorError(event: unknown): unknown {
  return (event as { error: unknown }).error;
}

function logicalContent(content: string | null): string | null {
  return content?.replace(/\r\n|\r/g, '\n') ?? null;
}

export function provideFileEditorIO(io: FileEditorIO) {
  return {
    loadFile: fromPromise<FileEditorFile, { identity: FileEditorIdentity }>(({ input }) => io.load(input.identity)),
    saveFile: fromPromise<FileEditorFile, FileEditorSaveInput>(({ input }) => io.save(input)),
    watchFile: fromCallback<FileEditorEvent, { identity: FileEditorIdentity }>(({ input, sendBack }) =>
      io.watch(input.identity, (event) => sendBack(event))
    ),
  };
}

export const fileEditorMachine = setup({
  types: {
    context: {} as FileEditorContext,
    events: {} as FileEditorEvent,
    input: {} as { identity: FileEditorIdentity },
  },
  actors: {
    loadFile: fromPromise<FileEditorFile, { identity: FileEditorIdentity }>(async () => ({
      content: '',
      version: '',
      ...EMPTY_FORMAT,
    })),
    saveFile: fromPromise<FileEditorFile, FileEditorSaveInput>(async ({ input }) => ({
      content: input.content,
      version: input.expectedVersion ?? '',
      encoding: input.encoding,
      newline: input.newline,
      trailingNewline: input.trailingNewline,
    })),
    watchFile: fromCallback<FileEditorEvent, { identity: FileEditorIdentity }>(() => () => {}),
  },
  actions: {
    edit: assign({
      content: ({ event }) => (event as Extract<FileEditorEvent, { type: 'EDIT' }>).content,
      error: null,
    }),
    beginSave: assign({
      savingContent: ({ context }) => context.content,
      error: null,
    }),
    finishSaveClean: assign({
      content: ({ event }) => actorOutput(event).content,
      baseVersion: ({ event }) => actorOutput(event).version,
      encoding: ({ event }) => actorOutput(event).encoding,
      newline: ({ event }) => actorOutput(event).newline,
      trailingNewline: ({ event }) => actorOutput(event).trailingNewline,
      diskDeleted: false,
      savingContent: null,
      error: null,
    }),
    finishSaveWithNewEdits: assign({
      baseVersion: ({ event }) => actorOutput(event).version,
      diskDeleted: false,
      savingContent: null,
      error: null,
    }),
    adoptExternal: assign({
      content: ({ event }) => (event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file.content,
      baseVersion: ({ event }) => (event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file.version,
      encoding: ({ event }) => (event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file.encoding,
      newline: ({ event }) => (event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file.newline,
      trailingNewline: ({ event }) =>
        (event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file.trailingNewline,
      diskFile: null,
      diskDeleted: false,
      savingContent: null,
      revision: ({ context }) => context.revision + 1,
      error: null,
    }),
    adoptMatchingExternal: assign({
      // The bytes changed, but the editor-visible text is logically equal
      // after newline normalization. Advance the CAS base and disk format
      // without replacing CodeMirror's buffer/selection/history.
      baseVersion: ({ event }) => (event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file.version,
      encoding: ({ event }) => (event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file.encoding,
      newline: ({ event }) => (event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file.newline,
      trailingNewline: ({ event }) =>
        (event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file.trailingNewline,
      diskFile: null,
      diskDeleted: false,
      savingContent: null,
      error: null,
    }),
    adoptExternalDelete: assign({
      content: '',
      baseVersion: null,
      diskFile: null,
      diskDeleted: true,
      savingContent: null,
      revision: ({ context }) => context.revision + 1,
      error: null,
    }),
    enterConflictFromChange: assign({
      diskFile: ({ event }) => (event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file,
      diskDeleted: false,
      savingContent: null,
      error: null,
    }),
    enterConflictFromDelete: assign({
      diskFile: null,
      diskDeleted: true,
      savingContent: null,
      error: null,
    }),
    enterConflictFromSave: assign({
      diskFile: ({ event }) => (actorError(event) as FileEditorSaveConflictError).diskFile,
      diskDeleted: ({ event }) => (actorError(event) as FileEditorSaveConflictError).diskFile === null,
      savingContent: null,
      error: ({ event }) => errorMessage(actorError(event), 'save conflict'),
    }),
    useDisk: assign(({ context }) => {
      const disk = context.diskFile;
      return disk
        ? {
            content: disk.content,
            baseVersion: disk.version,
            encoding: disk.encoding,
            newline: disk.newline,
            trailingNewline: disk.trailingNewline,
            diskFile: null,
            diskDeleted: false,
            revision: context.revision + 1,
            error: null,
          }
        : {
            content: '',
            baseVersion: null,
            diskFile: null,
            diskDeleted: true,
            revision: context.revision + 1,
            error: null,
          };
    }),
    keepLocal: assign({
      // Confirmed overwrite is still CAS-safe against the disk version the
      // user just reviewed. If it changes again, save conflicts again.
      baseVersion: ({ context }) => context.diskFile?.version ?? null,
      diskFile: null,
      error: null,
    }),
    setLoadError: assign({
      error: ({ event }) => errorMessage(actorError(event), 'load failed'),
    }),
    setSaveError: assign({
      savingContent: null,
      error: ({ event }) => errorMessage(actorError(event), 'save failed'),
    }),
    clearSaving: assign({ savingContent: null }),
  },
  guards: {
    isSameEdit: ({ context, event }) =>
      (event as Extract<FileEditorEvent, { type: 'EDIT' }>).content === context.content,
    isSameExternal: ({ context, event }) => {
      const file = (event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file;
      return file.version === context.baseVersion;
    },
    externalMatchesLocal: ({ context, event }) =>
      logicalContent((event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file.content) ===
      logicalContent(context.content),
    externalMatchesSaving: ({ context, event }) =>
      logicalContent((event as Extract<FileEditorEvent, { type: 'EXTERNAL_CHANGE' }>).file.content) ===
      logicalContent(context.savingContent),
    savedLatestBuffer: ({ context }) => context.content === context.savingContent,
    isSaveConflict: ({ event }) => actorError(event) instanceof FileEditorSaveConflictError,
  },
}).createMachine({
  id: 'fileEditor',
  initial: 'loading',
  context: ({ input }) => ({
    identity: Object.freeze({ ...input.identity }),
    content: '',
    baseVersion: null,
    ...EMPTY_FORMAT,
    diskFile: null,
    diskDeleted: false,
    savingContent: null,
    revision: 0,
    error: null,
  }),
  // One subscription for the actor's whole lifetime. Keeping it at the
  // machine root avoids tearing down/recreating a parent-directory watch on
  // every clean/dirty/save transition.
  invoke: {
    src: 'watchFile',
    input: ({ context }) => ({ identity: context.identity }),
  },
  states: {
    loading: {
      invoke: {
        src: 'loadFile',
        input: ({ context }) => ({ identity: context.identity }),
        onDone: {
          target: 'clean',
          actions: assign({
            content: ({ event }) => event.output.content,
            baseVersion: ({ event }) => event.output.version,
            encoding: ({ event }) => event.output.encoding,
            newline: ({ event }) => event.output.newline,
            trailingNewline: ({ event }) => event.output.trailingNewline,
            revision: ({ context }) => context.revision + 1,
            error: null,
          }),
        },
        onError: { target: 'loadError', actions: 'setLoadError' },
      },
      on: {
        // The watcher is deliberately active during the initial read. If it
        // wins the race, cancel the stale load result and use the newer disk
        // snapshot rather than dropping the event.
        EXTERNAL_CHANGE: { target: 'clean', actions: 'adoptExternal' },
        EXTERNAL_DELETE: { target: 'clean', actions: 'adoptExternalDelete' },
        DISPOSE: 'disposed',
      },
    },
    loadError: {
      on: {
        RETRY_LOAD: 'loading',
        EXTERNAL_CHANGE: { target: 'clean', actions: 'adoptExternal' },
        EXTERNAL_DELETE: { target: 'clean', actions: 'adoptExternalDelete' },
        DISPOSE: 'disposed',
      },
    },
    clean: {
      on: {
        EDIT: [{ guard: 'isSameEdit' }, { target: 'dirty', actions: 'edit' }],
        SAVE: {},
        EXTERNAL_CHANGE: [{ guard: 'isSameExternal' }, { actions: 'adoptExternal' }],
        EXTERNAL_DELETE: { actions: 'adoptExternalDelete' },
        DISPOSE: 'disposed',
      },
    },
    dirty: {
      on: {
        EDIT: { actions: 'edit' },
        SAVE: { target: 'saving', actions: 'beginSave' },
        EXTERNAL_CHANGE: [
          { guard: 'externalMatchesLocal', target: 'clean', actions: 'adoptMatchingExternal' },
          { target: 'conflict', actions: 'enterConflictFromChange' },
        ],
        EXTERNAL_DELETE: { target: 'conflict', actions: 'enterConflictFromDelete' },
        DISPOSE: 'disposed',
      },
    },
    saving: {
      invoke: {
        src: 'saveFile',
        input: ({ context }) => ({
          identity: context.identity,
          content: context.savingContent ?? context.content,
          expectedVersion: context.baseVersion,
          encoding: context.encoding,
          newline: context.newline,
          trailingNewline: context.trailingNewline,
        }),
        onDone: [
          { guard: 'savedLatestBuffer', target: 'clean', actions: 'finishSaveClean' },
          { target: 'dirty', actions: 'finishSaveWithNewEdits' },
        ],
        onError: [
          { guard: 'isSaveConflict', target: 'conflict', actions: 'enterConflictFromSave' },
          { target: 'saveError', actions: 'setSaveError' },
        ],
      },
      on: {
        EDIT: { actions: 'edit' },
        EXTERNAL_CHANGE: [
          // An own-write echo is not a conflict; the save result supplies
          // the authoritative version when it resolves. Compare with the
          // captured save buffer, not the live buffer: the user may already
          // have typed a newer edit while this write is in flight.
          { guard: 'externalMatchesSaving' },
          { target: 'conflict', actions: 'enterConflictFromChange' },
        ],
        EXTERNAL_DELETE: { target: 'conflict', actions: 'enterConflictFromDelete' },
        DISPOSE: { target: 'disposed', actions: 'clearSaving' },
      },
    },
    saveError: {
      on: {
        EDIT: { target: 'dirty', actions: 'edit' },
        SAVE: { target: 'saving', actions: 'beginSave' },
        EXTERNAL_CHANGE: [
          { guard: 'externalMatchesLocal', target: 'clean', actions: 'adoptMatchingExternal' },
          { target: 'conflict', actions: 'enterConflictFromChange' },
        ],
        EXTERNAL_DELETE: { target: 'conflict', actions: 'enterConflictFromDelete' },
        DISPOSE: 'disposed',
      },
    },
    conflict: {
      on: {
        EXTERNAL_CHANGE: { actions: 'enterConflictFromChange' },
        EXTERNAL_DELETE: { actions: 'enterConflictFromDelete' },
        EDIT: { target: 'dirty', actions: ['edit', 'keepLocal'] },
        USE_DISK: { target: 'clean', actions: 'useDisk' },
        KEEP_LOCAL: { target: 'dirty', actions: 'keepLocal' },
        SAVE: {},
        DISPOSE: 'disposed',
      },
    },
    disposed: { type: 'final' },
  },
});

export type FileEditorActor = ActorRefFrom<typeof fileEditorMachine>;
