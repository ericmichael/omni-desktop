import type * as Nanostores from 'nanostores';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { $omniRuntimeReadiness } from '@/renderer/features/Omni/state';
import { $agentStatuses, agentProcessApi } from '@/renderer/services/agent-process';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';
import type { AgentProcessStatus, StoreData, WithTimestamp } from '@/shared/types';

import { useAutoLaunch } from './use-auto-launch';

const invoke = vi.hoisted(() => vi.fn());
const setKey = vi.hoisted(() => vi.fn());
const start = vi.hoisted(() => vi.fn());
const stop = vi.hoisted(() => vi.fn());
const switchSandbox = vi.hoisted(() => vi.fn());
const successToast = vi.hoisted(() => vi.fn());
const errorToast = vi.hoisted(() => vi.fn());
const warningToast = vi.hoisted(() => vi.fn());

vi.mock('@/renderer/services/ipc', () => ({
  emitter: { invoke },
  ipc: { on: vi.fn(() => () => {}) },
}));

vi.mock('@/renderer/services/store', async () => {
  const { atom } = await vi.importActual<typeof Nanostores>('nanostores');
  return {
    $initialized: atom(true),
    persistedStoreApi: {
      $atom: atom({ defaultProfileName: 'host' }),
      setKey,
    },
  };
});

vi.mock('@/renderer/features/Omni/state', async () => {
  const { atom } = await vi.importActual<typeof Nanostores>('nanostores');
  return {
    $omniRuntimeReadiness: atom({ status: 'ready' }),
    ensureRuntimeReady: vi.fn(),
    retryRuntimeCheck: vi.fn(),
  };
});

vi.mock('@/renderer/services/agent-process', async () => {
  const { map } = await vi.importActual<typeof Nanostores>('nanostores');
  return {
    $agentStatuses: map({}),
    agentProcessApi: {
      start,
      stop,
      switchSandbox,
    },
  };
});

vi.mock('@/renderer/features/SandboxProfile/profile-list', () => ({
  getProfileMenuLabel: (profileName: string) => profileName,
}));

vi.mock('@/renderer/features/Toast/state', () => ({
  toast: {
    success: successToast,
    error: errorToast,
    warning: warningToast,
  },
}));

vi.mock('@/shared/machines/machine-logger', () => ({
  createMachineLogger: () => () => {},
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookProps = Parameters<typeof useAutoLaunch>[0];

let container: HTMLDivElement;
let root: Root;

const runningStatus = (): WithTimestamp<AgentProcessStatus> => ({
  type: 'running',
  timestamp: Date.now(),
  data: { uiUrl: 'http://127.0.0.1:3000' },
});

function HookHarness(props: HookProps) {
  useAutoLaunch(props);
  return null;
}

async function renderHook(props: HookProps) {
  await act(async () => {
    root.render(<HookHarness {...props} />);
    await flushEffects();
  });
}

async function flushEffects() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  ($initialized as { set: (value: boolean) => void }).set(true);
  ($omniRuntimeReadiness as { set: (value: { status: 'ready' }) => void }).set({ status: 'ready' });
  (persistedStoreApi.$atom as unknown as { set: (value: Partial<StoreData>) => void }).set({
    defaultProfileName: 'host',
  });
  $agentStatuses.set({});

  invoke.mockImplementation((channel: string, processId?: string) => {
    if (channel === 'settings:get-models-config') {
      return Promise.resolve({ providers: { openai: {} } });
    }
    if (channel === 'agent-process:get-status' && processId) {
      return Promise.resolve($agentStatuses.get()[processId] ?? { type: 'uninitialized', timestamp: Date.now() });
    }
    return Promise.resolve();
  });
  switchSandbox.mockResolvedValue({ ok: true });
  stop.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

describe('useAutoLaunch sandbox profile override switching', () => {
  it('does not switch sandboxes when the profile override changes before launch', async () => {
    await renderHook({
      processId: 'code-tab-1',
      workspaceDir: null,
      profileNameOverride: 'host',
    });

    await renderHook({
      processId: 'code-tab-1',
      workspaceDir: null,
      profileNameOverride: 'devbox',
    });

    expect(agentProcessApi.switchSandbox).not.toHaveBeenCalled();
  });

  it('switches sandboxes when the profile override changes for a running session', async () => {
    $agentStatuses.set({ 'code-tab-1': runningStatus() });

    await renderHook({
      processId: 'code-tab-1',
      workspaceDir: '/workspace/project',
      profileNameOverride: 'host',
    });
    await flushEffects();

    await renderHook({
      processId: 'code-tab-1',
      workspaceDir: '/workspace/project',
      profileNameOverride: 'devbox',
    });

    expect(agentProcessApi.switchSandbox).toHaveBeenCalledWith('code-tab-1', 'devbox');
  });
});
