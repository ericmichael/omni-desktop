/**
 * chat-v1 — the participant-facing messaging service (docs/chat-v1-plan.md).
 *
 * A thin facade over ResidentAgentManager: it maps the manager's state and
 * mutations onto the chat-v1 method map (src/shared/types.ts §chat-v1) and
 * stamps the caller's participant identity onto writes. Both bindings call
 * through here — the internal IPC binding via {@link registerChatHandlers}
 * (channel names ARE the wire method names) and the public /ws/chat
 * JSON-RPC endpoint (src/server/chat-ws.ts). The manager stays the single
 * delivery engine: `post_message` is the only write, and the manager alone
 * decides who wakes.
 */

import type { ResidentAgentManager } from '@/main/resident-agent-manager';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { ChatHello, ChatMethodMap, ChatPostMessageParams } from '@/shared/types';

/**
 * The caller's stamped identity: `user` (the collective local human),
 * `human:<principalId>` (a named cloud team member), with `bridge` marking
 * a /ws/chat bridge-scope connection (the only scope allowed to post as an
 * `ext:*` external user). Identity comes from authentication, never from
 * the request payload.
 */
export type ChatPoster = { id: string; name: string | null; bridge?: boolean };

/**
 * Poster identity from the handler `event` slot. Electron main passes an
 * IpcMainInvokeEvent (no tenant fields) → the collective `user`. Server
 * mode passes the per-invoke HandlerContext: in single-user mode the
 * principal IS the tenant → still `user`; in teams/cloud the EasyAuth
 * principal is a distinct identity → `human:<principalId>`. (Read
 * structurally so main/ never imports server/ types.)
 */
export const posterFromEvent = (event: unknown): ChatPoster => {
  const ctx = event as { tenantId?: unknown; principalId?: unknown; displayName?: unknown } | null | undefined;
  if (
    ctx &&
    typeof ctx === 'object' &&
    typeof ctx.tenantId === 'string' &&
    typeof ctx.principalId === 'string' &&
    ctx.principalId !== ctx.tenantId
  ) {
    return {
      id: `human:${ctx.principalId}`,
      name: typeof ctx.displayName === 'string' && ctx.displayName.trim() ? ctx.displayName : null,
    };
  }
  return { id: 'user', name: null };
};

export class ChatService {
  constructor(private readonly manager: ResidentAgentManager) {}

  hello(poster: ChatPoster): ChatHello {
    return { protocol: 'chat-v1', self: { id: poster.id, name: poster.name }, capabilities: [] };
  }

  listChannels(): ChatMethodMap['chat.list_channels']['result'] {
    return { channels: this.manager.listChatChannels() };
  }

  listMessages(
    params: ChatMethodMap['chat.list_messages']['params']
  ): Promise<ChatMethodMap['chat.list_messages']['result']> {
    return this.manager.listMessages(params ?? {});
  }

  postMessage(poster: ChatPoster, params: ChatPostMessageParams): ChatMethodMap['chat.post_message']['result'] {
    let identity: { id: string; name: string | null } = poster;
    if (params.asExternal) {
      // Bridge relays only: a bridge always says who spoke; nobody else may.
      if (!poster.bridge) {
        throw new Error('asExternal requires bridge scope.');
      }
      const { network, id, displayName } = params.asExternal;
      if (!network.trim() || !id.trim() || !displayName.trim()) {
        throw new Error('asExternal needs network, id, and displayName.');
      }
      identity = { id: `ext:${network.trim()}:${id.trim()}`, name: displayName.trim() };
    } else if (poster.bridge) {
      throw new Error('Bridge connections must post asExternal — a bridge always says who spoke.');
    }
    return { message: this.manager.post(params.channel, params.text, params.replyTo, identity) };
  }

  createChannel(
    params: ChatMethodMap['chat.create_channel']['params']
  ): ChatMethodMap['chat.create_channel']['result'] {
    const def = this.manager.createChannel(params.name, params.description);
    return { channel: this.channelById(def.id) };
  }

