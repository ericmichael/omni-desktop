import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  FsClient,
  FsListResult,
  TextFileReadResult,
  WatchCallbacks,
  WatchRegistry,
} from '@/renderer/omniagents-ui/rpc/fs';
import type { FileEditorSaveInput, FileEditorWatchEvent } from '@/shared/machines/file-editor.machine';
import { FileEditorSaveConflictError } from '@/shared/machines/file-editor.machine';
import { OmniagentsRpcError } from '@/shared/omniagents-rpc';

import { BinaryFileEditorError, FsFileEditorIO } from './fs-file-editor-io';

const identity = { sessionId: 'session-1', path: 'source/app.ts' } as const;

function textResult(
  content: string,
  sha256: string,
  overrides: Partial<Extract<TextFileReadResult, { kind: 'text' }>> = {}
): Extract<TextFileReadResult, { kind: 'text' }> {
  return {
    kind: 'text',
    path: identity.path,
    size: content.length,
    sha256,
    mime: 'text/typescript',
    mtime: 1,
    text: content,
    encoding: 'utf-8',
    newline: content.includes('\n') ? 'lf' : 'none',
    trailingNewline: content.endsWith('\n'),
    ...overrides,
  };
}

function saveInput(overrides: Partial<FileEditorSaveInput> = {}): FileEditorSaveInput {
  return {
    identity,
    content: 'const value = 2\n',
    expectedVersion: 'a'.repeat(64),
    encoding: 'utf-8-bom',
    newline: 'crlf',
    trailingNewline: true,
    ...overrides,
  };
}

class FakeWatches {
  callbacks: WatchCallbacks | null = null;
  readonly subscribe = vi.fn(async (_path: string, callbacks: WatchCallbacks) => {
    this.callbacks = callbacks;
    return this.unsubscribe;
  });
  readonly unsubscribe = vi.fn(async () => {});
  readonly touch = vi.fn();
}

class RetryingWatches {
  readonly callbacks: WatchCallbacks[] = [];
  readonly disposers: Array<ReturnType<typeof vi.fn>> = [];
  readonly touch = vi.fn();
  failures = 0;
  readonly subscribe = vi.fn(async (_path: string, callbacks: WatchCallbacks) => {
    this.callbacks.push(callbacks);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('watch unavailable');
    }
    const dispose = vi.fn(async () => {});
    this.disposers.push(dispose);
    return dispose;
  });
}

afterEach(() => {
  vi.useRealTimers();
});

function harness(options?: {
  read?: ReturnType<typeof vi.fn>;
  write?: ReturnType<typeof vi.fn>;
  watches?: FakeWatches | RetryingWatches;
}) {
  const read = options?.read ?? vi.fn(async () => textResult('const value = 1\n', '1'.repeat(64)));
  const write = options?.write ?? vi.fn(async () => ({ path: identity.path, size: 17, sha256: '2'.repeat(64) }));
  const watches = options?.watches ?? new FakeWatches();
  const fsClient = { readTextFile: read, writeTextFile: write } as unknown as FsClient;
  return { io: new FsFileEditorIO(fsClient, watches as unknown as WatchRegistry), read, write, watches };
}

