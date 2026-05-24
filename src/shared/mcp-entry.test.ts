import { describe, expect, it } from 'vitest';

import { buildHttpMcpEntry, buildStdioMcpEntry, MCP_ENTRY_NAME, mergeManagedMcpEntry } from '@/shared/mcp-entry';

describe('mergeManagedMcpEntry', () => {
  const managed = buildHttpMcpEntry('http://127.0.0.1:3001/mcp/projects');

  it('adds the managed entry, preserving the user’s own servers', () => {
    const merged = mergeManagedMcpEntry({ other: { type: 'stdio', command: 'x' } }, managed);
    expect(merged.other).toBeDefined();
    expect(merged[MCP_ENTRY_NAME]).toEqual(managed);
  });

  it('replaces a previously-managed entry (idempotent refresh)', () => {
    const stale = buildStdioMcpEntry('/old/cli.js');
    const merged = mergeManagedMcpEntry({ [MCP_ENTRY_NAME]: stale }, managed);
    expect(merged[MCP_ENTRY_NAME]).toEqual(managed);
  });

  it('does not overwrite a user-claimed (unmarked) omni-projects entry', () => {
    const userEntry = { type: 'stdio' as const, command: 'my-own', args: ['--x'] };
    const merged = mergeManagedMcpEntry({ [MCP_ENTRY_NAME]: userEntry }, managed);
    expect(merged[MCP_ENTRY_NAME]).toEqual(userEntry);
  });
});
