/**
 * IPC handler registration for the inbox surface.
 *
 * Extracted from `createProjectManager` (Sprint C4). Returns the list of
 * channel names registered so the caller can clean them up at shutdown.
 */
import type { InboxManager } from '@/main/inbox-manager';
import type { IIpcListener } from '@/shared/ipc-listener';

export function registerInboxHandlers(ipc: IIpcListener, inbox: InboxManager): string[] {
  ipc.handle('inbox:get-all', () => inbox.getAll());
  ipc.handle('inbox:get-active', () => inbox.getActive());
  ipc.handle('inbox:add', (_, input) => inbox.add(input));
  ipc.handle('inbox:update', (_, id, patch) => inbox.update(id, patch));
  ipc.handle('inbox:remove', (_, id) => inbox.remove(id));
  ipc.handle('inbox:shape', (_, id, shaping) => inbox.shape(id, shaping));
  ipc.handle('inbox:defer', (_, id) => inbox.defer(id));
  ipc.handle('inbox:reactivate', (_, id) => inbox.reactivate(id));
  ipc.handle('inbox:promote-to-ticket', (_, id, opts) => inbox.promoteToTicket(id, opts));
  ipc.handle('inbox:promote-to-project', (_, id, opts) => inbox.promoteToProject(id, opts));
  ipc.handle('inbox:sweep', () => inbox.sweepExpired());
  ipc.handle('inbox:gc-promoted', () => inbox.gcPromoted());

  return [
    'inbox:get-all',
    'inbox:get-active',
    'inbox:add',
    'inbox:update',
    'inbox:remove',
    'inbox:shape',
    'inbox:defer',
    'inbox:reactivate',
    'inbox:promote-to-ticket',
    'inbox:promote-to-project',
    'inbox:sweep',
    'inbox:gc-promoted',
  ];
}
