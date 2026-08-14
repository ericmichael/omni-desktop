/**
 * /ws/chat — chat-v1's public binding (docs/chat-v1-plan.md).
 *
 * JSON-RPC 2.0 over WebSocket, same framing family as the gui-v1 protocol
 * so client authors reuse patterns. Each connection resolves ONE tenant's
 * ChatService; methods dispatch to the same facade the internal binding
 * uses, and the manager's chat-event stream fans out as JSON-RPC
 * notifications. There is no replay buffer: the durable log is the replay
 * substrate — clients resume with `chat.list_messages({ after })`.
 *
 * Auth mirrors /ws: a signed token from /api/ws-token in `?token=` (the
 * browser WebSocket API can't send Bearer headers). Additionally a raw
 * BRIDGE KEY from `OMNI_CHAT_BRIDGE_KEYS` (comma-separated) is accepted in
 * the same parameter: bridge connections hold the only scope allowed to
 * post `asExternal`, and MUST post that way — a bridge always says who
 * spoke. Bridges bind to `?team=<tenant>` (default tenant otherwise).
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import { type ChatPoster, ChatService } from '@/main/chat-service';
import type { ResidentAgentManager } from '@/main/resident-agent-manager';
import { DEFAULT_TENANT } from '@/server/ws-handler';
import { CHAT_METHOD_NAMES, type ChatMethodMap } from '@/shared/types';

import { verifyRuntimeToken } from './runtime-token';

/** JSON-RPC 2.0 error codes (plus chat-v1's app-level -32000 with data.kind). */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const APP_ERROR = -32000;

/** Classify a facade error into chat-v1's documented `data.kind` values. */
export function chatErrorKind(message: string): string {
  if (message.startsWith('Unknown channel')) {
    return 'unknown_channel';
  }
  if (message.startsWith('Cannot reply')) {
    return 'reply_not_in_channel';
  }
  if (message.startsWith('Unknown resident agent') || message.startsWith('Error: unknown recipient')) {
    return 'unknown_recipient';
  }
  if (message.includes('built-in') || message.includes('server-authored')) {
    return 'reserved_channel';
  }
  if (message.includes('bridge scope') || message.includes('asExternal')) {
    return 'forbidden';
  }
  return 'invalid_params';
}

export type ChatWsDeps = {
  runtimeTokenSecret: string;
  getResidentManager: (tenantId: string, principalId?: string) => ResidentAgentManager;
  teamsEnabled: boolean;
  ensureUserBootstrapped?: (
    principal: string,
    claims: { email?: string; displayName?: string; idp?: string }
  ) => Promise<void>;
  resolveActiveTeam?: (principal: string, requested?: string) => Promise<string | null>;
  /** EasyAuth-derived display info for the upgrade request's headers. */
  principalClaims: (headers: IncomingHttpHeaders) => { email?: string; displayName?: string; idp?: string };
  /** Raw bridge keys (OMNI_CHAT_BRIDGE_KEYS), already split + trimmed. */
  bridgeKeys: readonly string[];
};

const constantTimeMatch = (candidate: string, keys: readonly string[]): boolean => {
  const buf = Buffer.from(candidate);
  return keys.some((key) => {
    const kb = Buffer.from(key);
    return kb.length === buf.length && timingSafeEqual(kb, buf);
  });
};

type Resolved = { tenantId: string; principalId: string; poster: ChatPoster };

/**
 * Register the route. Must run inside a fastify scope that already has the
 * websocket plugin (the same plugin block as /ws).
 */
