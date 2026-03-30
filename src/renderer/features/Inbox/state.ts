import { atom, map } from 'nanostores';

import { emitter } from '@/renderer/services/ipc';
import type { InboxItem, InboxItemId } from '@/shared/types';

/** Whether the quick-capture overlay is open. */
export const $quickCaptureOpen = atom(false);

export const openQuickCapture = (): void => {
  $quickCaptureOpen.set(true);
};

/**
 * All inbox items, keyed by item ID.
 */
export const $inboxItems = map<Record<InboxItemId, InboxItem>>({});

export const inboxApi = {
  addItem: async (item: Omit<InboxItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<InboxItem> => {
    const created = await emitter.invoke('inbox:add-item', item);
    $inboxItems.setKey(created.id, created);
    return created;
  },
  updateItem: async (id: InboxItemId, patch: Partial<Omit<InboxItem, 'id' | 'createdAt'>>): Promise<void> => {
    await emitter.invoke('inbox:update-item', id, patch);
    const existing = $inboxItems.get()[id];
    if (existing) {
      $inboxItems.setKey(id, { ...existing, ...patch, updatedAt: Date.now() });
    }
  },
  removeItem: async (id: InboxItemId): Promise<void> => {
    await emitter.invoke('inbox:remove-item', id);
    const current = { ...$inboxItems.get() };
    delete current[id];
    $inboxItems.set(current);
  },
  fetchItems: async (): Promise<void> => {
    const items = await emitter.invoke('inbox:get-items');
    const newMap: Record<InboxItemId, InboxItem> = {};
    for (const item of items) {
      newMap[item.id] = item;
    }
    $inboxItems.set(newMap);
  },
};

// Hydrate on import
void inboxApi.fetchItems();
