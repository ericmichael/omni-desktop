/**
 * Tests for snapshot-manager's Sandboxes-tab surface — the snapshot listing
 * (`sandbox:list-snapshots`) and the in-use guard on `snapshot:delete`.
 *
 * Uses tmpdir tar fixtures and the injected dir/claims seams — zero vi.mock.
 */
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  archivedLabelsFromConversations,
  listSnapshots,
  protectedSessionsFromTabs,
  registerSnapshotHandlers,
  type SnapshotHandlerDeps,
} from '@/main/snapshot-manager';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { CodeTab } from '@/shared/types';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'snapshot-manager-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeTar = (sessionId: string, bytes: number, mtimeSec: number): void => {
  const file = path.join(dir, `${sessionId}.tar`);
  writeFileSync(file, Buffer.alloc(bytes));
  utimesSync(file, mtimeSec, mtimeSec);
};

const makeDeps = (over: Partial<SnapshotHandlerDeps> = {}): SnapshotHandlerDeps => ({
  getProtectedSessions: () => [],
  getArchivedLabels: () => [],
  dir,
  ...over,
});

/** Capture handlers off a fake listener so channel behavior is testable. */
const captureHandlers = (deps: SnapshotHandlerDeps): Map<string, (event: unknown, ...args: unknown[]) => unknown> => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IIpcListener = { handle: (channel, handler) => handlers.set(channel, handler) };
  registerSnapshotHandlers(ipc, deps);
  return handlers;
};

describe('listSnapshots', () => {
  it('lists tar files with size and mtime, newest first, ignoring other entries', async () => {
    writeTar('sess-old', 10, 1_000);
    writeTar('sess-new', 20, 2_000);
    writeFileSync(path.join(dir, 'not-a-snapshot.txt'), 'x');
    const result = await listSnapshots(makeDeps());
    expect(result).toEqual([
      { sessionId: 'sess-new', sizeBytes: 20, modifiedAt: 2_000_000, inUse: false, label: null },
      { sessionId: 'sess-old', sizeBytes: 10, modifiedAt: 1_000_000, inUse: false, label: null },
    ]);
  });

  it('returns an empty list when the snapshots dir does not exist yet', async () => {
    await expect(listSnapshots(makeDeps({ dir: path.join(dir, 'missing') }))).resolves.toEqual([]);
  });

  it('marks protected sessions inUse with the tab label; archived titles label without protecting', async () => {
    writeTar('sess-open', 1, 3_000);
    writeTar('sess-archived', 1, 2_000);
    writeTar('sess-stray', 1, 1_000);
    const result = await listSnapshots(
      makeDeps({
        getProtectedSessions: () => [{ sessionId: 'sess-open', label: 'Fix the login bug' }],
        getArchivedLabels: () => [{ sessionId: 'sess-archived', label: 'How do I center a div' }],
      })
    );
    expect(result.map(({ sessionId, inUse, label }) => ({ sessionId, inUse, label }))).toEqual([
      { sessionId: 'sess-open', inUse: true, label: 'Fix the login bug' },
      { sessionId: 'sess-archived', inUse: false, label: 'How do I center a div' },
      { sessionId: 'sess-stray', inUse: false, label: null },
    ]);
  });
});

describe('claim helpers', () => {
  const tab = (over: Partial<CodeTab>): CodeTab => ({ id: 'tab-1', projectId: null, createdAt: 0, ...over });

  it('protectedSessionsFromTabs mirrors the gc keep set: every tab sessionId, labeled', () => {
    expect(
      protectedSessionsFromTabs([
        tab({ id: 'a', sessionId: 'sess-1', ticketTitle: 'Fix bug' }),
        tab({ id: 'b' }), // no sessionId → no claim
        tab({ id: 'c', sessionId: 'sess-2' }),
      ])
    ).toEqual([
      { sessionId: 'sess-1', label: 'Fix bug' },
      { sessionId: 'sess-2', label: 'Chat' },
    ]);
  });

  it('archivedLabelsFromConversations maps titles, nulling empty ones', () => {
    expect(
      archivedLabelsFromConversations([
        { sessionId: 'sess-1', title: 'A chat', lastActiveAt: 0 },
        { sessionId: 'sess-2', title: '', lastActiveAt: 0 },
      ])
    ).toEqual([
      { sessionId: 'sess-1', label: 'A chat' },
      { sessionId: 'sess-2', label: null },
    ]);
  });
});

describe('snapshot:delete guard', () => {
  it('refuses a protected session, naming the owner, leaving the tar in place', async () => {
    writeTar('sess-open', 1, 1_000);
    const handlers = captureHandlers(
      makeDeps({ getProtectedSessions: () => [{ sessionId: 'sess-open', label: 'Fix the login bug' }] })
    );
    await expect(handlers.get('snapshot:delete')!(null, 'sess-open')).rejects.toThrow(
      'Snapshot is in use by an open session: Fix the login bug'
    );
    expect(existsSync(path.join(dir, 'sess-open.tar'))).toBe(true);
  });

  it('falls back to the session id when the protected claim has no label', async () => {
    writeTar('sess-open', 1, 1_000);
    const handlers = captureHandlers(
      makeDeps({ getProtectedSessions: () => [{ sessionId: 'sess-open', label: null }] })
    );
    await expect(handlers.get('snapshot:delete')!(null, 'sess-open')).rejects.toThrow(/sess-open/);
  });

  it('deletes an unprotected session (the post-close cascade path)', async () => {
    // The tab-close cascade persists the pruned codeTabs BEFORE invoking the
    // delete, so the closed tab's session is no longer in the protected set.
    writeTar('sess-closed', 1, 1_000);
    const handlers = captureHandlers(
      makeDeps({ getProtectedSessions: () => [{ sessionId: 'sess-other', label: 'Still open' }] })
    );
    await handlers.get('snapshot:delete')!(null, 'sess-closed');
    expect(existsSync(path.join(dir, 'sess-closed.tar'))).toBe(false);
  });

  it('registers the listing channel alongside the delete', async () => {
    writeTar('sess-1', 5, 1_000);
    const handlers = captureHandlers(makeDeps());
    await expect(handlers.get('sandbox:list-snapshots')!(null)).resolves.toEqual([
      { sessionId: 'sess-1', sizeBytes: 5, modifiedAt: 1_000_000, inUse: false, label: null },
    ]);
  });
});
