import { map } from 'nanostores';

import { emitter } from '@/renderer/services/ipc';
import type { Milestone, MilestoneId, ProjectId } from '@/shared/types';

/**
 * Milestones keyed by ID. Accumulates across projects — the sidebar tree and
 * the dashboard both need to render multiple projects' milestones at once.
 */
export const $milestones = map<Record<MilestoneId, Milestone>>({});

export const milestoneApi = {
  fetchMilestones: async (projectId: ProjectId): Promise<void> => {
    const items = await emitter.invoke('milestone:get-items', projectId);
    // Merge: replace this project's milestones, keep others untouched so
    // expanding another project in the tree doesn't wipe this one.
    const current = $milestones.get();
    const next: Record<MilestoneId, Milestone> = {};
    for (const [id, milestone] of Object.entries(current)) {
      if (milestone.projectId !== projectId) {
next[id] = milestone;
}
    }
    for (const item of items) {
      next[item.id] = item;
    }
    $milestones.set(next);
  },

  addMilestone: async (
    input: Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Milestone> => {
    const created = await emitter.invoke('milestone:add-item', input);
    $milestones.setKey(created.id, created);
    return created;
  },

  updateMilestone: async (
    id: MilestoneId,
    patch: Partial<Omit<Milestone, 'id' | 'projectId' | 'createdAt'>>
  ): Promise<void> => {
    await emitter.invoke('milestone:update-item', id, patch);
    const existing = $milestones.get()[id];
    if (existing) {
      $milestones.setKey(id, { ...existing, ...patch, updatedAt: Date.now() });
    }
  },

  removeMilestone: async (id: MilestoneId): Promise<void> => {
    await emitter.invoke('milestone:remove-item', id);
    const current = { ...$milestones.get() };
    delete current[id];
    $milestones.set(current);
  },
};