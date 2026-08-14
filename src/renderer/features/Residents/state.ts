import { atom, computed } from 'nanostores';

import {
  dmParticipants,
  isDirectedAtUser,
  knownHumansFromLog,
  rootAuthors,
  USER_PARTICIPANT,
} from '@/lib/resident-agent';
import { toast } from '@/renderer/features/Toast/state';
import { emitter, ipc, wsEmitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type {
  AgentRuntimeConnection,
  ChatChannel,
  ChatPostMessageParams,
  ResidentAgent,
  ResidentAgentInput,
  ResidentAgentRuntime,
  ResidentAgentUpdate,
  ResidentChannelMessage,
  ResidentMemoryEntry,
} from '@/shared/types';

/**
 * Agents rail-tab state. Roster + memories still ride the persisted store
 * (mirrored by `persistedStoreApi`); channel data is chat-v1's — seeded via
 * `chat.list_messages`/`chat.list_channels` and kept live by the `chat.*`
 * notifications (docs/chat-v1-plan.md). This module also holds the live
 * runtime snapshot broadcast on `resident:status` and the tab's selection.
 */

export const $residentStatus = atom<Record<string, ResidentAgentRuntime>>({});

/** The message log (newest CHAT_LOG_TAIL rows) — chat-v1's live mirror. */
export const $chatLog = atom<ResidentChannelMessage[]>([]);

/** Named channel defs (`kind: 'named'` rows of `chat.list_channels`). */
export const $chatChannels = atom<ChatChannel[]>([]);

/** The caller's stamped participant identity (`chat.hello`): `user` locally,
 *  `human:<principalId>` in teams cloud. Message views compare against it to
 *  render "You" — display is viewer-relative, not stored. */
export const $chatSelf = atom<{ id: string; name: string | null }>({ id: 'user', name: null });

/** Whether a log row was authored by THIS viewer. */
export function isSelfFrom(fromId: string): boolean {
  return fromId === $chatSelf.get().id;
}

/**
 * Whether a DM channel is the viewer's to post into: the collective `user`
 * thread, or their own personal thread. Everything else (agent↔agent, other
 * people's personal threads) is team-visible but observed.
 */
export function isOwnDmChannel(channelId: string): boolean {
  const pair = dmParticipants(channelId);
  return pair !== null && (pair.includes(USER_PARTICIPANT) || pair.includes($chatSelf.get().id));
}

/** Named people seen in the log (id → latest display name) — the same
 *  directory agents resolve `dm(to:)` against, for participant naming. */
export const $knownHumans = computed($chatLog, (log) => knownHumansFromLog(log));

/** Renderer mirror of the manager's log tail — matches CHANNEL_LOG_TAIL. */
const CHAT_LOG_TAIL = 500;

function appendChatMessage(message: ResidentChannelMessage): void {
  const log = $chatLog.get();
  if (log.some((m) => m.id === message.id)) {
    return; // replayed event (reconnect race with the seed fetch)
  }
  const next = [...log, message].sort((a, b) => a.id - b.id);
  $chatLog.set(next.length > CHAT_LOG_TAIL ? next.slice(-CHAT_LOG_TAIL) : next);
}

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
 * the cross-channel total. The log is chat-v1's atom; the seen cursors stay
 * persisted host-store UI state, so the two sources compose here.
 */
export const $residentUnreadByChannel = computed([$chatLog, persistedStoreApi.$atom], (log, store) => {
  const seen = store.residentChannelSeen ?? {};
  const counts: Record<string, number> = {};
  for (const m of log) {
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
 * The subset of unread that is aimed AT the user (see `isDirectedAtUser`):
 * DMs, replies under threads the user rooted, and `#system` incidents.
 *
 * Two projections off one cursor, deliberately: a nav row emboldens on ANY
 * unread (there is something new here) but only carries a count badge when
 * something is directed (this one wants you). Collapsing them into a single
 * number made every ambient agent↔agent exchange read as an item of work.
 */
export const $residentDirectedUnreadByChannel = computed(
  [$chatLog, persistedStoreApi.$atom, $chatSelf],
  (log, store, self) => {
    const seen = store.residentChannelSeen ?? {};
    const authors = rootAuthors(log);
    const rootAuthorOf = (rootId: number): string | undefined => authors.get(rootId);
    const counts: Record<string, number> = {};
    for (const m of log) {
      if (m.id > (seen[m.channel] ?? 0) && isDirectedAtUser(m, rootAuthorOf, self.id)) {
        counts[m.channel] = (counts[m.channel] ?? 0) + 1;
      }
    }
    return counts;
  }
);

export const $activityDirectedUnread = computed($residentDirectedUnreadByChannel, (counts) =>
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

// chat-v1 live feed: appends dedupe by id (the seed fetch and a replayed
// notification may race on reconnect), channel changes patch the def list
// and drop a deleted channel's rows.
ipc.on('chat.message_added', ({ message }) => {
  appendChatMessage(message);
});

ipc.on('chat.channel_changed', ({ channel, deletedId }) => {
  if (deletedId) {
    $chatChannels.set($chatChannels.get().filter((c) => c.id !== deletedId));
    $chatLog.set($chatLog.get().filter((m) => m.channel !== deletedId));
    return;
  }
  if (channel && channel.kind === 'named') {
    const defs = $chatChannels.get();
    const idx = defs.findIndex((c) => c.id === channel.id);
    $chatChannels.set(idx < 0 ? [...defs, channel] : defs.map((c) => (c.id === channel.id ? channel : c)));
  }
});

// Headless-run incidents (declined approvals, failed deliveries/reflections)
// surface as toasts with a jump into the tab — the whole point of the
// attention channel is that a blocked agent must not fail silently.
ipc.on('resident:attention', ({ agentId, message }) => {
  toast.warning('Agent needs attention', message, {
    action: { label: 'Open', onClick: () => goToAgents(agentId) },
  });
});

// Server mode: re-pull runtime + chat state after a WS reconnect — the
// broadcasts that happened while we were away are gone; the durable log is
// the replay substrate (dedupe-by-id absorbs the overlap).
wsEmitter?.onConnect(() => {
  void syncResidentStatus();
  void syncChatState();
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
  delete: async (agentId: string): Promise<void> => {
    await emitter.invoke('resident:delete', agentId);
    // Deletion prunes the agent's DM threads server-side; re-seed rather
    // than replaying the per-channel deletions.
    await syncChatState();
  },
  post: (channel: string, text: string, replyTo?: number): Promise<void> =>
    emitter
      .invoke('chat.post_message', {
        channel,
        text,
        ...(replyTo !== undefined ? { replyTo } : {}),
      } satisfies ChatPostMessageParams)
      .then(() => undefined),
  createChannel: (name: string, description?: string): Promise<ChatChannel> =>
    emitter
      .invoke('chat.create_channel', { name, ...(description !== undefined ? { description } : {}) })
      .then((r) => r.channel),
  updateChannel: (channelId: string, patch: { description?: string }): Promise<ChatChannel> =>
    emitter
      .invoke('chat.update_channel', {
        channelId,
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      })
      .then((r) => r.channel),
  deleteChannel: (channelId: string): Promise<void> =>
    emitter.invoke('chat.delete_channel', { channelId }).then(() => undefined),
  setChannelMembers: (channelId: string, members: string[] | null): Promise<void> =>
    emitter.invoke('chat.set_channel_members', { channelId, members }).then(() => undefined),
  wake: (agentId: string): Promise<void> => emitter.invoke('chat.wake_agent', { agentId }).then(() => undefined),
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

/** Seed (or re-seed) the chat mirror: identity, channels, newest log tail. */
export async function syncChatState(): Promise<void> {
  try {
    const [hello, { channels }, { messages }] = await Promise.all([
      emitter.invoke('chat.hello', {}),
      emitter.invoke('chat.list_channels', {}),
      emitter.invoke('chat.list_messages', { limit: CHAT_LOG_TAIL }),
    ]);
    $chatSelf.set(hello.self);
    $chatChannels.set(channels.filter((c) => c.kind === 'named'));
    $chatLog.set(messages);
  } catch {
    /* main not ready yet — retried on tab mount / reconnect */
  }
}

// Seed once at module load — the sidebar sections render outside the Agents
// tab, so they need the mirror before the tab ever mounts.
void syncChatState();
