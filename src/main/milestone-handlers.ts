/**
 * IPC handler registration for the milestone surface.
 *
 * Takes a `resolve(event)` callback rather than a manager instance so the same
 * registration serves both the single-manager Electron app (`() => mgr`) and
 * the per-tenant server (`event => registry.get(event.tenantId)…`). Returns the
 * channel names registered for cleanup.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { MilestoneManager } from '@/main/milestone-manager';
import type { IIpcListener } from '@/shared/ipc-listener';

export function registerMilestoneHandlers(ipc: IIpcListener, resolve: (event: unknown) => MilestoneManager): string[] {
  const channels: string[] = [];
  const h = (ch: string, fn: (m: MilestoneManager, ...args: any[]) => unknown): void => {
    ipc.handle(ch, (event: unknown, ...args: any[]) => fn(resolve(event), ...args));
    channels.push(ch);
  };

  h('milestone:get-items', (m, projectId) => m.getByProject(projectId));
  h('milestone:add-item', (m, item) => m.add(item));
  h('milestone:update-item', (m, id, patch) => m.update(id, patch));
  h('milestone:remove-item', (m, id) => m.remove(id));

  return channels;
}
