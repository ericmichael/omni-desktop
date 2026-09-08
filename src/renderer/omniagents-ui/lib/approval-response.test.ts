import { expect, it, vi } from 'vitest';

import { respondToApproval } from './approval-response';

it.each(['function', 'mcp'] as const)('does not reverse a %s approval after a failed acknowledgement', async (kind) => {
  const client = { toolApprovalResponse: vi.fn(), mcpApprovalResponse: vi.fn() };
  const rpc = kind === 'mcp' ? client.mcpApprovalResponse : client.toolApprovalResponse;
  rpc.mockRejectedValueOnce(new Error('lost reply'));
  await expect(respondToApproval(client, 'request-A', 'yes', kind)).rejects.toThrow('lost reply');
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc.mock.calls[0]!.slice(0, 2)).toEqual(['request-A', 'approve']);
  rpc.mockResolvedValueOnce(true);
  await respondToApproval(client, 'request-A', 'yes', kind);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls[1]!.slice(0, 2)).toEqual(['request-A', 'approve']);
});

it.each(['function', 'mcp'] as const)('does not dismiss a %s approval on false', async (kind) => {
  const client = {
    toolApprovalResponse: vi.fn().mockResolvedValue(false),
    mcpApprovalResponse: vi.fn().mockResolvedValue(false),
  };
  await expect(respondToApproval(client, 'expired', 'yes', kind)).rejects.toThrow('no longer pending');
});
