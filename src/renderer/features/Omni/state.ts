import { objectEquals } from '@observ33r/object-equals';
import { Terminal } from '@xterm/xterm';
import { atom } from 'nanostores';

import { DEFAULT_XTERM_OPTIONS, STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { OmniInstallProcessStatus, OmniRuntimeInfo, SandboxProcessStatus, WithTimestamp } from '@/shared/types';

export const $omniRuntimeInfo = atom<OmniRuntimeInfo>({ isInstalled: false });

export const refreshOmniRuntimeInfo = async () => {
  const info = await emitter.invoke('util:get-omni-runtime-info');
  $omniRuntimeInfo.set(info);
};

refreshOmniRuntimeInfo();

export const $omniInstallProcessStatus = atom<WithTimestamp<OmniInstallProcessStatus>>({
  type: 'uninitialized',
  timestamp: Date.now(),
});

export const $omniInstallProcessXTerm = atom<Terminal | null>(null);
const omniInstallTerminalSubscriptions = new Set<() => void>();

const initializeOmniInstallTerminal = (): Terminal => {
  let xterm = $omniInstallProcessXTerm.get();

  if (xterm) {
    return xterm;
  }

  xterm = new Terminal({ ...DEFAULT_XTERM_OPTIONS, disableStdin: true });

  omniInstallTerminalSubscriptions.add(
    ipc.on('omni-install-process:raw-output', (_, data) => {
      xterm.write(data);
    })
  );

  omniInstallTerminalSubscriptions.add(
    xterm.onResize(({ cols, rows }) => {
      emitter.invoke('omni-install-process:resize', cols, rows);
    }).dispose
  );

  $omniInstallProcessXTerm.set(xterm);
  return xterm;
};

const teardownOmniInstallTerminal = () => {
  for (const unsubscribe of omniInstallTerminalSubscriptions) {
    unsubscribe();
  }
  omniInstallTerminalSubscriptions.clear();

  const xterm = $omniInstallProcessXTerm.get();
  if (!xterm) {
    return;
  }
  xterm.dispose();
  $omniInstallProcessXTerm.set(null);
};

export const omniInstallApi = {
  startInstall: (repair?: boolean) => {
    initializeOmniInstallTerminal();
    emitter.invoke('omni-install-process:start-install', repair);
  },
  cancelInstall: async () => {
    await emitter.invoke('omni-install-process:cancel-install');
  },
};

export const $sandboxProcessStatus = atom<WithTimestamp<SandboxProcessStatus>>({
  type: 'uninitialized',
  timestamp: Date.now(),
});

export const $sandboxProcessXTerm = atom<Terminal | null>(null);
const sandboxTerminalSubscriptions = new Set<() => void>();

const initializeSandboxTerminal = (): Terminal => {
  let xterm = $sandboxProcessXTerm.get();

  if (xterm) {
    return xterm;
  }

  xterm = new Terminal({ ...DEFAULT_XTERM_OPTIONS, disableStdin: true });

  sandboxTerminalSubscriptions.add(
    ipc.on('sandbox-process:raw-output', (_, data) => {
      xterm.write(data);
    })
  );

  sandboxTerminalSubscriptions.add(
    xterm.onResize(({ cols, rows }) => {
      emitter.invoke('sandbox-process:resize', cols, rows);
    }).dispose
  );

  $sandboxProcessXTerm.set(xterm);
  return xterm;
};

const teardownSandboxTerminal = () => {
  for (const unsubscribe of sandboxTerminalSubscriptions) {
    unsubscribe();
  }
  sandboxTerminalSubscriptions.clear();

  const xterm = $sandboxProcessXTerm.get();
  if (!xterm) {
    return;
  }
  xterm.dispose();
  $sandboxProcessXTerm.set(null);
};

export const sandboxApi = {
  start: (arg: {
    workspaceDir: string;
    envFilePath?: string;
    enableCodeServer: boolean;
    enableVnc: boolean;
    useWorkDockerfile: boolean;
  }) => {
    initializeSandboxTerminal();
    emitter.invoke('sandbox-process:start', arg);
  },
  stop: async () => {
    await emitter.invoke('sandbox-process:stop');
    teardownSandboxTerminal();
  },
};

const listen = () => {
  ipc.on('omni-install-process:status', (_, status) => {
    $omniInstallProcessStatus.set(status);
    if (status.type === 'completed') {
      refreshOmniRuntimeInfo();
      teardownOmniInstallTerminal();
    }
  });

  ipc.on('sandbox-process:status', (_, status) => {
    $sandboxProcessStatus.set(status);
    if (status.type === 'exited') {
      teardownSandboxTerminal();
    }
  });

  const pollOmniInstall = async () => {
    const oldStatus = $omniInstallProcessStatus.get();
    const newStatus = await emitter.invoke('omni-install-process:get-status');
    if (objectEquals(oldStatus, newStatus)) {
      return;
    }
    $omniInstallProcessStatus.set(newStatus);
  };

  const pollSandbox = async () => {
    const oldStatus = $sandboxProcessStatus.get();
    const newStatus = await emitter.invoke('sandbox-process:get-status');
    if (objectEquals(oldStatus, newStatus)) {
      return;
    }
    $sandboxProcessStatus.set(newStatus);
  };

  setInterval(pollOmniInstall, STATUS_POLL_INTERVAL_MS);
  setInterval(pollSandbox, STATUS_POLL_INTERVAL_MS);
};

listen();
