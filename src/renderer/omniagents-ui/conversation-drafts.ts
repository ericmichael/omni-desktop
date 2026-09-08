import { atom, map } from 'nanostores';

import { uuidv4 } from '@/lib/uuid';
import type { ExecutionTarget } from '@/shared/types';

import { DraftStorage } from './draft-storage';
import type { ReasoningEffort } from './rpc/model-catalog';

export type ConversationDraft = {
  draftRevision?: string;
  otherDrafts?: Array<{ id: string; text: string; files: File[] }>;
  recoveryRevision?: string;
  text: string;
  files: File[];
  error?: string;
  model?: string;
  reasoning?: ReasoningEffort;
  approvals?: 'user' | 'auto';
  workflow?: 'off' | 'guardian';
  pendingSubmission?: {
    id: string;
    signature: string;
    queued: boolean;
    responseId?: string;
    variables?: Record<string, unknown>;
    executionTarget?: ExecutionTarget;
    stagedContext?: Array<{ source: string; text: string }>;
  };
  pendingInput?: { id?: string; text: string; files: File[] };
};

const empty: ConversationDraft = { text: '', files: [] };
export const conversationDrafts = map<Record<string, ConversationDraft>>({});
const storage = typeof indexedDB === 'undefined' ? undefined : new DraftStorage<ConversationDraft>(indexedDB);
export const draftStorageState = atom<'loading' | 'ready' | 'unavailable'>(storage ? 'loading' : 'ready');
const modified = new Map<string, Partial<ConversationDraft>>();
const writes = new Map<string, Promise<void>>();
const failedWrites = new Map<string, string>();
const revisions = new Map<string, number>();
const unsavedFields = new Map<string, Partial<ConversationDraft>>();
const channel =
  typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'
    ? new window.BroadcastChannel('omni-conversation-drafts-v1')
    : undefined;
export const draftsReady =
  storage
    ?.read()
    .then((rows) => {
      for (const [id, draft] of rows) {
        if (typeof draft?.text === 'string' && Array.isArray(draft.files)) {
          const restored = { ...draft, ...modified.get(id) };
          if (restored.pendingInput && !restored.text && !restored.files.length) {
            restored.text = restored.pendingInput.text;
            restored.files = restored.pendingInput.files;
            restored.pendingInput = undefined;
            restored.error =
              'The previous send was interrupted. Retry to confirm its outcome without sending it twice.';
          }
          conversationDrafts.setKey(id, restored);
        }
      }
      draftStorageState.set('ready');
    })
    .catch(() => {
      draftStorageState.set('unavailable');
    }) ?? Promise.resolve();

export const flushConversationDrafts = (id?: string) =>
  Promise.all(id === undefined ? [...writes.values()] : [writes.get(id)]).then(() => {
    if (id === undefined ? failedWrites.size > 0 : failedWrites.has(id)) {
      throw new Error(id === undefined ? failedWrites.values().next().value : failedWrites.get(id));
    }
  });
export const getConversationDraft = (id: string): ConversationDraft => conversationDrafts.get()[id] ?? empty;
if (channel) {
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data !== 'string' || !storage) {
      return;
    }
    const id = event.data;
    const revision = revisions.get(id);
    void (writes.get(id) ?? draftsReady)
      .then(() => storage.readOne(id))
      .then((draft) => {
        if (draft && revisions.get(id) === revision) {
          // A rejected checkpoint leaves local input unsaved. Adopt the
          // authoritative recovery revision without discarding that input.
          const local = getConversationDraft(id);
          conversationDrafts.setKey(id, {
            ...draft,
            ...unsavedFields.get(id),
            ...(failedWrites.has(id) && unsavedFields.has(id)
              ? { pendingInput: local.pendingInput, error: local.error }
              : {}),
          });
        }
      })
      .catch(() => {});
  };
}
type DraftOwner = { submissionId?: string; inputId?: string; restoreDraftId?: string };
const ownsDraft = (draft: ConversationDraft, owner?: DraftOwner) =>
  (!owner || !('submissionId' in owner) || draft.pendingSubmission?.id === owner.submissionId) &&
  (!owner || !('inputId' in owner) || draft.pendingInput?.id === owner.inputId);

