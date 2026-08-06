import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerConfigHandlers, registerSettingsConfigHandlers } from '@/shared/ipc-handlers';
import type { IIpcListener } from '@/shared/ipc-listener';

const fakeIpc = () => {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const ipc = {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => handlers.set(channel, handler)),
  } as unknown as IIpcListener;
  return { ipc, handlers };
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('config ownership hooks', () => {
  it('can reject both generic JSON and text writes before mcp.json changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ipc-config-'));
    dirs.push(dir);
    const beforeWrite = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('mcp.json')) {
        throw new Error('canonical owner');
      }
    });
    const { ipc, handlers } = fakeIpc();
    registerConfigHandlers(ipc, dir, { beforeWrite });
    const mcpPath = join(dir, 'mcp.json');

    await expect(
      handlers.get('config:write-json-file')!(undefined as never, mcpPath as never, {} as never)
    ).rejects.toThrow('canonical owner');
    await expect(
      handlers.get('config:write-text-file')!(undefined as never, mcpPath as never, '{}' as never)
    ).rejects.toThrow('canonical owner');
    expect(existsSync(mcpPath)).toBe(false);

    const modelsPath = join(dir, 'models.json');
    await handlers.get('config:write-json-file')!(undefined as never, modelsPath as never, { version: 3 } as never);
    expect(JSON.parse(readFileSync(modelsPath, 'utf8'))).toEqual({ version: 3 });
  });

  it('rejects the legacy full-document MCP setter before mutating the store', async () => {
    const { ipc, handlers } = fakeIpc();
    const set = vi.fn();
    registerSettingsConfigHandlers(
      ipc,
      () => ({ get: vi.fn(), set }) as never,
      vi.fn(),
      {},
      { beforeSetMcp: () => Promise.reject(new Error('canonical owner')) }
    );

    await expect(
      handlers.get('settings:set-mcp-config')!(
        undefined as never,
        { mcpServers: { github: { type: 'http', url: 'https://mcp' } } } as never
      )
    ).rejects.toThrow('canonical owner');
    expect(set).not.toHaveBeenCalled();
  });
});
