/**
 * Electron-side handler for the cloud's HTTP/WS proxy tunnels into local
 * `omni-serve`.
 *
 * When the renderer is on a different device than the laptop hosting a
 * local-compute session, its sandbox WS (`data.wsUrl`) is rewritten to
 * `/proxy/local/<machineId>/<sessionId>/<path>` (see cloud's
 * `local-tunnel-proxy.ts`). The cloud then relays bytes through reverse-RPC
 * frames against the laptop's WS:
 *
 *   - `compute:tunnel-http` — one-shot HTTP request, request/response in a
 *     single round-trip. Used for the renderer's omni-agents-ui REST calls
 *     and any other non-streamed HTTP fetch against the local sandbox.
 *   - `compute:tunnel-ws-open` / `tunnel-ws-write` / `tunnel-ws-close` —
 *     WebSocket frames multiplexed by a `tunnelId`. The laptop opens a
 *     WS to `127.0.0.1:<sandboxPort>`, pumps every inbound frame into the
 *     reverse-RPC channel, and writes every outbound frame the cloud
 *     pushes back.
 *
 * Same-LAN renderers (renderer + laptop on the same machine, or on the same
 * outbound IP per Phase 3 doc) get a direct LAN URL and never hit this
 * code path — they're a same-host TCP connection.
 */
import { WebSocket as WsWebSocket } from 'ws';

import { registerMainReverseHandler } from '@/main/reverse-rpc-bridge';

type HttpRequestArgs = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** UTF-8 string body. Binary uploads aren't supported through the tunnel
   *  (low priority; the renderer's chat/code surfaces don't upload). */
  body?: string;
};

type HttpResponseEnvelope = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Body always returned as a base64 string so the cloud can re-emit either
   *  text or binary without re-guessing the encoding. */
  bodyBase64: string;
};

type WsOpenArgs = {
  tunnelId: string;
  url: string;
};

type WsWriteArgs = {
  tunnelId: string;
  /** Frame payload as a base64 string. The cloud detects binary vs text by
   *  its own framing — every text payload is utf-8-decoded base64. */
  dataBase64: string;
  binary: boolean;
};

const sockets = new Map<string, WsWebSocket>();

/**
 * Register the tunnel reverse handlers. The renderer's compute shim
 * (`renderer/services/compute.ts`) forwards `compute:tunnel-*` frames into
 * main via `reverse-rpc:dispatch`; this module resolves them.
 *
 * To push WS frames BACK to the cloud (laptop → cloud → renderer), we need
 * a way to invoke against the cloud WS from main. That happens via the
 * `compute:tunnel-ws-incoming` event channel — main calls the renderer's
 * helper through Electron IPC `tunnel:emit-incoming`, which pushes the
 * frame into the WS as a regular event message. See
 * `renderer/services/tunnel-incoming.ts`.
 */
export const wireTunnelReverseHandlers = (
  emitIncoming: (event: { tunnelId: string; dataBase64: string; binary: boolean; close?: boolean }) => void
): (() => void) => {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    registerMainReverseHandler('compute:tunnel-http', async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as HttpRequestArgs;
      // Hard-rewrite scheme to http/127.0.0.1 — the cloud passes the absolute
      // upstream URL the renderer originally targeted, which lives on the
      // laptop's loopback.
      const res = await fetch(args.url, {
        method: args.method ?? 'GET',
        headers: args.headers ?? {},
        body: args.body,
      });
      const headersOut: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        // Drop hop-by-hop headers — the cloud isn't going to honor them and
        // they confuse fetch consumers.
        if (k === 'transfer-encoding' || k === 'connection' || k === 'keep-alive') {
          return;
        }
        headersOut[k] = v;
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const envelope: HttpResponseEnvelope = {
        status: res.status,
        statusText: res.statusText,
        headers: headersOut,
        bodyBase64: buf.toString('base64'),
      };
      return envelope;
    })
  );

  cleanups.push(
    registerMainReverseHandler('compute:tunnel-ws-open', async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as WsOpenArgs;
      if (!args.tunnelId || !args.url) {
        throw new Error('compute:tunnel-ws-open: tunnelId + url required');
      }
      if (sockets.has(args.tunnelId)) {
        // Idempotent re-open — close the prior socket so we don't leak.
        try {
          sockets.get(args.tunnelId)?.close();
        } catch {
          /* ignore */
        }
        sockets.delete(args.tunnelId);
      }
      const socket = new WsWebSocket(args.url);
      sockets.set(args.tunnelId, socket);
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        emitIncoming({
          tunnelId: args.tunnelId,
          dataBase64: data.toString('base64'),
          binary: isBinary,
        });
      });
      socket.on('close', () => {
        sockets.delete(args.tunnelId);
        emitIncoming({ tunnelId: args.tunnelId, dataBase64: '', binary: false, close: true });
      });
      socket.on('error', (err) => {
        console.error(`[tunnel] ws error tunnel=${args.tunnelId}:`, err.message);
      });
      // Wait for the open event so the cloud doesn't write before ready.
      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          socket.off('error', onError);
          resolve();
        };
        const onError = (err: Error): void => {
          socket.off('open', onOpen);
          sockets.delete(args.tunnelId);
          reject(err);
        };
        socket.once('open', onOpen);
        socket.once('error', onError);
      });
      return { ok: true };
    })
  );

  cleanups.push(
    registerMainReverseHandler('compute:tunnel-ws-write', async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as WsWriteArgs;
      const socket = sockets.get(args.tunnelId);
      if (!socket || socket.readyState !== WsWebSocket.OPEN) {
        throw new Error(`tunnel-not-open: ${args.tunnelId}`);
      }
      const buf = Buffer.from(args.dataBase64, 'base64');
      socket.send(args.binary ? buf : buf.toString('utf-8'));
      return { ok: true };
    })
  );

  cleanups.push(
    registerMainReverseHandler('compute:tunnel-ws-close', async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as { tunnelId: string };
      const socket = sockets.get(args.tunnelId);
      if (socket) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        sockets.delete(args.tunnelId);
      }
    })
  );

  return () => {
    for (const fn of cleanups) fn();
    for (const s of sockets.values()) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    sockets.clear();
  };
};
