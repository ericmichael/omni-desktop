import { describe, expect, it, vi } from 'vitest';
import { createActor, waitFor } from 'xstate';

import {
  type FileEditorFile,
  type FileEditorIO,
  fileEditorMachine,
  FileEditorSaveConflictError,
  type FileEditorSaveInput,
  type FileEditorWatchEvent,
  provideFileEditorIO,
} from './file-editor.machine';

const IDENTITY = { sessionId: 'session-a', path: 'src/app.ts' } as const;

function file(content: string, version: string): FileEditorFile {
  return {
    content,
    version,
    encoding: 'utf-8',
    newline: 'lf',
    trailingNewline: content.endsWith('\n'),
  };
}

type IOOverrides = {
  load?: FileEditorIO['load'];
  save?: FileEditorIO['save'];
};

function harness(overrides: IOOverrides = {}) {
  let emit: ((event: FileEditorWatchEvent) => void) | null = null;
  const unwatch = vi.fn();
  const io: FileEditorIO = {
    load: overrides.load ?? (async () => file('disk\n', 'v1')),
    save:
      overrides.save ??
      (async (input) => ({
        content: input.content,
        version: 'v2',
        encoding: input.encoding,
        newline: input.newline,
        trailingNewline: input.trailingNewline,
      })),
    watch: (_identity, callback) => {
      emit = callback;
      return unwatch;
    },
  };
  const actor = createActor(fileEditorMachine.provide({ actors: provideFileEditorIO(io) }), {
    input: { identity: IDENTITY },
  });
  actor.start();
  return {
    actor,
    emit(event: FileEditorWatchEvent) {
      if (!emit) {
        throw new Error('watch has not started');
      }
      emit(event);
    },
    unwatch,
  };
}

async function loaded(actor: ReturnType<typeof harness>['actor']) {
  await waitFor(actor, (snapshot) => snapshot.matches('clean'));
}

