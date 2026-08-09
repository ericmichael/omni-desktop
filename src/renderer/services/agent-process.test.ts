import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(() => () => {}),
  warning: vi.fn(),
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
}));

vi.mock('@/renderer/features/Toast/state', () => ({
  toast: { warning: hoisted.warning },
}));

import { agentProcessApi, warnForUncertainStop } from '@/renderer/services/agent-process';
import type { AgentProcessStopResult } from '@/shared/types';

const result = (patch: Partial<AgentProcessStopResult> = {}): AgentProcessStopResult => ({
  scope: 'host',
  shutdown: 'graceful',
  ...patch,
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