describe('FsFileEditorIO', () => {
  it('maps text format and content digest into the editor model', async () => {
    const read = vi.fn(async () =>
      textResult('one\r\ntwo\r\n', 'b'.repeat(64), {
        encoding: 'utf-8-bom',
        newline: 'crlf',
        trailingNewline: true,
      })
    );
    const { io } = harness({ read });

    await expect(io.load(identity)).resolves.toEqual({
      content: 'one\r\ntwo\r\n',
      version: 'b'.repeat(64),
      encoding: 'utf-8-bom',
      newline: 'crlf',
      trailingNewline: true,
    });

    read.mockResolvedValue({ ...textResult('', 'c'.repeat(64)), kind: 'binary', reason: 'nul-byte' } as never);
    await expect(io.load(identity)).rejects.toBeInstanceOf(BinaryFileEditorError);
  });

  it('preserves encoding/newline intent and sends the prior digest as a distinct CAS precondition', async () => {
    const { io, write } = harness();
    const input = saveInput();

    await expect(io.save(input)).resolves.toEqual({
      content: input.content,
      version: '2'.repeat(64),
      encoding: 'utf-8-bom',
      newline: 'crlf',
      trailingNewline: true,
    });
    expect(write).toHaveBeenCalledWith('session-1', 'source/app.ts', input.content, {
      bom: true,
      expectedSha256: input.expectedVersion,
      newline: 'crlf',
      overwrite: true,
    });

    await io.save(saveInput({ expectedVersion: null, encoding: 'utf-8', newline: 'mixed' }));
    expect(write).toHaveBeenLastCalledWith('session-1', 'source/app.ts', expect.any(String), {
      bom: false,
      expectedSha256: undefined,
      newline: undefined,
      overwrite: false,
    });
  });

  it('turns a precondition failure into a conflict containing a fresh disk reread', async () => {
    const disk = textResult('external\n', 'd'.repeat(64));
    const write = vi.fn(async () => {
      throw new OmniagentsRpcError({
        code: -32062,
        message: 'precondition failed',
        data: { kind: 'fs_transfer_invalid', reason: 'precondition_failed' },
      });
    });
    const read = vi.fn(async () => disk);
    const { io } = harness({ read, write });

    const error = await io.save(saveInput()).catch((reason: unknown) => reason);

    expect(read).toHaveBeenCalledWith('session-1', 'source/app.ts');
    expect(error).toBeInstanceOf(FileEditorSaveConflictError);
    expect((error as FileEditorSaveConflictError).diskFile).toEqual({
      content: 'external\n',
      version: 'd'.repeat(64),
      encoding: 'utf-8',
      newline: 'lf',
      trailingNewline: true,
    });
  });

  it('treats target_exists after a reviewed deletion as a fresh CAS conflict', async () => {
    const write = vi.fn(async () => {
      throw new OmniagentsRpcError({
        code: -32062,
        message: 'target exists',
        data: { kind: 'fs_transfer_invalid', reason: 'target_exists' },
      });
    });
    const read = vi.fn(async () => textResult('recreated\n', 'e'.repeat(64)));
    const { io } = harness({ read, write });

    const error = await io.save(saveInput({ expectedVersion: null })).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(FileEditorSaveConflictError);
    expect((error as FileEditorSaveConflictError).diskFile?.version).toBe('e'.repeat(64));
  });

  it('maps parent-directory watch changes, rescans, deletes, and disposal to editor events', async () => {
    const read = vi.fn(async () => textResult('changed\n', 'f'.repeat(64)));
    const watches = new FakeWatches();
    const { io } = harness({ read, watches });
    const events: FileEditorWatchEvent[] = [];
    const dispose = io.watch(identity, (event) => events.push(event));

    expect(watches.subscribe).toHaveBeenCalledWith('source', expect.any(Object));
    watches.callbacks?.onEvents?.([{ type: 'modified', path: 'source/other.ts', entryType: 'file' }]);
    expect(read).not.toHaveBeenCalled();

    watches.callbacks?.onEvents?.([{ type: 'modified', path: identity.path, entryType: 'file' }]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      type: 'EXTERNAL_CHANGE',
      file: { content: 'changed\n', version: 'f'.repeat(64) },
    });

    const present: FsListResult = {
      path: 'source',
      writable: true,
      truncated: false,
      entries: [{ path: identity.path, type: 'file', size: 8, mtime: 2, writable: true }],
    };
    watches.callbacks?.onRescan?.(present, 'reconnect');
    await vi.waitFor(() => expect(events).toHaveLength(2));

    watches.callbacks?.onEvents?.([
      { type: 'deleted', path: identity.path, entryType: 'file' },
      { type: 'created', path: identity.path, entryType: 'file' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'EXTERNAL_DELETE' });
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events.at(-1)).toMatchObject({ type: 'EXTERNAL_CHANGE', file: { version: 'f'.repeat(64) } });

    dispose();
    await vi.waitFor(() => expect(watches.unsubscribe).toHaveBeenCalledOnce());
    watches.callbacks?.onEvents?.([{ type: 'modified', path: identity.path, entryType: 'file' }]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('maps a missing file during conflict reread to a deleted-disk conflict', async () => {
    const write = vi.fn(async () => {
      throw new OmniagentsRpcError({
        code: -32062,
        message: 'precondition failed',
        data: { reason: 'precondition_failed' },
      });
    });
    const read = vi.fn(async () => {
      throw new OmniagentsRpcError({ code: -32061, message: 'not found' });
    });
    const { io } = harness({ read, write });

    const error = await io.save(saveInput()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(FileEditorSaveConflictError);
    expect((error as FileEditorSaveConflictError).diskFile).toBeNull();
  });

  it('handles subscription rejection and retries without leaking an unhandled promise', async () => {
    vi.useFakeTimers();
    const watches = new RetryingWatches();
    watches.failures = 1;
    const { io } = harness({ watches });

    const dispose = io.watch(identity, () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(watches.subscribe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(watches.subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(watches.subscribe).toHaveBeenCalledTimes(2);

    dispose();
    await Promise.resolve();
    expect(watches.disposers[0]).toHaveBeenCalledOnce();
  });

  it('retries when the registry reports a watch installation error', async () => {
    vi.useFakeTimers();
    const watches = new RetryingWatches();
    const { io } = harness({ watches });
    const dispose = io.watch(identity, () => {});
    await Promise.resolve();

    watches.callbacks[0]?.onError?.(new Error('watch install failed'));
    await vi.advanceTimersByTimeAsync(249);
    expect(watches.subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(watches.subscribe).toHaveBeenCalledTimes(2);

    dispose();
  });

  it('backs off eviction retries, touches activity, and cancels pending retry on dispose', async () => {
    vi.useFakeTimers();
    const watches = new RetryingWatches();
    const { io } = harness({ watches });
    const dispose = io.watch(identity, () => {});
    await Promise.resolve();

    watches.callbacks[0]?.onEvicted?.();
    await vi.advanceTimersByTimeAsync(249);
    expect(watches.subscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(watches.subscribe).toHaveBeenCalledTimes(2);

    watches.callbacks[1]?.onEvicted?.();
    await vi.advanceTimersByTimeAsync(499);
    expect(watches.subscribe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(watches.subscribe).toHaveBeenCalledTimes(3);

    watches.callbacks[2]?.onEvents?.([{ type: 'modified', path: 'source/other.ts', entryType: 'file' }]);
    watches.callbacks[2]?.onEvicted?.();
    await vi.advanceTimersByTimeAsync(250);
    expect(watches.subscribe).toHaveBeenCalledTimes(4);
    expect(watches.touch).toHaveBeenCalledWith('source');

    watches.callbacks[3]?.onEvicted?.();
    dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watches.subscribe).toHaveBeenCalledTimes(4);
  });
});
