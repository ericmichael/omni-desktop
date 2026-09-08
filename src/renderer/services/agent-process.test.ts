import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(() => () => {}),
  warning: vi.fn(),
  onConnect: vi.fn<(callback: () => void) => void>(),
  onStateChange: vi.fn<(callback: (state: unknown) => void) => void>(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    onResize(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    dispose(): void {}
  },
}));

vi.mock('@/renderer/services/ipc', () => ({
  emitter: { invoke: hoisted.invoke },
  ipc: { on: hoisted.on },
  wsEmitter: { onConnect: hoisted.onConnect, onStateChange: hoisted.onStateChange },
}));

vi.mock('@/renderer/features/Toast/state', () => ({
  toast: { warning: hoisted.warning },
}));

import {
  $agentStatuses,
  agentProcessApi,
  clearStatus,
  pollProcessStatus,
  warnForUncertainStop,
} from '@/renderer/services/agent-process';
import type { AgentProcessStopResult } from '@/shared/types';

const result = (patch: Partial<AgentProcessStopResult> = {}): AgentProcessStopResult => ({
  scope: 'host',
  shutdown: 'graceful',
  ...patch,
});

describe('launcher reconnect status reconciliation', () => {
  beforeEach(() => {
    hoisted.invoke.mockReset();
    $agentStatuses.set({});
  });

  it('reconciles every cached tile on connection, including running processes', async () => {
    $agentStatuses.set({
      a: { type: 'running', timestamp: 1, data: { uiUrl: 'http://localhost:3000' } },
      b: { type: 'connecting', timestamp: 1, data: { uiUrl: 'http://localhost:3001' } },
    });
    const missing = { type: 'uninitialized', timestamp: 2 } as const;
    hoisted.invoke.mockResolvedValue(missing);
    hoisted.onConnect.mock.calls[0]![0]();
    await vi.waitFor(() => expect($agentStatuses.get()).toEqual({ a: missing, b: missing }));
    expect(hoisted.invoke).toHaveBeenCalledWith('agent-process:get-status', 'a');
    expect(hoisted.invoke).toHaveBeenCalledWith('agent-process:get-status', 'b');
  });

  it('does not erase cached status merely because the socket disconnects', () => {
    const status = { type: 'starting', timestamp: 1 } as const;
    $agentStatuses.setKey('a', status);
    hoisted.onStateChange.mock.calls[0]![0]({ state: 'reconnecting' });
    expect($agentStatuses.get().a).toBe(status);
    expect(hoisted.invoke).not.toHaveBeenCalled();
  });

  it.each(['push', 'clear', 'connection'])('ignores reconciliation superseded by %s', async (change) => {
    $agentStatuses.setKey('a', { type: 'starting', timestamp: 1 });
    let resolve!: (value: unknown) => void;
    hoisted.invoke.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const pending = pollProcessStatus('a', true);
    if (change === 'push') {
      $agentStatuses.setKey('a', { type: 'starting', timestamp: 3 });
    }
    if (change === 'clear') {
      clearStatus('a');
    }
    if (change === 'connection') {
      hoisted.onStateChange.mock.calls[0]![0]({ state: 'reconnecting' });
    }
    const expected = $agentStatuses.get().a;
    resolve({ type: 'uninitialized', timestamp: 2 });
    await pending;
    expect($agentStatuses.get().a).toBe(expected);
  });
});

describe('agentProcessApi stop warnings', () => {
  beforeEach(() => {
    hoisted.invoke.mockReset();
    hoisted.warning.mockReset();
  });

  it('shows a non-destructive warning when the AgentHost requires SIGKILL', async () => {
    const stopped = result({ shutdown: 'forced' });
    hoisted.invoke.mockResolvedValue(stopped);

    await expect(agentProcessApi.stop('code-tab-1')).resolves.toEqual(stopped);

    expect(hoisted.warning).toHaveBeenCalledWith(
      'Sandbox host force-closed',
      'The agent host could not finish a graceful shutdown.',
      { durationMs: 12_000 }
    );
  });

  it('does not warn for a graceful stop or a version-skewed empty result', () => {
    warnForUncertainStop(result());
    warnForUncertainStop(undefined);

    expect(hoisted.warning).not.toHaveBeenCalled();
  });
});
