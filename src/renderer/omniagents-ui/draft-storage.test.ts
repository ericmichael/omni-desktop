// @vitest-environment node
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';

import { DraftStorage } from './draft-storage';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('retries a transient database-open failure without reloading the app', async () => {
  const factory = new IDBFactory();
  const open = factory.open.bind(factory);
  vi.spyOn(factory, 'open')
    .mockImplementationOnce(() => {
      const request = { error: new Error('temporary failure'), onerror: null as any };
      queueMicrotask(() => request.onerror?.());
      return request as unknown as IDBOpenDBRequest;
    })
    .mockImplementation(open);
  const storage = new DraftStorage(factory);
  await expect(storage.read()).rejects.toThrow('temporary failure');
  await storage.write('retry', { text: 'retained' });
  expect(await storage.readOne('retry')).toEqual({ text: 'retained' });
});

it('reads only the changed conversation when fetching a broadcast update', async () => {
  const storage = new DraftStorage(new IDBFactory());
  await storage.write('A', { files: [new Blob(['A bytes'])] });
  await storage.write('B', { text: 'B' });
  const cursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
  expect(await storage.readOne('B')).toEqual({ text: 'B' });
  expect(await storage.readOne('missing')).toBeUndefined();
  expect(cursor).not.toHaveBeenCalled();
});

it('does not let another conversation mask a failed checkpoint or block a healthy one', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  const drafts = await import('./conversation-drafts');
  await drafts.draftsReady;
  const original = IDBObjectStore.prototype.put;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (key === 'A') {
      throw new Error('quota exceeded');
    }
    return original.call(this, value, key);
  });
  drafts.updateConversationDraft('A', { text: 'must persist' });
  drafts.updateConversationDraft('B', { text: 'small' });
  await drafts.flushConversationDrafts('B');
  await expect(drafts.flushConversationDrafts('A')).rejects.toThrow('recovery state could not be saved');
  await expect(drafts.flushConversationDrafts()).rejects.toThrow();
  const rows = new Map(await new DraftStorage(indexedDB).read());
  expect(rows.has('A')).toBe(false);
  expect(rows.has('B')).toBe(true);
  put.mockRestore();
  drafts.updateConversationDraft('A', { text: 'retry save' });
  await expect(drafts.flushConversationDrafts('A')).resolves.toBeUndefined();
});

it('waits for restored model and approval choices before preparing the session', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  const { DraftStorage: Storage } = await import('./draft-storage');
  await new Storage(indexedDB).write('A', { text: 'saved', files: [], model: 'chosen', approvals: 'user' });
  let restore!: (rows: any) => void;
  vi.spyOn(Storage.prototype, 'read').mockImplementation(
    () =>
      new Promise((resolve) => {
        restore = resolve;
      })
  );
  const drafts = await import('./conversation-drafts');
  const { prepareConversation } = await import('./prepare-conversation');
  const client = {
    request: vi.fn(async () => ({
      ok: true,
      session_id: 'A',
      model: 'chosen',
      label: 'Chosen',
      provider: 'test',
      max_input_tokens: 100,
      max_output_tokens: 10,
      reasoning_effort: null,
      warnings: [],
    })),
    setSessionApprovals: vi.fn(async () => ({ ok: true })),
  };
  const preparing = prepareConversation(client as any, 'A');
  await Promise.resolve();
  expect(client.request).not.toHaveBeenCalled();
  restore([['A', { text: 'saved', files: [], model: 'chosen', approvals: 'user' }]]);
  await preparing;
  expect(client.request).toHaveBeenCalledWith('set_session_model', { session_id: 'A', model: 'chosen' });
  expect(client.setSessionApprovals).toHaveBeenCalledWith('A', 'user');
  expect(drafts.getConversationDraft('A').text).toBe('saved');
  await drafts.flushConversationDrafts();
});

it('merges stale-window edits without erasing another window’s pending submission', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  const first = await import('./conversation-drafts');
  await first.draftsReady;
  first.updateConversationDraft('shared', { text: 'original', files: [] });
  await first.flushConversationDrafts('shared');
  vi.resetModules();
  const second = await import('./conversation-drafts');
  await second.draftsReady;
  first.updateConversationDraft('shared', {
    text: '',
    pendingInput: { text: 'original', files: [] },
    pendingSubmission: { id: 'accepted', signature: 'original', queued: false },
  });
  await first.flushConversationDrafts('shared');
  second.updateConversationDraft('shared', { text: 'follow-up in another window' });
  await second.flushConversationDrafts('shared');
  vi.resetModules();
  const restarted = await import('./conversation-drafts');
  await restarted.draftsReady;
  expect(restarted.getConversationDraft('shared')).toMatchObject({
    text: 'follow-up in another window',
    pendingSubmission: { id: 'accepted' },
    pendingInput: { text: 'original' },
  });
});

