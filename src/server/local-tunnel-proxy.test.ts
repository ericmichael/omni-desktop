// @vitest-environment node
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { MachinesRepo } from 'omni-projects-db';
import { expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { setupLocalTunnelProxy } from './local-tunnel-proxy';
import { MachineRegistry } from './machine-registry';
import type { WsHandler } from './ws-handler';

it('requires the exact relay capability and does not forward launcher credentials to the laptop', async () => {
  const app = Fastify();
  await app.register(fastifyWebsocket);
  const registry = new MachineRegistry({
    register: async () => {},
    get: async () => ({ label: 'laptop' }),
  } as unknown as MachinesRepo);
  const ws = { readyState: 1 } as WebSocket;
  await registry.bindFromWs(ws, 'alice', { machineId: 'machine', label: 'laptop', platform: 'linux' });
  const invokeOnWs = vi.fn(async () => ({
    status: 200,
    headers: {},
    bodyBase64: Buffer.from('private').toString('base64'),
  }));
  const checkAccess = vi.fn(async () => true);
  setupLocalTunnelProxy(app, { handleCtx: vi.fn(), invokeOnWs, checkAccess } as unknown as WsHandler, registry);
  const route = '/proxy/local/machine/session/1234/file';
  try {
    expect((await app.inject(route)).statusCode).toBe(403);
    expect(invokeOnWs).not.toHaveBeenCalled();
    const cap = registry.grantTunnel('machine', 'session', 1234);
    const response = await app.inject({
      url: `${route}?cap=${cap}&part=1`,
      headers: { authorization: 'Bearer private', cookie: 'session=secret', 'x-ms-client-principal-id': 'alice' },
    });
    expect(response.body).toBe('private');
    expect(invokeOnWs).toHaveBeenCalledWith(ws, 'compute:tunnel-http', [
      expect.objectContaining({
        url: 'http://127.0.0.1:1234/file?part=1',
        headers: expect.not.objectContaining({ authorization: expect.anything(), cookie: expect.anything() }),
      }),
    ]);
    checkAccess.mockResolvedValue(false);
    expect((await app.inject(`${route}?cap=${cap}`)).statusCode).toBe(403);
    expect(invokeOnWs).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
