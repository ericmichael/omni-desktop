import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateAgentConfigFromFiles } from '@/main/config-files-migration';
import type { SettingsConfigStore } from '@/shared/ipc-handlers';
import { MCP_ENTRY_NAME } from '@/shared/mcp-entry';
import type { StoreData } from '@/shared/types';

/** Minimal in-memory store satisfying SettingsConfigStore. */
function fakeStore(): SettingsConfigStore & { data: Partial<StoreData> } {
  const data: Partial<StoreData> = {};
  return {
    data,
    get: (k) => data[k],
    set: (k, v) => {
      (data as Record<string, unknown>)[k] = v;
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mig-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migrateAgentConfigFromFiles', () => {
  it('imports on-disk files, stripping the managed MCP entry, and sets the guard', () => {
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        version: 3,
        default: null,
        voice_default: null,
        providers: { openai: { type: 'openai', models: {} } },
      })
    );
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { mine: { type: 'stdio', command: 'x' }, [MCP_ENTRY_NAME]: { type: 'stdio', command: 'managed' } },
      })
    );
    writeFileSync(join(dir, '.env'), 'FOO=bar\n');

    const store = fakeStore();
    expect(migrateAgentConfigFromFiles(store, dir)).toBe(true);

    expect(store.data.modelsConfig?.providers.openai).toBeDefined();
    expect(store.data.mcpConfig?.mcpServers.mine).toBeDefined();
    expect(store.data.mcpConfig?.mcpServers[MCP_ENTRY_NAME]).toBeUndefined(); // stripped
    expect(store.data.envVars).toBe('FOO=bar\n');
    expect(store.data.agentConfigMigratedFromFiles).toBe(true);
  });

  it('is idempotent — a second run imports nothing', () => {
    writeFileSync(join(dir, '.env'), 'A=1');
    const store = fakeStore();
    migrateAgentConfigFromFiles(store, dir);
    store.data.envVars = 'changed-by-user';
    expect(migrateAgentConfigFromFiles(store, dir)).toBe(false);
    expect(store.data.envVars).toBe('changed-by-user'); // not clobbered
  });

  it('returns false (but still sets the guard) when no files exist', () => {
    const store = fakeStore();
    expect(migrateAgentConfigFromFiles(store, dir)).toBe(false);
    expect(store.data.agentConfigMigratedFromFiles).toBe(true);
  });
});
