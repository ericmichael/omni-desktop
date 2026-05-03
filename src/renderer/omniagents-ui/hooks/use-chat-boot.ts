/**
 * React hook that drives the chat-boot machine with real actors and
 * connects it to the live RPC client + chat-session machine.
 *
 * This is the composition layer that used to live imperatively in the
 * App.tsx mount effect. Each dependency (RPC connection, capability
 * bootstrap, session load) is now a state in a state machine, with
 * XState's invoker teardown handling cancellation automatically — no
 * more `cancelled` flags, no more stale fetches producing HISTORY_ERROR
 * after unmount.
 */
import { useActorRef, useSelector } from '@xstate/react';
import { useCallback, useEffect, useMemo } from 'react';
import { fromCallback } from 'xstate';

import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';
import {
  type ChatBootCapabilities,
  type ChatBootEvent,
  type ChatBootPhase,
  chatBootMachine,
  isBootReady,
} from '@/shared/machines/chat-boot.machine';
import { createMachineLogger } from '@/shared/machines/machine-logger';

import type { UseChatSessionReturn } from './use-chat-session';

// ---------------------------------------------------------------------------
// Shape of the bootstrap step's network call
// ---------------------------------------------------------------------------

/** Options passed in by the caller — all mutable behavior lives in refs. */
export type UseChatBootOptions = {
  client: RPCClient;
  chatSession: UseChatSessionReturn;
  sessionId: string | undefined;
  /** Realtime WS URL, for the voice capability probe. */
  wsRealtimeUrl?: string;
  /** Optional auth token for the realtime probe. */
  token?: string;
};

// ---------------------------------------------------------------------------
// Bootstrap implementation
// ---------------------------------------------------------------------------

/**
 * Runs the capability-discovery calls that used to sit in App.tsx's mount
 * effect. Returns the resolved capabilities. Any failure here throws; the
 * invoker wrapper catches and dispatches BOOTSTRAP_FAILED.
 */