export function updateConversationDraft(id: string, patch: Partial<ConversationDraft>, owner?: DraftOwner) {
  const previous = getConversationDraft(id);
  if (!ownsDraft(previous, owner)) {
    return;
  }
  const recoveryChange = 'pendingSubmission' in patch || 'pendingInput' in patch;
  const contentChange = 'text' in patch || 'files' in patch;
  if (contentChange) {
    // Text and attachments are one intent. A stale text edit must not silently
    // inherit attachments added in another window (or vice versa).
    patch = { text: previous.text, files: previous.files, ...patch, draftRevision: uuidv4() };
  }
  if (recoveryChange) {
    patch = { ...patch, recoveryRevision: uuidv4() };
  }
  const revision = (revisions.get(id) ?? 0) + 1;
  revisions.set(id, revision);
  const { pendingSubmission: _submission, pendingInput: _input, recoveryRevision: _recovery, ...fields } = patch;
  unsavedFields.set(id, { ...unsavedFields.get(id), ...fields });
  modified.set(id, { ...modified.get(id), ...patch });
  const draft = { ...getConversationDraft(id), ...patch };
  if (owner?.restoreDraftId) {
    draft.otherDrafts = (previous.otherDrafts ?? []).filter((copy) => copy.id !== owner.restoreDraftId);
    if (previous.text || previous.files.length) {
      draft.otherDrafts.push({ id: previous.draftRevision ?? uuidv4(), text: previous.text, files: previous.files });
    }
  }
  conversationDrafts.setKey(id, draft);
  if (storage) {
    let savedFields: Partial<ConversationDraft> = {};
    let recoveryConflict = false;
    const write = (writes.get(id) ?? Promise.resolve())
      .then(() => draftsReady)
      .then(() => {
        savedFields = unsavedFields.get(id) ?? {};
        return storage.update(id, (current) => {
          // A late completion may follow a retry/new send in another window.
          // Ownership must be checked in the transaction as well as locally.
          if (!ownsDraft(current ?? empty, owner)) {
            return current ?? empty;
          }
          if (
            owner?.restoreDraftId &&
            (current?.pendingInput ||
              current?.pendingSubmission ||
              !current?.otherDrafts?.some((copy) => copy.id === owner.restoreDraftId))
          ) {
            return current ?? empty;
          }
          if (recoveryChange && current?.recoveryRevision !== previous.recoveryRevision) {
            // Persist the losing intent, but never grant it the winning claim.
            recoveryConflict = true;
            const input = patch.pendingInput ?? previous.pendingInput;
            const copies = new Map((current?.otherDrafts ?? []).map((copy) => [copy.id, copy]));
            if (input) {
              const copyId = previous.draftRevision ?? input.id ?? uuidv4();
              copies.set(copyId, { id: copyId, text: input.text, files: input.files });
            }
            return {
              ...empty,
              ...current,
              otherDrafts: [...copies.values()],
            };
          }
          const others = new Map((current?.otherDrafts ?? []).map((copy) => [copy.id, copy]));
          if (owner?.restoreDraftId) {
            others.delete(owner.restoreDraftId);
          }
          if (
            contentChange &&
            current &&
            (current.text || current.files.length) &&
            (owner?.restoreDraftId || current.draftRevision !== previous.draftRevision)
          ) {
            const copyId = current.draftRevision ?? uuidv4();
            others.set(copyId, { id: copyId, text: current.text, files: current.files });
          }
          return { ...empty, ...current, ...patch, ...savedFields, otherDrafts: [...others.values()] };
        });
      })
      .then((saved) => {
        failedWrites.delete(id);
        if (unsavedFields.get(id) === savedFields) {
          unsavedFields.delete(id);
        }
        if (revisions.get(id) === revision) {
          conversationDrafts.setKey(id, saved);
        }
        channel?.postMessage(id);
        if (recoveryConflict) {
          throw new Error(
            'Another window changed this conversation’s pending message. Your other draft was saved below.'
          );
        }
      })
      .catch((cause: unknown) => {
        failedWrites.set(
          id,
          cause instanceof Error && cause.message.startsWith('Another window')
            ? cause.message
            : 'Message not sent: recovery state could not be saved. Free local storage and retry.'
        );
        conversationDrafts.setKey(id, {
          ...getConversationDraft(id),
          error:
            cause instanceof Error && cause.message.startsWith('Another window')
              ? cause.message
              : 'Your draft is kept in this window, but could not be saved for restart. Check available storage.',
        });
      });
    writes.set(id, write);
  }
}

/** Restore is an explicit swap, not permission to discard the current draft. */
export function restoreOtherConversationDraft(id: string, copyId: string) {
  const draft = getConversationDraft(id);
  if (draft.pendingInput || draft.pendingSubmission) {
    return;
  }
  const copy = draft.otherDrafts?.find((item) => item.id === copyId);
  if (copy) {
    updateConversationDraft(id, { text: copy.text, files: copy.files, error: undefined }, { restoreDraftId: copyId });
  }
}
