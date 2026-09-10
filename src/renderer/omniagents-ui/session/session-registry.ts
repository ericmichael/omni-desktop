import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';

import { ConversationSession } from './conversation-session';

const sessionEvents = [
  'message_output',
  'run_started',
  'run_end',
  'run_status',
  'token',
  'token_usage',
  'tool_called',
  'tool_result',
  'client_request',
  'client_request_resolved',
  'tool_approval_requested',
  'tool_approval_resolved',
  'tool_approval_reviewed',
  'plan_completion_reviewed',
  'mcp_approval_requested',
  'mcp_approval_resolved',
  'item_updated',
  'queue_changed',
] as const;

export const SESSION_IDLE_CACHE_MS = 5 * 60_000;

/** One router per connection; no concept of the currently selected chat. */
export class SessionRegistry {
  private sessions = new Map<string, ConversationSession>();
  private cleanups: Array<() => void> = [];
  private owners = 0;
  private lifetime = 0;
  private views = new Map<string, number>();
  private lastUsed = new Map<string, number>();
  private sweep?: ReturnType<typeof setInterval>;
  constructor(readonly client: RPCClient) {}

  get(id: string): ConversationSession {
    if (!id) {
      throw new Error('A conversation must have an identity before acquiring its controller');
    }
    this.start();
    this.lastUsed.set(id, Date.now());
    let session = this.sessions.get(id);
    if (!session) {
      session = new ConversationSession(id, this.client);
      this.sessions.set(id, session);
    }
    return session;
  }

  /** Visibility is not ownership: hidden mounted tiles retain their sessions. */
  retainSession(id: string) {
    this.get(id);
    this.views.set(id, (this.views.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remaining = (this.views.get(id) ?? 1) - 1;
      if (remaining) {
        this.views.set(id, remaining);
      } else {
        this.views.delete(id);
      }
      this.lastUsed.set(id, Date.now());
    };
  }

  private collectIdleSessions() {
    for (const [id, session] of this.sessions) {
      if (this.views.has(id) || !session.canEvict) {
        this.lastUsed.set(id, Date.now());
        continue;
      }
      if (Date.now() - (this.lastUsed.get(id) ?? Date.now()) < SESSION_IDLE_CACHE_MS) {
        continue;
      }
      session.dispose();
      this.sessions.delete(id);
      this.lastUsed.delete(id);
    }
  }

  private start() {
    if (this.cleanups.length) {
      return;
    }
    this.sweep = setInterval(() => this.collectIdleSessions(), 60_000);
    for (const name of sessionEvents) {
      this.cleanups.push(
        this.client.on(name, (payload) => {
          // Missing identity is not permission to broadcast into every chat.
          const id = typeof payload?.session_id === 'string' ? payload.session_id : payload?.thread_id;
          if (typeof id !== 'string') {
            return;
          }
          if (typeof payload?.thread_id === 'string' && payload.thread_id !== id) {
            return;
          }
          this.sessions.get(id)?.dispatch(name, payload);
        })
      );
    }
    this.cleanups.push(
      this.client.onResyncRequired((id) => {
        const session = this.sessions.get(id);
        if (session) {
          void session.load({ force: true }).catch(() => {});
        }
      })
    );
    let connected = this.client.isConnected;
    const subscription = this.client.actor.subscribe(() => {
      const next = this.client.isConnected;
      if (next && !connected) {
        for (const session of this.sessions.values()) {
          session.reconnected();
        }
      }
      connected = next;
    });
    this.cleanups.push(() => subscription.unsubscribe());
  }

  /** Provider lifetime, not view lifetime. Deferred teardown tolerates the
   * StrictMode effect cleanup/setup pair without killing a shared actor. */
  retain() {
    this.owners++;
    this.lifetime++;
    this.start();
    return () => {
      this.owners--;
      const lifetime = ++this.lifetime;
      queueMicrotask(() => {
        if (!this.owners && lifetime === this.lifetime) {
          this.dispose();
        }
      });
    };
  }

  dispose() {
    clearInterval(this.sweep);
    this.sweep = undefined;
    for (const off of this.cleanups.splice(0)) {
      off();
    }
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.views.clear();
    this.lastUsed.clear();
  }
}

const registries = new WeakMap<RPCClient, SessionRegistry>();
export function getSessionRegistry(client: RPCClient) {
  let registry = registries.get(client);
  if (!registry) {
    registry = new SessionRegistry(client);
    registries.set(client, registry);
  }
  return registry;
}
