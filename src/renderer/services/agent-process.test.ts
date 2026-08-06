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
  snapshotPersistence: 'complete',
  pendingSnapshotRefs: [],
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
      'Sandbox force-closed',
      'The agent host could not finish a graceful shutdown. No pending workspace snapshots were reported.',
      { durationMs: 12_000 }
    );
  });

  it('lists only safe snapshot identifiers in an uncertainty warning', () => {
    warnForUncertainStop(
      result({
        snapshotPersistence: 'uncertain',
        pendingSnapshotRefs: ['snapshot-123', '../../private/key', 'token=secret', 'snapshot-456'],
      })
    );

    expect(hoisted.warning).toHaveBeenCalledTimes(1);
    const [title, description, options] = hoisted.warning.mock.calls[0]!;
    expect(title).toBe('Workspace snapshot may not be saved');
    expect(description).toContain('4 workspace snapshots (snapshot-123, snapshot-456, +2 more)');
    expect(description).not.toContain('../../private/key');
    expect(description).not.toContain('token=secret');
    expect(options).toEqual({ durationMs: 12_000 });
  });

  it('does not warn for a graceful stop with complete persistence or a version-skewed empty result', () => {
    warnForUncertainStop(result());
    warnForUncertainStop(undefined);

    expect(hoisted.warning).not.toHaveBeenCalled();
  });
});
