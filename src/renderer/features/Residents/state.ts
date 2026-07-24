import { atom } from 'nanostores';

import { toast } from '@/renderer/features/Toast/state';
import { emitter, ipc, wsEmitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type {
  ResidentAgent,
  ResidentAgentInput,
  ResidentAgentRuntime,
  ResidentAgentUpdate,
  ResidentChannelDef,
  ResidentMemoryEntry,
} from '@/shared/types';

/**
 * Agents rail-tab state. Roster + memories + channel log live in the
 * persisted store (mirrored by `persistedStoreApi`); this module holds
 * the live runtime snapshot broadcast on `resident:status` and the
 * tab's selection.
 */

export const $residentStatus = atom<Record<string, ResidentAgentRuntime>>({});

/** Detail-pane selection: an agent, a channel, or (both null) the
 *  all-traffic Activity view. */
export const $residentsView = atom<{ selectedAgentId: string | null; selectedChannel: string | null }>({
  selectedAgentId: null,
  selectedChannel: null,
});

/** Highest message id the user has SEEN, per channel (session-local).
 *  Drives the unread badges on channel/DM rows and the Activity row's
 *  cross-channel total — a per-channel cursor, so reading one channel
 *  never marks another one seen. */
export const $residentSeenByChannel = atom<Record<string, number>>({});

/** Advance the seen cursors for a batch of rendered messages. */
export function markResidentMessagesSeen(messages: ReadonlyArray<{ id: number; channel: string }>): void {
  const seen = $residentSeenByChannel.get();
  let next: Record<string, number> | null = null;
  for (const m of messages) {
    if (m.id > ((next ?? seen)[m.channel] ?? 0)) {
      next = { ...(next ?? seen), [m.channel]: m.id };
    }
  }
  if (next) {
    $residentSeenByChannel.set(next);
  }
}

ipc.on('resident:status', (statuses) => {
  $residentStatus.set(statuses);
});

// Headless-run incidents (declined approvals, failed deliveries/reflections)
// surface as toasts with a jump into the tab — the whole point of the
// attention channel is that a blocked agent must not fail silently.
ipc.on('resident:attention', ({ agentId, message }) => {
  toast.warning('Agent needs attention', message, {
    action: { label: 'Open', onClick: () => goToAgents(agentId) },
  });
});

// Server mode: re-pull the runtime snapshot after a WS reconnect — the
// broadcast that happened while we were away is gone.
wsEmitter?.onConnect(() => {
  void syncResidentStatus();
});

/** Raise the Agents rail tab, optionally landing on a specific agent. */
export function goToAgents(selectedAgentId?: string): void {
  $residentsView.set({ selectedAgentId: selectedAgentId ?? null, selectedChannel: null });
  if (persistedStoreApi.$atom.get().layoutMode !== 'agents') {
    persistedStoreApi.setKey('layoutMode', 'agents');
  }
}

export const residentApi = {
  create: (input: ResidentAgentInput): Promise<ResidentAgent> => emitter.invoke('resident:create', input),
  update: (agentId: string, patch: ResidentAgentUpdate): Promise<ResidentAgent> =>
    emitter.invoke('resident:update', agentId, patch),
  delete: (agentId: string): Promise<void> => emitter.invoke('resident:delete', agentId),
  post: (channel: string, text: string, replyTo?: number): Promise<void> =>
    emitter.invoke('resident:post', channel, text, ...(replyTo !== undefined ? [replyTo] : [])),
  createChannel: (name: string, description?: string): Promise<ResidentChannelDef> =>
    emitter.invoke('resident:create-channel', name, description),
  updateChannel: (channelId: string, patch: { description?: string }): Promise<ResidentChannelDef> =>
    emitter.invoke('resident:update-channel', channelId, patch),
  deleteChannel: (channelId: string): Promise<void> => emitter.invoke('resident:delete-channel', channelId),
  setChannelMembers: (channelId: string, members: string[] | null): Promise<void> =>
    emitter.invoke('resident:set-channel-members', channelId, members),
  wake: (agentId: string): Promise<void> => emitter.invoke('resident:wake', agentId),
  getStatus: (): Promise<Record<string, ResidentAgentRuntime>> => emitter.invoke('resident:get-status'),
  ensureSession: (agentId: string): Promise<{ sessionId: string; uiUrl: string }> =>
    emitter.invoke('resident:ensure-session', agentId),
  setMemories: (agentId: string, memories: ResidentMemoryEntry[]): Promise<void> =>
    emitter.invoke('resident:set-memories', agentId, memories),
};

/** Refresh the runtime snapshot (tab mount / reconnect). */
export async function syncResidentStatus(): Promise<void> {
  try {
    $residentStatus.set(await residentApi.getStatus());
  } catch {
    /* main not ready yet — the broadcast will land shortly */
  }
}
