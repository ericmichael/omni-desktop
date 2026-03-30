import { map } from 'nanostores';

import { emitter } from '@/renderer/services/ipc';
import type { Initiative, InitiativeId, ProjectId } from '@/shared/types';

/**
 * All initiatives for the currently viewed project, keyed by initiative ID.
 */
export const $initiatives = map<Record<InitiativeId, Initiative>>({});

export const initiativeApi = {
  fetchInitiatives: async (projectId: ProjectId): Promise<void> => {
    const items = await emitter.invoke('initiative:get-items', projectId);
    const newMap: Record<InitiativeId, Initiative> = {};
    for (const item of items) {
      newMap[item.id] = item;
    }
    $initiatives.set(newMap);
  },

  addInitiative: async (
    input: Omit<Initiative, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Initiative> => {
    const created = await emitter.invoke('initiative:add-item', input);
    $initiatives.setKey(created.id, created);
    return created;
  },

  updateInitiative: async (
    id: InitiativeId,
    patch: Partial<Omit<Initiative, 'id' | 'projectId' | 'createdAt'>>
  ): Promise<void> => {
    await emitter.invoke('initiative:update-item', id, patch);
    const existing = $initiatives.get()[id];
    if (existing) {
      $initiatives.setKey(id, { ...existing, ...patch, updatedAt: Date.now() });
    }
  },

  removeInitiative: async (id: InitiativeId): Promise<void> => {
    await emitter.invoke('initiative:remove-item', id);
    const current = { ...$initiatives.get() };
    delete current[id];
    $initiatives.set(current);
  },
};

/** Get the default initiative for a project from the current store. */
export const getDefaultInitiative = (projectId: ProjectId): Initiative | undefined => {
  return Object.values($initiatives.get()).find((i) => i.projectId === projectId && i.isDefault);
};