  updateChannel(
    params: ChatMethodMap['chat.update_channel']['params']
  ): ChatMethodMap['chat.update_channel']['result'] {
    const def = this.manager.updateChannel(params.channelId, {
      ...(params.description !== undefined ? { description: params.description } : {}),
    });
    return { channel: this.channelById(def.id) };
  }

  deleteChannel(
    params: ChatMethodMap['chat.delete_channel']['params']
  ): ChatMethodMap['chat.delete_channel']['result'] {
    this.manager.deleteChannel(params.channelId);
    return {};
  }

  setChannelMembers(
    params: ChatMethodMap['chat.set_channel_members']['params']
  ): ChatMethodMap['chat.set_channel_members']['result'] {
    this.manager.setChannelMembers(params.channelId, params.members);
    return { channel: this.channelById(params.channelId) };
  }

  listRoster(): ChatMethodMap['chat.list_roster']['result'] {
    return { agents: this.manager.chatRoster() };
  }

  getPresence(): ChatMethodMap['chat.get_presence']['result'] {
    return { presence: this.manager.getStatus() };
  }

  wakeAgent(params: ChatMethodMap['chat.wake_agent']['params']): ChatMethodMap['chat.wake_agent']['result'] {
    this.manager.wake(params.agentId);
    return {};
  }

  attachAgentSession(
    params: ChatMethodMap['chat.attach_agent_session']['params']
  ): Promise<ChatMethodMap['chat.attach_agent_session']['result']> {
    return this.manager.ensureSession(params.agentId);
  }

  /** The manager's chat-event stream — the /ws/chat fan-out subscribes here. */
  subscribe(cb: Parameters<ResidentAgentManager['subscribeChatEvents']>[0]): () => void {
    return this.manager.subscribeChatEvents(cb);
  }

  private channelById(id: string): NonNullable<ChatMethodMap['chat.create_channel']['result']['channel']> {
    const channel = this.manager.listChatChannels().find((c) => c.id === id);
    if (!channel) {
      throw new Error(`Unknown channel: ${id}`);
    }
    return channel;
  }
}

/**
 * chat-v1's internal binding: every wire method registered as an IPC channel
 * under its wire name, params object passed through verbatim. Poster
 * identity resolves from the (Electron event | server HandlerContext) slot.
 */
export function registerChatHandlers(ipc: IIpcListener, resolve: (event: unknown) => ResidentAgentManager): string[] {
  const channels: string[] = [];
  const h = <K extends keyof ChatMethodMap>(
    method: K,
    fn: (
      service: ChatService,
      poster: ChatPoster,
      params: ChatMethodMap[K]['params']
    ) => ChatMethodMap[K]['result'] | Promise<ChatMethodMap[K]['result']>
  ): void => {
    ipc.handle(method, async (event: unknown, params: unknown) => {
      const manager = resolve(event);
      // Handlers read/write the durable cache — never act before hydration.
      await manager.whenReady;
      return fn(new ChatService(manager), posterFromEvent(event), (params ?? {}) as ChatMethodMap[K]['params']);
    });
    channels.push(method);
  };
  h('chat.hello', (s, poster) => s.hello(poster));
  h('chat.list_channels', (s) => s.listChannels());
  h('chat.list_messages', (s, _p, params) => s.listMessages(params));
  h('chat.post_message', (s, poster, params) => s.postMessage(poster, params));
  h('chat.create_channel', (s, _p, params) => s.createChannel(params));
  h('chat.update_channel', (s, _p, params) => s.updateChannel(params));
  h('chat.delete_channel', (s, _p, params) => s.deleteChannel(params));
  h('chat.set_channel_members', (s, _p, params) => s.setChannelMembers(params));
  h('chat.list_roster', (s) => s.listRoster());
  h('chat.get_presence', (s) => s.getPresence());
  h('chat.wake_agent', (s, _p, params) => s.wakeAgent(params));
  h('chat.attach_agent_session', (s, _p, params) => s.attachAgentSession(params));
  return channels;
}
