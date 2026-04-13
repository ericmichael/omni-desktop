import { computed } from 'nanostores';

import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type {
  InboxItem,
  InboxItemId,
  InboxShaping,
  MilestoneId,
  ProjectId,
  Ticket,
} from '@/shared/types';

/**
 * Inbox state. Derived directly from `persistedStoreApi.$atom` so it stays
 * in sync with every `store:changed` broadcast from main — no separate
 * hydration step, no optimistic write layer that can drift from the source
 * of truth. Mutations go through IPC, main updates the store, and the new
 * state flows back through `store:changed` to update every consumer.
 */
export const $inboxItems = computed(persistedStoreApi.$atom, (store) => {
  const out: Record<InboxItemId, InboxItem> = {};
  for (const item of store.inboxItems ?? []) out[item.id] = item;
  return out;
});

/** Active view: still shapeable/actionable (hides later + promoted). */
export const $activeInbox = computed($inboxItems, (items) =>
  Object.values(items).filter((i) => i.status !== 'later' && !i.promotedTo)
);

/** Deferred items (hides promoted). */
export const $laterInbox = computed($inboxItems, (items) =>
  Object.values(items).filter((i) => i.status === 'later' && !i.promotedTo)
);

/** Promoted tombstones — what this item became. */
export const $promotedInbox = computed($inboxItems, (items) =>
  Object.values(items).filter((i) => !!i.promotedTo)
);

/** Count for the sidebar badge. Only counts actionable items. */
export const $activeInboxCount = computed($activeInbox, (items) => items.length);

// ---------------------------------------------------------------------------
// IPC wrapper — thin pass-through. Mutations persist in the main store and
// the renderer atom rehydrates automatically via `store:changed`.
// ---------------------------------------------------------------------------

export const inboxApi = {
  add: (input: {
    title: string;
    note?: string;
    projectId?: ProjectId | null;
    attachments?: string[];
  }): Promise<InboxItem> => emitter.invoke('inbox:add', input),

  update: (
    id: InboxItemId,
    patch: Partial<Pick<InboxItem, 'title' | 'note' | 'projectId' | 'attachments'>>
  ): Promise<void> => emitter.invoke('inbox:update', id, patch),

  remove: (id: InboxItemId): Promise<void> => emitter.invoke('inbox:remove', id),

  shape: (id: InboxItemId, shaping: InboxShaping): Promise<void> =>
    emitter.invoke('inbox:shape', id, shaping),

  defer: (id: InboxItemId): Promise<void> => emitter.invoke('inbox:defer', id),

  reactivate: (id: InboxItemId): Promise<void> => emitter.invoke('inbox:reactivate', id),

  promoteToTicket: (
    id: InboxItemId,
    opts: { projectId: ProjectId; milestoneId?: MilestoneId; columnId?: string }
  ): Promise<Ticket> => emitter.invoke('inbox:promote-to-ticket', id, opts),

  promoteToProject: (id: InboxItemId, opts: { label: string }) =>
    emitter.invoke('inbox:promote-to-project', id, opts),

  sweep: (): Promise<number> => emitter.invoke('inbox:sweep'),

  gcPromoted: (): Promise<number> => emitter.invoke('inbox:gc-promoted'),
};