async function runBootstrap(opts: UseChatBootOptions): Promise<ChatBootCapabilities> {
  const { client, wsRealtimeUrl, token } = opts;

  // 1. Register client-callable functions the server can invoke.
  try {
    await client.clientFunctions(1, [
      { name: 'ui.request_tool_approval' },
      { name: 'ui.set_status' },
      { name: 'ui.add_artifact' },
    ]);
  } catch {
    // Non-fatal — older servers may not support this.
  }

  // 2. Agent name + welcome text.
  let agentName = 'OmniAgent';
  let welcomeText: string | undefined;
  try {
    const info = (await client.getAgentInfo()) as any;
    if (info?.name) {
agentName = normalizeAgentName(String(info.name));
}
    if (info?.welcome_text) {
welcomeText = String(info.welcome_text);
}
  } catch {
    // Keep defaults on failure.
  }

  // 3. Workspace support — depends on the agent exposing the fs tools.
  let workspaceSupported = false;
  let workspacePath: string | undefined;
  try {
    const funcs = await client.listServerFunctions();
    const names = new Set(funcs.map((f) => f.name));
    if (names.has('fs_list_dir') && names.has('fs_get_workspace_root')) {
      workspaceSupported = true;
      try {
        const res = (await client.serverCall('fs_get_cwd')) as any;
        if (res?.path) {
workspacePath = String(res.path);
}
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  // Probe via capabilities() not startSession(): the latter creates an empty trace per boot.
  let voiceEnabled = false;
  if (wsRealtimeUrl) {
    try {
      const { RealtimeRPCClient } = await import('../rpc/realtime');
      const rtc = new RealtimeRPCClient(wsRealtimeUrl, token);
      await rtc.connect();
      try {
        const caps = await rtc.capabilities();
        voiceEnabled = !!caps?.enabled;
      } finally {
        rtc.disconnect();
      }
    } catch {
      /* ignore */
    }
  }

  return {
    agentName,
    welcomeText,
    voiceEnabled,
    workspaceSupported,
    workspacePath,
  };
}

function normalizeAgentName(name: string): string {
  let s = String(name || '').trim();
  s = s.replace(/[_-]+/g, ' ');
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  s = s.replace(/\s+/g, ' ');
  return s
    .split(' ')
    .map((w) => (w && w.length > 0 ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : ''))
    .join(' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatBoot(opts: UseChatBootOptions) {
  const { client, chatSession, sessionId, wsRealtimeUrl, token } = opts;

  // Actor wiring — we close over the live dependencies inside the actor
  // definitions so the machine stays pure.
  const machine = useMemo(() => {
    return chatBootMachine.provide({
      actors: {
        // Subscribes to the rpc-client actor. Seeds with current state
        // (covers the case where the WS is already open at mount) and
        // dispatches RPC_CONNECTED on transition. Cleaned up when the
        // boot machine leaves awaitingConnection.
        waitForConnection: fromCallback<ChatBootEvent>(({ sendBack }) => {
          const check = () => {
            if (client.isConnected) {
              sendBack({ type: 'RPC_CONNECTED' });
            }
          };
          // Seed: already connected?
          check();
          const sub = client.actor.subscribe(() => {
            check();
          });
          // Kick off the connection attempt if the rpc-client hasn't
          // been asked yet. Fire-and-forget — errors are driven by the
          // rpc machine's reconnect loop.
          client.connect().catch(() => {});
          return () => sub.unsubscribe();
        }),

        // Runs the bootstrap capability calls and dispatches the result.
        bootstrap: fromCallback<ChatBootEvent>(({ sendBack }) => {
          let cancelled = false;
          runBootstrap({ client, chatSession, sessionId, wsRealtimeUrl, token })
            .then((capabilities) => {
              if (!cancelled) {
                sendBack({ type: 'BOOTSTRAP_OK', capabilities });
              }
            })
            .catch((err: unknown) => {
              if (!cancelled) {
                sendBack({
                  type: 'BOOTSTRAP_FAILED',
                  error: String((err as Error)?.message || err),
                });
              }
            });
          return () => {
            cancelled = true;
          };
        }),

        // Delegates to chatSession.loadSession, then reports the outcome
        // to the boot machine. On RPC_DISCONNECTED, the boot machine tears
        // this invoker down via its cleanup function — any in-flight fetch
        // is abandoned and its late-arriving result is ignored by the
        // `cancelled` flag.
        loadSession: fromCallback<ChatBootEvent>(({ sendBack }) => {
          let cancelled = false;
          chatSession
            .loadSession(sessionId)
            .then(() => {
              if (cancelled) {
return;
}
              // loadSession updates the chat-session machine directly; we
              // peek at its snapshot to decide whether it landed in a
              // good state. The `initError` state is surfaced as a
              // SESSION_ERROR event so the boot machine can offer retry.
              // Successful init lands in `ready.*` or at least not
              // `initError` — we treat that as SESSION_LOADED.
              const snap = chatSession.actor.getSnapshot();
              const v = snap.value as unknown;
              const isError =
                v === 'initError' ||
                (typeof v === 'object' && v !== null && 'initError' in (v as object));
              if (isError) {
                sendBack({
                  type: 'SESSION_ERROR',
                  error: String(snap.context.error || 'Failed to load session'),
                });
              } else {
                sendBack({ type: 'SESSION_LOADED' });
              }
            })
            .catch((err: unknown) => {
              if (cancelled) {
return;
}
              sendBack({
                type: 'SESSION_ERROR',
                error: String((err as Error)?.message || err),
              });
            });
          return () => {
            cancelled = true;
          };
        }),
      },
    });
    // We intentionally omit `sessionId` from deps — it's read inside the
    // invokers via closure and propagated via SET_SESSION_ID events. If
    // we re-created the machine on every sessionId change, the boot state
    // would reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, chatSession, wsRealtimeUrl, token]);

  const actor = useActorRef(machine, {
    input: { sessionId },
    inspect: createMachineLogger('chatBoot'),
  });

  // Propagate sessionId prop changes into the machine context.
  useEffect(() => {
    actor.send({ type: 'SET_SESSION_ID', sessionId });
  }, [actor, sessionId]);

  // Global RPC-disconnect watcher: the waitForConnection invoker only
  // runs while in awaitingConnection, so a disconnect after we've moved
  // past that state wouldn't be observed. This effect watches the
  // rpc-client's state for the entire lifetime of the hook and dispatches
  // RPC_DISCONNECTED whenever the WS drops.
  useEffect(() => {
    let lastConnected = client.isConnected;
    const sub = client.actor.subscribe(() => {
      const nowConnected = client.isConnected;
      if (lastConnected && !nowConnected) {
        actor.send({ type: 'RPC_DISCONNECTED' });
      }
      lastConnected = nowConnected;
    });
    return () => sub.unsubscribe();
  }, [actor, client]);

  // ---- Selectors ----
  const phase = useSelector(actor, (s) => s.value as ChatBootPhase);
  const capabilities = useSelector(actor, (s) => s.context.capabilities);
  const error = useSelector(actor, (s) => s.context.error);
  const ready = useSelector(actor, (s) => isBootReady(s.value as ChatBootPhase));

  // ---- Actions ----
  const retry = useCallback(() => {
    actor.send({ type: 'RETRY' });
  }, [actor]);

  return {
    actor,
    phase,
    capabilities,
    error,
    ready,
    retry,
  };
}

export type UseChatBootReturn = ReturnType<typeof useChatBoot>;