it('ignores stale completion inside the transaction even without a broadcast', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  const first = await import('./conversation-drafts');
  await first.draftsReady;
  first.updateConversationDraft('shared', {
    pendingInput: { id: 'old-input', text: 'old', files: [] },
    pendingSubmission: { id: 'old', signature: 'old', queued: false },
  });
  await first.flushConversationDrafts('shared');
  vi.resetModules();
  const second = await import('./conversation-drafts');
  await second.draftsReady;
  second.updateConversationDraft('shared', {
    text: 'follow-up',
    pendingInput: { id: 'new-input', text: 'new', files: [] },
    pendingSubmission: { id: 'new', signature: 'new', queued: false },
  });
  await second.flushConversationDrafts('shared');
  first.updateConversationDraft(
    'shared',
    { pendingInput: undefined, pendingSubmission: undefined },
    { submissionId: 'old' }
  );
  await expect(first.flushConversationDrafts('shared')).resolves.toBeUndefined();
  expect(await new DraftStorage(indexedDB).readOne('shared')).toMatchObject({
    text: 'follow-up',
    pendingInput: { id: 'new-input', text: 'new' },
    pendingSubmission: { id: 'new' },
  });
});

it('preserves both independently edited drafts durably', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  const a = await import('./conversation-drafts');
  await a.draftsReady;
  vi.resetModules();
  const b = await import('./conversation-drafts');
  await b.draftsReady;
  a.updateConversationDraft('conflict', { text: 'A draft', files: [new File(['A bytes'], 'A.txt')] });
  await a.flushConversationDrafts('conflict');
  b.updateConversationDraft('conflict', { text: 'B draft' });
  await b.flushConversationDrafts('conflict');
  const saved: any = await new DraftStorage(indexedDB).readOne('conflict');
  expect(saved.text).toBe('B draft');
  expect(saved.files).toEqual([]);
  expect(await saved.otherDrafts[0].files[0].text()).toBe('A bytes');
  expect(saved.otherDrafts).toEqual([expect.objectContaining({ text: 'A draft' })]);
  b.restoreOtherConversationDraft('conflict', saved.otherDrafts[0].id);
  await b.flushConversationDrafts('conflict');
  const restored: any = await new DraftStorage(indexedDB).readOne('conflict');
  expect(restored.text).toBe('A draft');
  expect(restored.otherDrafts).toEqual([expect.objectContaining({ text: 'B draft' })]);
});

it('rejects competing recovery claims from stale windows atomically', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  const first = await import('./conversation-drafts');
  await first.draftsReady;
  vi.resetModules();
  const second = await import('./conversation-drafts');
  await second.draftsReady;
  first.updateConversationDraft('race', { pendingInput: { text: 'first', files: [] } });
  second.updateConversationDraft('race', { pendingInput: { text: 'second', files: [] } });
  const results = await Promise.allSettled([
    first.flushConversationDrafts('race'),
    second.flushConversationDrafts('race'),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const saved = new Map(await new DraftStorage<any>(indexedDB).read()).get('race');
  expect(saved.pendingInput.text).toBe('first');
  expect(saved.otherDrafts).toEqual([expect.objectContaining({ text: 'second' })]);
  expect(second.getConversationDraft('race').pendingInput?.text).toBe('first');
});

it('restores the same interrupted submission identity after a module restart', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  const first = await import('./conversation-drafts');
  await first.draftsReady;
  first.updateConversationDraft('A', {
    text: '',
    files: [],
    model: 'chosen',
    pendingInput: { text: 'original', files: [] },
    pendingSubmission: {
      id: 'same-key',
      signature: 'original',
      queued: false,
      stagedContext: [{ source: 'selection', text: 'saved code' }],
    },
  });
  await first.flushConversationDrafts();
  vi.resetModules();
  const second = await import('./conversation-drafts');
  await second.draftsReady;
  expect(second.getConversationDraft('A')).toMatchObject({
    text: 'original',
    model: 'chosen',
    pendingSubmission: { id: 'same-key', stagedContext: [{ source: 'selection', text: 'saved code' }] },
  });
  expect(second.getConversationDraft('A').pendingInput).toBeUndefined();
});

it('keeps drafts and refuses a durable send checkpoint when storage is full', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  const drafts = await import('./conversation-drafts');
  await drafts.draftsReady;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
    throw new Error('Quota exceeded');
  });
  const file = new File(['retained bytes'], 'retained.txt', { type: 'text/plain' });
  drafts.updateConversationDraft('A', { text: 'keep me', files: [file] });
  await expect(drafts.flushConversationDrafts()).rejects.toThrow('recovery state could not be saved');
  expect(drafts.getConversationDraft('A').text).toBe('keep me');
  put.mockRestore();
  drafts.updateConversationDraft('A', { text: 'can save now' });
  await expect(drafts.flushConversationDrafts()).resolves.toBeUndefined();
  const saved = new Map(await new DraftStorage<any>(indexedDB).read()).get('A');
  expect(await saved.files[0].text()).toBe('retained bytes');
});

it('restores draft text, model choices and attachment bytes in a new storage instance', async () => {
  const factory = new IDBFactory();
  const first = new DraftStorage<any>(factory);
  await first.write('A', {
    text: 'unsent',
    model: 'selected',
    files: [new Blob(['file bytes'], { type: 'text/plain' })],
  });
  await first.write('B', { text: 'other', files: [] });
  const restored = new Map(await new DraftStorage<any>(factory).read());
  expect(restored.get('A').text).toBe('unsent');
  expect(restored.get('A').model).toBe('selected');
  expect(await restored.get('A').files[0].text()).toBe('file bytes');
  expect(restored.get('B').text).toBe('other');
  await first.write('A', { text: '', files: [] });
  expect(new Map(await new DraftStorage<any>(factory).read()).get('A').files).toEqual([]);
});
