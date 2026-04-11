import { map } from 'nanostores';

import { ipc } from '@/renderer/services/ipc';
import type { WorkspaceSyncStatus } from '@/shared/types';

/**
 * Per-project workspace sync status, keyed by projectId.
 * Updated in real-time via IPC from main process.
 */
export const $syncStatuses = map<Record<string, WorkspaceSyncStatus>>({});

// Listen for status pushes from the main process
ipc.on('workspace-sync:status-changed', (projectId: string, status: WorkspaceSyncStatus) => {
  if (status.state === 'stopped') {
    // Remove stopped projects from the map
    const current = { ...$syncStatuses.get() };
    delete current[projectId];
    $syncStatuses.set(current);
  } else {
    $syncStatuses.setKey(projectId, status);
  }
});
