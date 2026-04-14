/**
 * IPC handler registration for the milestone surface.
 *
 * Extracted from `createProjectManager` (Sprint C4). Returns the list of
 * channel names registered so the caller can clean them up at shutdown.
 */
import type { MilestoneManager } from '@/main/milestone-manager';
import type { IIpcListener } from '@/shared/ipc-listener';

export function registerMilestoneHandlers(ipc: IIpcListener, milestones: MilestoneManager): string[] {
  ipc.handle('milestone:get-items', (_, projectId) => milestones.getByProject(projectId));
  ipc.handle('milestone:add-item', (_, item) => milestones.add(item));
  ipc.handle('milestone:update-item', (_, id, patch) => milestones.update(id, patch));
  ipc.handle('milestone:remove-item', (_, id) => milestones.remove(id));

  return ['milestone:get-items', 'milestone:add-item', 'milestone:update-item', 'milestone:remove-item'];
}
