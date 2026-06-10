/**
 * IPC handler registration for the inbox surface.
 *
 * Takes a `resolve(event)` callback (see registerMilestoneHandlers) so the same
 * registration serves the single-manager Electron app and the per-tenant
 * server. Returns the channel names registered for cleanup.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InboxManager } from '@/main/inbox-manager';
import type { IIpcListener } from '@/shared/ipc-listener';

export function registerInboxHandlers(ipc: IIpcListener, resolve: (event: unknown) => InboxManager): string[] {
  const channels: string[] = [];
  const h = (ch: string, fn: (m: InboxManager, ...args: any[]) => unknown): void => {
    ipc.handle(ch, (event: unknown, ...args: any[]) => fn(resolve(event), ...args));
    channels.push(ch);
  };

  h('inbox:get-all', (m) => m.getAll());
  h('inbox:get-active', (m) => m.getActive());
  h('inbox:add', (m, input) => m.add(input));
  h('inbox:update', (m, id, patch) => m.update(id, patch));
  h('inbox:remove', (m, id) => m.remove(id));
  h('inbox:defer', (m, id) => m.defer(id));
  h('inbox:reactivate', (m, id) => m.reactivate(id));
  h('inbox:promote-to-ticket', (m, id, opts) => m.promoteToTicket(id, opts));
  h('inbox:promote-to-project', (m, id, opts) => m.promoteToProject(id, opts));
  h('inbox:sweep', (m) => m.sweepExpired());
  h('inbox:gc-promoted', (m) => m.gcPromoted());

  return channels;
}
