/** Ref-counted registry of editor actors keyed by exact session + file path. */
import { createActor } from 'xstate';

import {
  type FileEditorActor,
  type FileEditorIdentity,
  type FileEditorIO,
  fileEditorMachine,
  provideFileEditorIO,
} from './file-editor.machine';

type Entry = {
  actor: FileEditorActor;
  refs: number;
};

export type FileEditorLease = Readonly<{
  actor: FileEditorActor;
  /** Idempotently release this acquisition. */
  release(): void;
}>;

function identityKey(identity: FileEditorIdentity): string {
  // JSON tuple avoids delimiter collisions between arbitrary session ids and
  // otherwise-valid paths.
  return JSON.stringify([identity.sessionId, identity.path]);
}

export class FileEditorRegistry {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(private readonly io: FileEditorIO) {}

  get size(): number {
    return this.entries.size;
  }

  acquire(identity: FileEditorIdentity): FileEditorLease {
    if (this.disposed) {
      throw new Error('FileEditorRegistry is disposed');
    }
    const key = identityKey(identity);
    let entry = this.entries.get(key);
    if (entry) {
      entry.refs += 1;
    } else {
      const actor = createActor(fileEditorMachine.provide({ actors: provideFileEditorIO(this.io) }), {
        input: { identity },
      });
      actor.start();
      entry = { actor, refs: 1 };
      this.entries.set(key, entry);
    }

    const acquiredEntry = entry;
    let released = false;
    return Object.freeze({
      actor: acquiredEntry.actor,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.releaseEntry(key, acquiredEntry);
      },
    });
  }

  refCount(identity: FileEditorIdentity): number {
    return this.entries.get(identityKey(identity))?.refs ?? 0;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.actor.send({ type: 'DISPOSE' });
      entry.actor.stop();
    }
    this.entries.clear();
  }

  private releaseEntry(key: string, expected: Entry): void {
    const current = this.entries.get(key);
    // A stale lease can never release a newer actor for the same identity.
    if (current !== expected) {
      return;
    }
    current.refs -= 1;
    if (current.refs > 0) {
      return;
    }
    this.entries.delete(key);
    current.actor.send({ type: 'DISPOSE' });
    current.actor.stop();
  }
}
