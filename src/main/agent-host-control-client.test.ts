// @vitest-environment node
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { AgentHostControlClient } from '@/main/agent-host-control-client';
import type { OmniagentsRpcError } from '@/shared/omniagents-rpc';

describe('AgentHostControlClient', () => {
  let server: WebSocketServer | undefined;

  afterEach(async () => {
    if (!server) {
      return;
    }
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('uses the private bearer credential and multiplexes typed calls', async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const calls: Array<Record<string, unknown>> = [];
    let authorization: string | undefined;
    server.on('connection', (socket, request) => {
      authorization = request.headers.authorization;
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        calls.push(message);
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message['id'],
            result: { agent_host_id: 'host-1' },
          })
        );
      });
    });
    const port = (server.address() as AddressInfo).port;
    const client = new AgentHostControlClient(`ws://127.0.0.1:${port}/ws`, 'control-secret');

    const [first, second] = await Promise.all([
      client.call('agent_host_list_resources', {}),
      client.call('agent_host_list_resources', {}),
    ]);

    expect(first).toEqual({ agent_host_id: 'host-1' });
    expect(second).toEqual({ agent_host_id: 'host-1' });
    expect(authorization).toBe('Bearer control-secret');
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call['id'])).size).toBe(2);
    client.close();
  });

  it('surfaces structured JSON-RPC failures', async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message['id'],
            error: { code: -32014, message: 'Not authorized' },
          })
        );
      });
    });
    const port = (server.address() as AddressInfo).port;
    const client = new AgentHostControlClient(`ws://127.0.0.1:${port}/ws`, 'control-secret');

    await expect(client.call('agent_host_list_resources', {})).rejects.toEqual(
      expect.objectContaining<Partial<OmniagentsRpcError>>({
        name: 'OmniagentsRpcError',
        code: -32014,
        message: 'Not authorized',
      })
    );
    client.close();
  });
});
