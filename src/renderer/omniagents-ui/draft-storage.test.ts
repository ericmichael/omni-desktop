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

it('reads one conversation without walking the whole store', async () => {
  const storage = new DraftStorage(new IDBFactory());
  await storage.write('A', { files: [new Blob(['A bytes'])] });
  await storage.write('B', { text: 'B' });
  const cursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
  expect(await storage.readOne('B')).toEqual({ text: 'B' });
  expect(await storage.readOne('missing')).toBeUndefined();
  expect(cursor).not.toHaveBeenCalled();
});

it('keeps the in-memory draft and stays silent when a write fails', async () => {
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
  const file = new File(['retained bytes'], 'retained.txt', { type: 'text/plain' });
  drafts.updateConversationDraft('A', { text: 'keep me', files: [file] });
  drafts.updateConversationDraft('B', { text: 'small' });
  await expect(drafts.flushConversationDrafts('A')).resolves.toBeUndefined();
  await expect(drafts.flushConversationDrafts()).resolves.toBeUndefined();
  expect(drafts.getConversationDraft('A')).toMatchObject({ text: 'keep me', files: [file] });
  const rows = new Map(await new DraftStorage(indexedDB).read());
  expect(rows.has('A')).toBe(false);
  expect(rows.has('B')).toBe(true);
  put.mockRestore();
  drafts.updateConversationDraft('A', { text: 'can save now' });
  await drafts.flushConversationDrafts('A');
  const saved = new Map(await new DraftStorage<any>(indexedDB).read()).get('A');
  expect(saved.text).toBe('can save now');
  expect(await saved.files[0].text()).toBe('retained bytes');
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

it('last write wins between two module instances, without side channels', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  const a = await import('./conversation-drafts');
  await a.draftsReady;
  vi.resetModules();
  const b = await import('./conversation-drafts');
  await b.draftsReady;
  a.updateConversationDraft('shared', { text: 'A draft', files: [new File(['A bytes'], 'A.txt')] });
  await a.flushConversationDrafts('shared');
  b.updateConversationDraft('shared', { text: 'B draft' });
  await b.flushConversationDrafts('shared');
  const saved: any = await new DraftStorage(indexedDB).readOne('shared');
  expect(saved.text).toBe('B draft');
  expect(saved).not.toHaveProperty('otherDrafts');
  // A field the other instance never touched survives the merge.
  expect(await saved.files[0].text()).toBe('A bytes');
});

it('folds a row written by an earlier build back into the text box', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  await new DraftStorage<any>(indexedDB).write('legacy', {
    text: 'typed after',
    files: [],
    pendingInput: { id: 'old', text: 'interrupted send', files: [] },
    error: 'The previous send was interrupted.',
    otherDrafts: [{ id: 'x', text: 'other window', files: [] }],
  });
  const drafts = await import('./conversation-drafts');
  await drafts.draftsReady;
  const draft: any = drafts.getConversationDraft('legacy');
  expect(draft.text).toBe('interrupted send\n\ntyped after');
  expect(draft.pendingInput).toBeUndefined();
  expect(draft.error).toBeUndefined();
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
