import { describe, expect, it, vi } from 'vitest';
import { waitFor } from 'xstate';

import type { FileEditorFile, FileEditorIO, FileEditorWatchEvent } from './file-editor.machine';
import { FileEditorRegistry } from './file-editor-registry';

function file(path: string): FileEditorFile {
  return {
    content: path,
    version: `version:${path}`,
    encoding: 'utf-8',
    newline: 'none',
    trailingNewline: false,
  };
}

function makeIO() {
  const unwatch = vi.fn();
  const io: FileEditorIO = {
    load: vi.fn(async (identity) => file(`${identity.sessionId}:${identity.path}`)),
    save: vi.fn(async (input) => ({ ...file(input.identity.path), content: input.content })),
    watch: vi.fn((_identity, _emit: (event: FileEditorWatchEvent) => void) => unwatch),
  };
  return { io, unwatch };
}

describe('FileEditorRegistry', () => {
  it('shares one actor and watcher for repeated acquisitions of the same identity', async () => {
    const { io, unwatch } = makeIO();
    const registry = new FileEditorRegistry(io);
    const identity = { sessionId: 's1', path: 'src/a.ts' };
    const first = registry.acquire(identity);
    const second = registry.acquire({ ...identity });
    await waitFor(first.actor, (snapshot) => snapshot.matches('clean'));

    expect(second.actor).toBe(first.actor);
    expect(registry.size).toBe(1);
    expect(registry.refCount(identity)).toBe(2);
    expect(io.load).toHaveBeenCalledTimes(1);
    expect(io.watch).toHaveBeenCalledTimes(1);

    first.release();
    first.release();
    expect(registry.refCount(identity)).toBe(1);
    expect(unwatch).not.toHaveBeenCalled();
    second.release();
    expect(registry.size).toBe(0);
    expect(unwatch).toHaveBeenCalledTimes(1);
  });

  it('isolates identical paths in different sessions and distinct paths in one session', async () => {
    const { io } = makeIO();
    const registry = new FileEditorRegistry(io);
    const leases = [
      registry.acquire({ sessionId: 's1', path: 'src/a.ts' }),
      registry.acquire({ sessionId: 's2', path: 'src/a.ts' }),
      registry.acquire({ sessionId: 's1', path: 'src/b.ts' }),
    ];
    await Promise.all(leases.map((lease) => waitFor(lease.actor, (snapshot) => snapshot.matches('clean'))));

    expect(new Set(leases.map((lease) => lease.actor)).size).toBe(3);
    expect(registry.size).toBe(3);
    expect(leases.map((lease) => lease.actor.getSnapshot().context.content)).toEqual([
      's1:src/a.ts',
      's2:src/a.ts',
      's1:src/b.ts',
    ]);
    for (const lease of leases) {
      lease.release();
    }
  });

  it('disposes all actors, rejects new acquisitions, and never writes dirty buffers', async () => {
    const { io, unwatch } = makeIO();
    const registry = new FileEditorRegistry(io);
    const lease = registry.acquire({ sessionId: 's1', path: 'a.ts' });
    await waitFor(lease.actor, (snapshot) => snapshot.matches('clean'));
    lease.actor.send({ type: 'EDIT', content: 'unsaved' });

    registry.dispose();
    registry.dispose();
    expect(registry.size).toBe(0);
    expect(io.save).not.toHaveBeenCalled();
    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(() => registry.acquire({ sessionId: 's1', path: 'b.ts' })).toThrow('disposed');
    lease.release();
  });
});