describe('fileEditorMachine', () => {
  it('loads one immutable file identity and exposes its disk format', async () => {
    const load = vi.fn(async () => ({
      ...file('hello\r\n', 'sha-one'),
      encoding: 'utf-8-bom' as const,
      newline: 'crlf' as const,
    }));
    const { actor } = harness({ load });
    await loaded(actor);

    expect(load).toHaveBeenCalledWith(IDENTITY);
    expect(actor.getSnapshot().context).toMatchObject({
      identity: IDENTITY,
      content: 'hello\r\n',
      baseVersion: 'sha-one',
      encoding: 'utf-8-bom',
      newline: 'crlf',
      trailingNewline: true,
    });
    expect(Object.isFrozen(actor.getSnapshot().context.identity)).toBe(true);
    actor.stop();
  });

  it('surfaces load failure and retries only when requested', async () => {
    let attempt = 0;
    const load = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('offline');
      }
      return file('recovered', 'v1');
    });
    const { actor } = harness({ load });
    await waitFor(actor, (snapshot) => snapshot.matches('loadError'));
    expect(actor.getSnapshot().context.error).toBe('offline');
    expect(load).toHaveBeenCalledTimes(1);

    actor.send({ type: 'RETRY_LOAD' });
    await loaded(actor);
    expect(load).toHaveBeenCalledTimes(2);
    expect(actor.getSnapshot().context.content).toBe('recovered');
    actor.stop();
  });

  it('does not let a slow initial read overwrite a newer watch event', async () => {
    let finishLoad: ((value: FileEditorFile) => void) | undefined;
    const { actor, emit } = harness({
      load: () =>
        new Promise<FileEditorFile>((resolve) => {
          finishLoad = resolve;
        }),
    });
    emit({ type: 'EXTERNAL_CHANGE', file: file('newer', 'v2') });
    expect(actor.getSnapshot().matches('clean')).toBe(true);
    finishLoad?.(file('stale', 'v1'));
    await Promise.resolve();
    expect(actor.getSnapshot().context).toMatchObject({ content: 'newer', baseVersion: 'v2' });
    actor.stop();
  });

  it('keeps edits dirty indefinitely and saves only after explicit SAVE', async () => {
    const save = vi.fn(async (input: FileEditorSaveInput) => file(input.content, 'v2'));
    const { actor } = harness({ save });
    await loaded(actor);
    actor.send({ type: 'EDIT', content: 'local\n' });

    expect(actor.getSnapshot().matches('dirty')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(save).not.toHaveBeenCalled();

    actor.send({ type: 'SAVE' });
    await loaded(actor);
    expect(save).toHaveBeenCalledWith({
      identity: IDENTITY,
      content: 'local\n',
      expectedVersion: 'v1',
      encoding: 'utf-8',
      newline: 'lf',
      trailingNewline: true,
    });
    expect(actor.getSnapshot().context.baseVersion).toBe('v2');
    actor.stop();
  });

  it('retains edits made during a save, ignores its watch echo, and advances their CAS base', async () => {
    let finishSave: ((value: FileEditorFile) => void) | undefined;
    const save = vi.fn(
      (input: FileEditorSaveInput) =>
        new Promise<FileEditorFile>((resolve) => {
          finishSave = resolve;
          expect(input.content).toBe('first');
        })
    );
    const { actor, emit } = harness({ save });
    await loaded(actor);
    actor.send({ type: 'EDIT', content: 'first' });
    actor.send({ type: 'SAVE' });
    actor.send({ type: 'EDIT', content: 'second' });
    emit({ type: 'EXTERNAL_CHANGE', file: file('first', 'v2') });
    expect(actor.getSnapshot().matches('saving')).toBe(true);
    finishSave?.(file('first', 'v2'));
    await waitFor(actor, (snapshot) => snapshot.matches('dirty'));

    expect(actor.getSnapshot().context.content).toBe('second');
    expect(actor.getSnapshot().context.baseVersion).toBe('v2');
    actor.stop();
  });

  it('surfaces ordinary save errors and permits an explicit retry', async () => {
    let attempt = 0;
    const save = vi.fn(async (input: FileEditorSaveInput) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('disk full');
      }
      return file(input.content, 'v2');
    });
    const { actor } = harness({ save });
    await loaded(actor);
    actor.send({ type: 'EDIT', content: 'local' });
    actor.send({ type: 'SAVE' });
    await waitFor(actor, (snapshot) => snapshot.matches('saveError'));
    expect(actor.getSnapshot().context.error).toBe('disk full');
    expect(save).toHaveBeenCalledTimes(1);

    actor.send({ type: 'SAVE' });
    await loaded(actor);
    expect(save).toHaveBeenCalledTimes(2);
    actor.stop();
  });

  it('silently reloads clean files but conflicts without replacing a dirty buffer', async () => {
    const { actor, emit } = harness();
    await loaded(actor);
    const revision = actor.getSnapshot().context.revision;
    emit({ type: 'EXTERNAL_CHANGE', file: file('disk two', 'v2') });
    expect(actor.getSnapshot().context).toMatchObject({ content: 'disk two', baseVersion: 'v2' });
    expect(actor.getSnapshot().context.revision).toBe(revision + 1);

    actor.send({ type: 'EDIT', content: 'my buffer' });
    emit({ type: 'EXTERNAL_CHANGE', file: file('disk three', 'v3') });
    expect(actor.getSnapshot().matches('conflict')).toBe(true);
    expect(actor.getSnapshot().context.content).toBe('my buffer');
    expect(actor.getSnapshot().context.diskFile).toEqual(file('disk three', 'v3'));
    actor.stop();
  });

  it('ignores a same-version CRLF watch echo without replacing the LF editor buffer', async () => {
    const { actor, emit } = harness();
    await loaded(actor);
    const revision = actor.getSnapshot().context.revision;
    emit({
      type: 'EXTERNAL_CHANGE',
      file: { ...file('disk\r\n', 'v1'), newline: 'crlf' },
    });

    expect(actor.getSnapshot().matches('clean')).toBe(true);
    expect(actor.getSnapshot().context).toMatchObject({
      content: 'disk\n',
      baseVersion: 'v1',
      newline: 'lf',
      diskDeleted: false,
      revision,
    });
    actor.stop();
  });

  it('treats LF and CRLF dirty buffers as logically equal without replacing local text', async () => {
    const { actor, emit } = harness();
    await loaded(actor);
    const revision = actor.getSnapshot().context.revision;
    actor.send({ type: 'EDIT', content: 'same\n' });
    emit({
      type: 'EXTERNAL_CHANGE',
      file: { ...file('same\r\n', 'v-external'), newline: 'crlf' },
    });

    expect(actor.getSnapshot().matches('clean')).toBe(true);
    expect(actor.getSnapshot().context).toMatchObject({
      content: 'same\n',
      baseVersion: 'v-external',
      newline: 'crlf',
      diskDeleted: false,
      revision,
    });
    actor.stop();
  });

  it('treats an external body matching the dirty buffer as clean', async () => {
    const { actor, emit } = harness();
    await loaded(actor);
    actor.send({ type: 'EDIT', content: 'same body' });
    emit({ type: 'EXTERNAL_CHANGE', file: file('same body', 'v-external') });

    expect(actor.getSnapshot().matches('clean')).toBe(true);
    expect(actor.getSnapshot().context.baseVersion).toBe('v-external');
    actor.stop();
  });

  it('supports use-disk and keep-local conflict resolution with a fresh CAS base', async () => {
    const saves: FileEditorSaveInput[] = [];
    const { actor, emit } = harness({
      save: async (input) => {
        saves.push(input);
        return file(input.content, 'v4');
      },
    });
    await loaded(actor);
    actor.send({ type: 'EDIT', content: 'local' });
    emit({ type: 'EXTERNAL_CHANGE', file: file('external', 'v3') });
    actor.send({ type: 'KEEP_LOCAL' });
    actor.send({ type: 'SAVE' });
    await loaded(actor);
    expect(saves[0]?.expectedVersion).toBe('v3');
    expect(actor.getSnapshot().context.content).toBe('local');

    actor.send({ type: 'EDIT', content: 'another local' });
    emit({ type: 'EXTERNAL_CHANGE', file: file('use this', 'v5') });
    actor.send({ type: 'USE_DISK' });
    expect(actor.getSnapshot().matches('clean')).toBe(true);
    expect(actor.getSnapshot().context).toMatchObject({
      content: 'use this',
      baseVersion: 'v5',
      diskDeleted: false,
    });
    actor.stop();
  });

  it('keeps clean external deletion visible and use-disk preserves the deleted state', async () => {
    const { actor, emit } = harness();
    await loaded(actor);
    emit({ type: 'EXTERNAL_DELETE' });
    expect(actor.getSnapshot().matches('clean')).toBe(true);
    expect(actor.getSnapshot().context).toMatchObject({
      content: '',
      baseVersion: null,
      diskDeleted: true,
    });

    actor.send({ type: 'EDIT', content: 'local after delete' });
    // A second delete while dirty enters the resolution flow.
    emit({ type: 'EXTERNAL_DELETE' });
    expect(actor.getSnapshot().matches('conflict')).toBe(true);
    actor.send({ type: 'USE_DISK' });
    expect(actor.getSnapshot().matches('clean')).toBe(true);
    expect(actor.getSnapshot().context).toMatchObject({
      content: '',
      baseVersion: null,
      diskDeleted: true,
    });
    actor.stop();
  });

  it('turns a CAS save failure into a conflict and requires resolution', async () => {
    const save = vi.fn(async () => {
      throw new FileEditorSaveConflictError(file('new disk', 'v2'));
    });
    const { actor } = harness({ save });
    await loaded(actor);
    actor.send({ type: 'EDIT', content: 'local' });
    actor.send({ type: 'SAVE' });
    await waitFor(actor, (snapshot) => snapshot.matches('conflict'));

    expect(actor.getSnapshot().context.content).toBe('local');
    expect(actor.getSnapshot().context.diskFile).toEqual(file('new disk', 'v2'));
    expect(actor.getSnapshot().context.error).toContain('changed on disk');
    actor.stop();
  });

  it('represents external deletion and recreates only after keep-local plus SAVE', async () => {
    const save = vi.fn(async (input: FileEditorSaveInput) => file(input.content, 'created'));
    const { actor, emit } = harness({ save });
    await loaded(actor);
    actor.send({ type: 'EDIT', content: 'keep me' });
    emit({ type: 'EXTERNAL_DELETE' });
    expect(actor.getSnapshot().matches('conflict')).toBe(true);
    expect(actor.getSnapshot().context.diskDeleted).toBe(true);

    actor.send({ type: 'KEEP_LOCAL' });
    expect(actor.getSnapshot().context.diskDeleted).toBe(true);
    actor.send({ type: 'SAVE' });
    await loaded(actor);
    expect(save.mock.calls[0]?.[0].expectedVersion).toBeNull();
    expect(actor.getSnapshot().context.diskDeleted).toBe(false);
    actor.stop();
  });

  it('disposes dirty state without an implicit save and cleans up the watch', async () => {
    const save = vi.fn(async (input: FileEditorSaveInput) => file(input.content, 'v2'));
    const { actor, unwatch } = harness({ save });
    await loaded(actor);
    actor.send({ type: 'EDIT', content: 'unsaved' });
    actor.send({ type: 'DISPOSE' });

    expect(actor.getSnapshot().matches('disposed')).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(unwatch).toHaveBeenCalledTimes(1);
    actor.stop();
  });
});
