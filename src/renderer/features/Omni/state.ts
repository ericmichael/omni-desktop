import { objectEquals } from '@observ33r/object-equals';
import { Terminal } from '@xterm/xterm';
import { atom } from 'nanostores';

import { DEFAULT_XTERM_OPTIONS, STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import { emitter, ipc } from '@/renderer/services/ipc';
import type {
  OmniInstallProcessStatus,
  OmniRuntimeInfo,
  WithTimestamp,
} from '@/shared/types';

export const $omniRuntimeInfo = atom<OmniRuntimeInfo>({ isInstalled: false });

export const refreshOmniRuntimeInfo = async () => {
  const info = await emitter.invoke('util:get-omni-runtime-info');
  $omniRuntimeInfo.set(info);
};

// ---------------------------------------------------------------------------
// Global runtime readiness — checked once, observed by all sessions
// ---------------------------------------------------------------------------

export type OmniRuntimeReadiness =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'installing' }
  | { status: 'ready' }
  | { status: 'error'; error: string };

export const $omniRuntimeReadiness = atom<OmniRuntimeReadiness>({ status: 'idle' });

let installUnsub: (() => void) | null = null;

export const ensureRuntimeReady = () => {
  const current = $omniRuntimeReadiness.get();
  if (current.status === 'checking' || current.status === 'installing' || current.status === 'ready') {
return;
}

  $omniRuntimeReadiness.set({ status: 'checking' });

  refreshOmniRuntimeInfo()
    .then(() => {
      const info = $omniRuntimeInfo.get();
      if (info.isInstalled && !info.isOutdated) {
        $omniRuntimeReadiness.set({ status: 'ready' });
      } else {
        omniInstallApi.startInstall(info.isInstalled && info.isOutdated);
        $omniRuntimeReadiness.set({ status: 'installing' });

        installUnsub?.();
        installUnsub = $omniInstallProcessStatus.subscribe((status) => {
          if (status.type === 'completed') {
            installUnsub?.();
            installUnsub = null;
            $omniRuntimeReadiness.set({ status: 'ready' });
          } else if (status.type === 'error') {
            installUnsub?.();
            installUnsub = null;
            $omniRuntimeReadiness.set({ status: 'error', error: status.error.message });
          } else if (status.type === 'canceled') {
            installUnsub?.();
            installUnsub = null;
            $omniRuntimeReadiness.set({ status: 'idle' });
          }
        });
      }
    })
    .catch((err) => {
      $omniRuntimeReadiness.set({ status: 'error', error: String(err) });
    });
};

export const retryRuntimeCheck = () => {
  installUnsub?.();
  installUnsub = null;
  $omniRuntimeReadiness.set({ status: 'idle' });
  ensureRuntimeReady();
};

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
    ipc.on('omni-install-process:raw-output', (data) => {
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

const listen = () => {
  ipc.on('omni-install-process:status', (status) => {
    $omniInstallProcessStatus.set(status);
    if (status.type === 'completed') {
      refreshOmniRuntimeInfo();
      teardownOmniInstallTerminal();
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

  setInterval(pollOmniInstall, STATUS_POLL_INTERVAL_MS);
};

listen();

ensureRuntimeReady();
