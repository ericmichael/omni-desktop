import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { initializeMainRpcConnection, mainRpcInitializeParams } from './omniagents-rpc-handshake';

describe('main-process OmniAgents RPC handshake', () => {
  it('builds a fail-closed capability declaration with explicit overrides', () => {
    expect(mainRpcInitializeParams('test-client', { terminal: true })).toMatchObject({
      protocol_version: '1.0.0',
      identity: { name: 'test-client', version: '1.0.0' },
      capabilities: {
        terminal: true,
        approvals: false,
        experimental_operations: [],
      },
    });
  });

  it('orders initialize before initialized and resolves only after both complete', async () => {
    const order: string[] = [];
    const request = vi.fn(async () => {
      order.push('initialize');
      return {
        protocol_version: '1.0.0',
        identity: { name: 'test-server', version: '1.0.0' },
        platform: { os: 'linux', arch: 'x64' },
        capabilities: mainRpcInitializeParams('test-server').capabilities,
        agent_host: { agent_host_id: 'host-1' },
      };
    });
    const notify = vi.fn(async () => {
      order.push('initialized');
    });

    await expect(initializeMainRpcConnection({ name: 'test-client', request, notify })).resolves.toMatchObject({
      protocol_version: '1.0.0',
      agent_host: { agent_host_id: 'host-1' },
    });
    expect(order).toEqual(['initialize', 'initialized']);
  });

  it('guards every production main/server JSON-RPC WebSocket client with the shared handshake', () => {
    const productionTypescript = (root: string): string[] =>
      readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(root, entry.name);
        if (entry.isDirectory()) {
          return productionTypescript(target);
        }
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [target] : [];
      });

    const clients = [path.join(process.cwd(), 'src/main'), path.join(process.cwd(), 'src/server')]
      .flatMap(productionTypescript)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes("jsonrpc: '2.0'") && /from ['"]ws['"]/.test(source);
      });
    const unguarded = clients
      .filter((file) => !readFileSync(file, 'utf8').includes('initializeMainRpcConnection'))
      .map((file) => path.relative(process.cwd(), file));

    expect(clients.length).toBeGreaterThan(0);
    expect(unguarded).toEqual([]);
  });
});
