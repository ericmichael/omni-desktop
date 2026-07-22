import { describe, expect, it } from 'vitest';

import type { ToolItem } from '@/shared/chat-types';

import { computeGroupSummary } from './activity-group';

function tool(name: string, extra: Partial<ToolItem> = {}): ToolItem {
  return { type: 'tool', tool: name, status: 'result', ...extra };
}

describe('computeGroupSummary', () => {
  it('categorizes MCP-derived tools by their original name, not the wire encoding', () => {
    const summary = computeGroupSummary([
      tool('mcp_omni-projects__list_tickets', { tool_label: 'list_tickets', server_label: 'omni-projects' }),
      tool('mcp_omni-projects__create_ticket', { tool_label: 'create_ticket', server_label: 'omni-projects' }),
      tool('read_file'),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.reads).toBe(2); // list_tickets + read_file
    expect(summary.edits).toBe(1); // create_ticket
    expect(summary.other).toBe(0); // nothing buckets on the mcp_ prefix
  });

  it('falls back to the wire name when no label is present', () => {
    const summary = computeGroupSummary([tool('mcp_srv__whatever')]);
    expect(summary.other).toBe(1);
  });
});