export function registerChatWsRoute(f: FastifyInstance, deps: ChatWsDeps): void {
  f.get('/ws/chat', { websocket: true }, (socket: WebSocket, request) => {
    const url = new URL(request.url, `http://${request.hostname}`);
    const token = url.searchParams.get('token');
    const requestedTeam = url.searchParams.get('team') ?? undefined;
    if (!token) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    void (async (): Promise<void> => {
      let resolved: Resolved;
      if (deps.bridgeKeys.length > 0 && constantTimeMatch(token, deps.bridgeKeys)) {
        // Bridge scope: a relay for an external network. It binds to an
        // explicit tenant and always posts asExternal.
        resolved = {
          tenantId: requestedTeam ?? DEFAULT_TENANT,
          principalId: 'bridge',
          poster: { id: 'bridge', name: null, bridge: true },
        };
      } else {
        const claims = verifyRuntimeToken(deps.runtimeTokenSecret, token);
        if (!claims) {
          socket.close(4401, 'Unauthorized');
          return;
        }
        const principal = claims.principalId ?? claims.tenantId;
        if (!deps.teamsEnabled) {
          // Single-user mode: the data scope is the principal, and the
          // caller IS the collective human.
          resolved = { tenantId: principal, principalId: principal, poster: { id: 'user', name: null } };
        } else {
          const info = deps.principalClaims(request.headers);
          await deps.ensureUserBootstrapped?.(principal, info);
          const teamId = (await deps.resolveActiveTeam?.(principal, requestedTeam)) ?? null;
          if (teamId === null) {
            socket.close(4403, 'Forbidden: not a member of the requested team');
            return;
          }
          resolved = {
            tenantId: teamId,
            principalId: principal,
            // Named principal in a shared team; personal team = collective.
            poster:
              teamId === principal
                ? { id: 'user', name: null }
                : { id: `human:${principal}`, name: info.displayName ?? null },
          };
        }
      }

      const manager = deps.getResidentManager(resolved.tenantId, resolved.principalId);
      await manager.whenReady;
      const service = new ChatService(manager);

      const send = (payload: unknown): void => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      };

      // Fan the manager's chat events out as JSON-RPC notifications.
      const unsubscribe = service.subscribe((event) => {
        send({ jsonrpc: '2.0', method: event.method, params: event.params });
      });
      socket.on('close', unsubscribe);

      const methods = new Set<string>(CHAT_METHOD_NAMES);
      socket.on('message', (raw) => {
        void (async (): Promise<void> => {
          let msg: { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
          try {
            msg = JSON.parse(String(raw)) as typeof msg;
          } catch {
            send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
            return;
          }
          const id = typeof msg.id === 'number' || typeof msg.id === 'string' ? msg.id : null;
          if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
            send({ jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Invalid request' } });
            return;
          }
          if (!methods.has(msg.method)) {
            send({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `Unknown method: ${msg.method}` } });
            return;
          }
          const method = msg.method as keyof ChatMethodMap;
          const params = (msg.params ?? {}) as never;
          try {
            const result = await dispatch(service, resolved.poster, method, params);
            send({ jsonrpc: '2.0', id, result });
          } catch (err) {
            const message = (err as Error).message;
            send({
              jsonrpc: '2.0',
              id,
              error: { code: APP_ERROR, message, data: { kind: chatErrorKind(message) } },
            });
          }
        })();
      });
    })().catch((err: unknown) => {
      console.error('[chat-ws] connection setup failed:', err);
      socket.close(4500, 'Server error');
    });
  });
}

function dispatch<K extends keyof ChatMethodMap>(
  service: ChatService,
  poster: ChatPoster,
  method: K,
  params: ChatMethodMap[K]['params']
): ChatMethodMap[K]['result'] | Promise<ChatMethodMap[K]['result']> {
  switch (method) {
    case 'chat.hello':
      return service.hello(poster) as ChatMethodMap[K]['result'];
    case 'chat.list_channels':
      return service.listChannels() as ChatMethodMap[K]['result'];
    case 'chat.list_messages':
      return service.listMessages(params as ChatMethodMap['chat.list_messages']['params']) as Promise<
        ChatMethodMap[K]['result']
      >;
    case 'chat.post_message':
      return service.postMessage(
        poster,
        params as ChatMethodMap['chat.post_message']['params']
      ) as ChatMethodMap[K]['result'];
    case 'chat.create_channel':
      return service.createChannel(
        params as ChatMethodMap['chat.create_channel']['params']
      ) as ChatMethodMap[K]['result'];
    case 'chat.update_channel':
      return service.updateChannel(
        params as ChatMethodMap['chat.update_channel']['params']
      ) as ChatMethodMap[K]['result'];
    case 'chat.delete_channel':
      return service.deleteChannel(
        params as ChatMethodMap['chat.delete_channel']['params']
      ) as ChatMethodMap[K]['result'];
    case 'chat.set_channel_members':
      return service.setChannelMembers(
        params as ChatMethodMap['chat.set_channel_members']['params']
      ) as ChatMethodMap[K]['result'];
    case 'chat.list_roster':
      return service.listRoster() as ChatMethodMap[K]['result'];
    case 'chat.get_presence':
      return service.getPresence() as ChatMethodMap[K]['result'];
    case 'chat.wake_agent':
      return service.wakeAgent(params as ChatMethodMap['chat.wake_agent']['params']) as ChatMethodMap[K]['result'];
    case 'chat.attach_agent_session':
      return service.attachAgentSession(params as ChatMethodMap['chat.attach_agent_session']['params']) as Promise<
        ChatMethodMap[K]['result']
      >;
  }
}
