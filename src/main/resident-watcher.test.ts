import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { ResidentWatcher } from '@/main/resident-agent-manager';

const setup = () => {
  const callbacks = {
    onRunStarted: vi.fn(),
    onRunEnd: vi.fn(),
    onSpeechTool: vi.fn(),
    onWorkspaceTool: vi.fn(async () => ({})),
    onApprovalsChanged: vi.fn(),
    onClosed: vi.fn(),
  };
  const watcher = new ResidentWatcher('ws://test/ws', undefined, callbacks);
  const call = vi
    .spyOn(watcher, 'call')
    .mockImplementation(async (method: string) => (method === 'set_session_approvals' ? { ok: true } : []) as never);
  const event = (method: string, params: object) =>
    (watcher as unknown as { onMessage(raw: string): void }).onMessage(JSON.stringify({ method, params }));
  return { watcher, callbacks, call, event };
};

describe('resident approval enforcement', () => {
  it('negotiates approval routing before applying policy over a real socket', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('Missing port');
    let granted = false;
    server.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const request = JSON.parse(String(raw));
        if (request.id === undefined) return;
        let result: unknown = [];
        if (request.method === 'initialize') {
          granted = request.params.capabilities.experimental_operations.includes('set_session_approvals');
          result = { ...request.params, agent_host: { agent_host_id: 'test-host' } };
        } else if (request.method === 'set_session_approvals') {
          if (!granted) {
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32013, message: 'Experimental capability was not granted' },
              })
            );
            return;
          }
          result = { ok: true };
        }
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      })
    );
    const watcher = new ResidentWatcher(`ws://127.0.0.1:${address.port}`, undefined, setup().callbacks);
    try {
      await watcher.connect();
      await watcher.ensureSession('day', {}, 'auto');
      expect(granted).toBe(true);
    } finally {
      watcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('leaves tool and MCP approvals for the human, including replay', () => {
    const { call, event, callbacks } = setup();
    event('tool_approval_requested', { call_id: 'a', tool_name: 'shell' });
    event('tool_approval_requested', { call_id: 'a', tool_name: 'shell' });
    event('mcp_approval_requested', { request_id: 'b', tool_name: 'publish' });
    expect(call).not.toHaveBeenCalled();
    expect(callbacks.onApprovalsChanged).toHaveBeenLastCalledWith(2);
    event('tool_approval_resolved', { call_id: 'a', decision: 'reject' });
    expect(callbacks.onApprovalsChanged).toHaveBeenLastCalledWith(1);
    event('mcp_approval_resolved', { request_id: 'b', decision: 'approve' });
    expect(callbacks.onApprovalsChanged).toHaveBeenLastCalledWith(0);
  });

  it('applies policy before session setup and subscribes for pending approval recovery', async () => {
    const { watcher, call } = setup();
    await watcher.ensureSession('day-1', {}, 'user');
    expect(call.mock.calls.map((c) => c[0])).toEqual(['set_session_approvals', 'server_call', 'get_session_history']);
    await watcher.ensureSession('day-1', {}, 'auto');
    expect(call).toHaveBeenLastCalledWith('set_session_approvals', { session_id: 'day-1', reviewer: 'auto' });
    await watcher.ensureSession('day-2', {}, 'user');
    expect(call).toHaveBeenCalledWith('set_session_approvals', { session_id: 'day-2', reviewer: 'user' });
  });

  it('does not proceed when the server refuses the review policy', async () => {
    const { watcher, call } = setup();
    call.mockResolvedValueOnce({ ok: false } as never);
    await expect(watcher.ensureSession('day', {}, 'auto')).rejects.toThrow('approval policy');
    expect(call).toHaveBeenCalledTimes(1);
  });
});

it('fulfills user-goal tools without starting an execution loop', async () => {
  const callbacks = { ...setup().callbacks, onUserGoalTool: vi.fn(async () => ({ goals: [] })) };
  const watcher = new ResidentWatcher('ws://test/ws', undefined, callbacks);
  const call = vi.spyOn(watcher, 'call').mockResolvedValue({} as never);
  (watcher as unknown as { onMessage(raw: string): void }).onMessage(
    JSON.stringify({
      method: 'client_request',
      params: { function: 'tool.call', request_id: 'read-goals', args: { tool: 'list_user_goals', arguments: {} } },
    })
  );
  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith('client_response', { request_id: 'read-goals', ok: true, result: { goals: [] } })
  );
  expect(call.mock.calls.every(([method]) => String(method) === 'client_response')).toBe(true);
  watcher.close();
});

it('fulfills idea tools through the resident-bound handler', async () => {
  const callbacks = { ...setup().callbacks, onUserGoalTool: vi.fn(async () => ({ ideas: [] })) };
  const watcher = new ResidentWatcher('ws://test/ws', undefined, callbacks);
  const call = vi.spyOn(watcher, 'call').mockResolvedValue({} as never);
  (watcher as unknown as { onMessage(raw: string): void }).onMessage(
    JSON.stringify({
      method: 'client_request',
      params: { function: 'tool.call', request_id: 'ideas', args: { tool: 'list_user_ideas', arguments: {} } },
    })
  );
  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith('client_response', { request_id: 'ideas', ok: true, result: { ideas: [] } })
  );
  expect(callbacks.onUserGoalTool).toHaveBeenCalledWith('list_user_ideas', {});
  expect(call.mock.calls.every(([method]) => String(method) === 'client_response')).toBe(true);
  watcher.close();
});
