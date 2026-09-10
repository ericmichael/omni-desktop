import { atom, map } from 'nanostores';

import { DraftStorage } from './draft-storage';
import type { ReasoningEffort } from './rpc/model-catalog';

/**
 * Per-conversation composer state that outlives the composer: unsent text and
 * attachments, and pre-launch model choices. Nothing about in-flight sends
 * lives here; a send either completes or its text comes back to the box.
 *
 * Persistence is best effort and invisible: IndexedDB in this origin/profile,
 * last write wins, and a storage failure keeps the in-memory draft and says
 * nothing. The user never sees anything about drafts as a concept.
 */
export type ConversationDraft = {
  text: string;
  files: File[];
  model?: string;
  reasoning?: ReasoningEffort;
  approvals?: 'user' | 'auto';
  workflow?: 'off' | 'guardian';
};

const empty: ConversationDraft = { text: '', files: [] };
export const conversationDrafts = map<Record<string, ConversationDraft>>({});
const storage = typeof indexedDB === 'undefined' ? undefined : new DraftStorage<ConversationDraft>(indexedDB);
/** `loading` only until the first read settles; the composer waits for it so
 * restored text is not clobbered by an empty first render. */
export const draftStorageState = atom<'loading' | 'ready'>(storage ? 'loading' : 'ready');
const modified = new Map<string, Partial<ConversationDraft>>();
const writes = new Map<string, Promise<void>>();
/** Fields changed since the last successful write; a failed write keeps them
 * so the next write carries them too. */
const unsaved = new Map<string, Partial<ConversationDraft>>();

type StoredDraft = ConversationDraft & { pendingInput?: { text: string; files: File[] }; error?: string };

export const draftsReady =
  storage
    ?.read()
    .then((rows) => {
      for (const [id, stored] of rows) {
        const draft = stored as StoredDraft | undefined;
        if (typeof draft?.text !== 'string' || !Array.isArray(draft.files)) {
          continue;
        }
        // Rows written by earlier builds carried the interrupted send
        // separately; fold it back into the box.
        const { pendingInput, error: _error, ...rest } = draft;
        const restored: ConversationDraft = pendingInput
          ? {
              ...rest,
              text: [pendingInput.text, rest.text].filter(Boolean).join('\n\n'),
              files: [...(pendingInput.files ?? []), ...rest.files],
            }
          : rest;
        conversationDrafts.setKey(id, { ...restored, ...modified.get(id) });
      }
    })
    .catch(() => {})
    .finally(() => {
      draftStorageState.set('ready');
    }) ?? Promise.resolve();

/** Wait for outstanding writes. Never rejects: persistence is best effort. */
export const flushConversationDrafts = (id?: string): Promise<void> =>
  Promise.all(id === undefined ? [...writes.values()] : [writes.get(id)]).then(() => undefined);

export const getConversationDraft = (id: string): ConversationDraft => conversationDrafts.get()[id] ?? empty;

/** Merge `patch` into the conversation's draft. */
export function updateConversationDraft(id: string, patch: Partial<ConversationDraft>) {
  const previous = getConversationDraft(id);
  modified.set(id, { ...modified.get(id), ...patch });
  unsaved.set(id, { ...unsaved.get(id), ...patch });
  conversationDrafts.setKey(id, { ...previous, ...patch });
  if (!storage) {
    return;
  }
  const write = (writes.get(id) ?? Promise.resolve())
    .then(() => draftsReady)
    .then(() => {
      const fields = unsaved.get(id) ?? {};
      return storage
        .update(id, (current) => ({ ...empty, ...current, ...fields }))
        .then(() => {
          if (unsaved.get(id) === fields) {
            unsaved.delete(id);
          }
        });
    })
    .catch(() => {});
  writes.set(id, write);
}
