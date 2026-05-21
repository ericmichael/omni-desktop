import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncMcpConfigHttp } from '@/main/mcp-config-manager';

describe('syncMcpConfigHttp', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcpcfg-'));
    prev = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  const mcpPath = () => join(dir, 'omni_code', 'mcp.json');
  const read = () => JSON.parse(readFileSync(mcpPath(), 'utf-8'));

  it('writes a managed streamable_http omni-projects entry', () => {
    syncMcpConfigHttp('http://127.0.0.1:3001/mcp/projects');
    const e = read().mcpServers['omni-projects'];
    expect(e.type).toBe('streamable_http');
    expect(e.url).toBe('http://127.0.0.1:3001/mcp/projects');
    expect(e.headers.Authorization).toBe('Bearer ${OMNI_RUNTIME_TOKEN}');
    expect(e.cache_tools_list).toBe(true);
    expect(e._managed).toBe('omni-launcher');
  });

  it('preserves other servers and refreshes its own entry', () => {
    mkdirSync(join(dir, 'omni_code'), { recursive: true });
    writeFileSync(mcpPath(), JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'x', args: [] } } }));
    syncMcpConfigHttp('http://127.0.0.1:3001/mcp/projects');
    const servers = read().mcpServers;
    expect(servers.other).toBeDefined();
    expect(servers['omni-projects'].type).toBe('streamable_http');
  });

  it('does not overwrite a user-claimed (unmanaged) entry', () => {
    mkdirSync(join(dir, 'omni_code'), { recursive: true });
    const userEntry = { type: 'stdio', command: 'my-own', args: ['--x'] };
    writeFileSync(mcpPath(), JSON.stringify({ mcpServers: { 'omni-projects': userEntry } }));
    syncMcpConfigHttp('http://127.0.0.1:3001/mcp/projects');
    expect(read().mcpServers['omni-projects']).toEqual(userEntry);
  });
});
