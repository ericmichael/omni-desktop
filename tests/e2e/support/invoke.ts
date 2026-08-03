import type { Page } from '@playwright/test';

type AppInvoke = (channel: string, args: unknown[]) => Promise<unknown>;

type E2eWindow = Window & {
  electron?: {
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
  };
  __omniE2eInvoke?: Promise<AppInvoke>;
};

/** Invoke the launcher's typed transport in either Electron or browser/server mode. */
export async function invokeApp<T>(page: Page, channel: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ invokeChannel, invokeArgs }) => {
      const scope = window as E2eWindow;
      if (scope.electron) {
        return scope.electron.ipcRenderer.invoke(invokeChannel, ...invokeArgs);
      }

      scope.__omniE2eInvoke ??= (async () => {
        const tokenResponse = await fetch('/api/ws-token', { credentials: 'same-origin' });
        if (!tokenResponse.ok) {
          throw new Error(`E2E transport token request failed: ${tokenResponse.status}`);
        }
        const tokenPayload = (await tokenResponse.json()) as { token?: string };
        if (!tokenPayload.token) {
          throw new Error('E2E transport token response omitted token');
        }

        const url = new URL('/ws', window.location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('sessionId', `e2e-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        url.searchParams.set('token', tokenPayload.token);
        const socket = new WebSocket(url);

        await new Promise<void>((resolve, reject) => {
          socket.addEventListener('open', () => resolve(), { once: true });
          socket.addEventListener('error', () => reject(new Error('E2E transport WebSocket failed to open')), {
            once: true,
          });
        });

        let nextId = 1;
        const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            id?: number;
            result?: unknown;
            error?: string;
          };
          if (message.type !== 'response' || typeof message.id !== 'number') {
            return;
          }
          const request = pending.get(message.id);
          if (!request) {
            return;
          }
          pending.delete(message.id);
          if (message.error) {
            request.reject(new Error(message.error));
          } else {
            request.resolve(message.result);
          }
        });
        socket.addEventListener('close', () => {
          for (const request of pending.values()) {
            request.reject(new Error('E2E transport WebSocket closed'));
          }
          pending.clear();
          delete scope.__omniE2eInvoke;
        });

        return (nextChannel: string, nextArgs: unknown[]) => {
          const id = nextId++;
          return new Promise<unknown>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ type: 'invoke', id, channel: nextChannel, args: nextArgs }));
          });
        };
      })();

      const invoke = await scope.__omniE2eInvoke;
      return invoke(invokeChannel, invokeArgs);
    },
    { invokeChannel: channel, invokeArgs: args }
  ) as Promise<T>;
}
