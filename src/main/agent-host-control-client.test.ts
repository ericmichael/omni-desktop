// @vitest-environment node
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import {
  AgentHostControlClient,
  agentHostControlTimeoutMs,
  experimentalOperationsFromInitialize,
} from '@/main/agent-host-control-client';
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

  it('uses lifecycle-specific deadlines for provisioning calls', () => {
    expect(agentHostControlTimeoutMs('agent_host_register_workspace')).toBe(30_000);
    expect(agentHostControlTimeoutMs('agent_host_materialize_environment')).toBe(15 * 60_000);
    expect(agentHostControlTimeoutMs('agent_host_stop_environment')).toBe(2 * 60_000);
    expect(agentHostControlTimeoutMs('agent_host_materialize_environment', 25)).toBe(25);
  });

  it('fails closed on malformed negotiated capability envelopes', () => {
    expect(experimentalOperationsFromInitialize(null)).toEqual([]);
    expect(experimentalOperationsFromInitialize({ capabilities: {} })).toEqual([]);
    expect(
      experimentalOperationsFromInitialize({
        capabilities: { experimental_operations: ['validate_config', 42] },
      })
    ).toEqual([]);
    expect(
      experimentalOperationsFromInitialize({
        capabilities: { experimental_operations: ['validate_config', 'write_config'] },
      })
    ).toEqual(['validate_config', 'write_config']);
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
        if (message['method'] === 'initialized') {
          return;
        }
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message['id'],
            result:
              message['method'] === 'initialize'
                ? {
                    protocol_version: '1.0.0',
                    identity: { name: 'test-server', version: '1.0.0' },
                    platform: { os: 'linux', arch: 'x64' },
                    capabilities: (message['params'] as { capabilities: unknown }).capabilities,
                    agent_host: { agent_host_id: 'host-1' },
                  }
                : { agent_host_id: 'host-1' },
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
    expect(calls.map((call) => call['method'])).toEqual([
      'initialize',
      'initialized',
      'agent_host_list_resources',
      'agent_host_list_resources',
    ]);
    expect((calls[0]!['params'] as Record<string, unknown>)['capabilities']).toMatchObject({
      experimental_operations: expect.arrayContaining(['agent_host_list_resources', 'validate_config', 'write_config']),
    });
    await expect(client.getExperimentalOperations()).resolves.toEqual(
      expect.arrayContaining(['validate_config', 'write_config'])
    );
    expect(new Set(calls.slice(2).map((call) => call['id'])).size).toBe(2);
    client.close();
  });

  it('surfaces structured JSON-RPC failures', async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        if (message['method'] === 'initialize') {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: message['id'], result: { protocol_version: '1.0.0' } }));
          return;
        }
        if (message['method'] === 'initialized') {
          return;
        }
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
