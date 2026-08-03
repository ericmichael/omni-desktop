import { atom, computed } from 'nanostores';

import { toast } from '@/renderer/features/Toast/state';
import { emitter, ipc, wsEmitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type {
  AgentRuntimeConnection,
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

/** Detail-pane selection: an agent, a channel, the team handbook, the
 *  agent roster/directory, the Routines surface, the new-agent form, or
 *  (all unset) the all-traffic Activity view. Every surface is derivable
 *  from this atom so the app sidebar can paint selection. */
export const $residentsView = atom<{
  selectedAgentId: string | null;
  selectedChannel: string | null;
  showHandbook?: boolean;
  showRoster?: boolean;
  showRoutines?: boolean;
  showNewAgent?: boolean;
}>({
  selectedAgentId: null,
  selectedChannel: null,
});

/** Raise the Agents surface for the current view (idempotent). */
function raiseAgentsTab(): void {
  if (persistedStoreApi.$atom.get().layoutMode !== 'agents') {
    persistedStoreApi.setKey('layoutMode', 'agents');
  }
}

/** Open a channel or DM thread feed. */
export function goToResidentChannel(channelId: string): void {
  $residentsView.set({ selectedAgentId: null, selectedChannel: channelId });
  raiseAgentsTab();
}

/** Open the all-traffic Activity feed. */
export function goToActivity(): void {
  $residentsView.set({ selectedAgentId: null, selectedChannel: null });
  raiseAgentsTab();
}

/** Open the agent roster/directory. */
export function goToRoster(): void {
  $residentsView.set({ selectedAgentId: null, selectedChannel: null, showRoster: true });
  raiseAgentsTab();
}

/** Open the team handbook. */
export function goToHandbook(): void {
  $residentsView.set({ selectedAgentId: null, selectedChannel: null, showHandbook: true });
  raiseAgentsTab();
}

/** Open the new-agent form. */
export function goToNewAgent(): void {
  $residentsView.set({ selectedAgentId: null, selectedChannel: null, showNewAgent: true });
  raiseAgentsTab();
}

/**
 * Per-channel unread counts (messages past that channel's seen cursor) and
 * the cross-channel total. Derived from the persisted store so the app
 * sidebar, the Agents tab, and the sections all read one source.
 */
export const $residentUnreadByChannel = computed(persistedStoreApi.$atom, (store) => {
  const seen = store.residentChannelSeen ?? {};
  const counts: Record<string, number> = {};
  for (const m of store.residentChannels ?? []) {
    if (m.id > (seen[m.channel] ?? 0)) {
      counts[m.channel] = (counts[m.channel] ?? 0) + 1;
    }
  }
  return counts;
});

export const $activityUnread = computed($residentUnreadByChannel, (counts) =>
  Object.values(counts).reduce((sum, n) => sum + n, 0)
);

/**
 * Seen cursors (highest message id the user has SEEN, per channel) live in
 * the persisted store (`residentChannelSeen`) so unread badges survive
 * restarts. Store writes round-trip through main before the atom updates,
 * so rapid mark calls merge into this local advance-only cache first —
 * a later call can never regress a cursor a pending write already raised.
 */
let seenCache: Record<string, number> | null = null;

/** Advance the seen cursors for a batch of rendered messages. */
export function markResidentMessagesSeen(messages: ReadonlyArray<{ id: number; channel: string }>): void {
  const stored = persistedStoreApi.getKey('residentChannelSeen') ?? {};
  // Element-wise max of the store and the cache: another window may have
  // advanced a channel we haven't, and vice versa.
  const base: Record<string, number> = { ...stored };
  for (const [ch, id] of Object.entries(seenCache ?? {})) {
    if (id > (base[ch] ?? 0)) {
      base[ch] = id;
    }
  }
  let next: Record<string, number> | null = null;
  for (const m of messages) {
    if (m.id > ((next ?? base)[m.channel] ?? 0)) {
      next = { ...(next ?? base), [m.channel]: m.id };
    }
  }
  if (next) {
    seenCache = next;
    void persistedStoreApi.setKey('residentChannelSeen', next);
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
  ensureSession: (agentId: string): Promise<{ sessionId: string; connection: AgentRuntimeConnection }> =>
    emitter.invoke('resident:ensure-session', agentId),
  setMemories: (agentId: string, memories: ResidentMemoryEntry[]): Promise<void> =>
    emitter.invoke('resident:set-memories', agentId, memories),
  getHandbook: (): Promise<{ body: string; updatedAt: number; updatedBy: string | null } | null> =>
    emitter.invoke('resident:get-handbook'),
  setHandbook: (body: string): Promise<void> => emitter.invoke('resident:set-handbook', body),
};

/** Refresh the runtime snapshot (tab mount / reconnect). */
export async function syncResidentStatus(): Promise<void> {
  try {
    $residentStatus.set(await residentApi.getStatus());
  } catch {
    /* main not ready yet — the broadcast will land shortly */
  }
}
