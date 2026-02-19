import { useStore } from '@nanostores/react';
import { atom } from 'nanostores';
import { useCallback, useEffect, useRef } from 'react';

import { emitter } from '@/renderer/services/ipc';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';

import {
  $omniInstallProcessStatus,
  $omniRuntimeInfo,
  $sandboxProcessStatus,
  omniInstallApi,
  refreshOmniRuntimeInfo,
  sandboxApi,
} from './state';

export type AutoLaunchPhase = 'checking' | 'installing' | 'ready' | 'starting' | 'waiting' | 'running' | 'error' | 'idle';

export const $autoLaunchPhase = atom<AutoLaunchPhase>('checking');
export const $autoLaunchError = atom<string | null>(null);

/**
 * Drives the auto-launch state machine. On first mount after initialization:
 * - If runtime is not installed, auto-installs it
 * - Once installed and workspace is set, auto-starts the sandbox
 * - Transitions to 'idle' after manual stop (no auto-restart)
 */
export const useAutoLaunch = () => {
  const initialized = useStore($initialized);
  const runtimeInfo = useStore($omniRuntimeInfo);
  const installStatus = useStore($omniInstallProcessStatus);
  const sandboxStatus = useStore($sandboxProcessStatus);
  const store = useStore(persistedStoreApi.$atom);
  const phase = useStore($autoLaunchPhase);

  // Track whether we've already auto-launched this session to prevent re-triggering after manual stop
  const hasAutoLaunched = useRef(false);
  // Track whether we triggered the install ourselves (vs user clicking reinstall in settings)
  const didTriggerInstall = useRef(false);
  // Track whether we triggered sandbox start ourselves
  const didTriggerStart = useRef(false);

  // Phase: checking → installing (if not installed)
  useEffect(() => {
    if (!initialized || phase !== 'checking') {
      return;
    }

    if (runtimeInfo.isInstalled) {
      // Already installed, move to ready
      $autoLaunchPhase.set('ready');
    } else if (!hasAutoLaunched.current) {
      // Not installed, auto-trigger install
      didTriggerInstall.current = true;
      omniInstallApi.startInstall(false);
      $autoLaunchPhase.set('installing');
    } else {
      // After a manual stop + retry, if still not installed, install again
      didTriggerInstall.current = true;
      omniInstallApi.startInstall(false);
      $autoLaunchPhase.set('installing');
    }
  }, [initialized, phase, runtimeInfo.isInstalled]);

  // Phase: installing → ready (when install completes) or → error
  useEffect(() => {
    if (phase !== 'installing') {
      return;
    }

    if (installStatus.type === 'completed') {
      refreshOmniRuntimeInfo();
      $autoLaunchPhase.set('ready');
      didTriggerInstall.current = false;
    } else if (installStatus.type === 'error') {
      $autoLaunchError.set(installStatus.error.message);
      $autoLaunchPhase.set('error');
      didTriggerInstall.current = false;
    } else if (installStatus.type === 'canceled') {
      $autoLaunchPhase.set('idle');
      didTriggerInstall.current = false;
    }
  }, [phase, installStatus]);

  // Phase: ready → starting (auto-start sandbox)
  useEffect(() => {
    if (phase !== 'ready') {
      return;
    }

    if (!store.workspaceDir) {
      $autoLaunchError.set('No workspace directory configured.');
      $autoLaunchPhase.set('error');
      return;
    }

    if (hasAutoLaunched.current) {
      // Already auto-launched once this session, go to idle instead of auto-starting again
      $autoLaunchPhase.set('idle');
      return;
    }

    hasAutoLaunched.current = true;
    didTriggerStart.current = true;
    sandboxApi.start({
      workspaceDir: store.workspaceDir,
      envFilePath: store.envFilePath,
      enableCodeServer: store.enableCodeServer,
      enableVnc: store.enableVnc,
      useWorkDockerfile: store.useWorkDockerfile,
    });
    $autoLaunchPhase.set('starting');
  }, [phase, store]);

  // Phase: starting → waiting (container up, wait for services) or → error
  useEffect(() => {
    if (phase !== 'starting') {
      return;
    }

    if (sandboxStatus.type === 'running') {
      $autoLaunchPhase.set('waiting');
      didTriggerStart.current = false;
    } else if (sandboxStatus.type === 'error') {
      $autoLaunchError.set(sandboxStatus.error.message);
      $autoLaunchPhase.set('error');
      didTriggerStart.current = false;
    } else if (sandboxStatus.type === 'exited') {
      $autoLaunchPhase.set('idle');
      didTriggerStart.current = false;
    }
  }, [phase, sandboxStatus]);

  // Phase: waiting → running (poll all service URLs until they respond)
  useEffect(() => {
    if (phase !== 'waiting' || sandboxStatus.type !== 'running') {
      return;
    }

    const { sandboxUrl, uiUrl, wsUrl, codeServerUrl, noVncUrl } = sandboxStatus.data;
    const httpUrls = [sandboxUrl, uiUrl, codeServerUrl, noVncUrl].filter((u): u is string => Boolean(u));

    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const checkAll = async () => {
      const results = await Promise.all([
        ...httpUrls.map((url) => emitter.invoke('util:check-url', url)),
        emitter.invoke('util:check-ws', wsUrl),
      ]);
      if (!active) {
        return;
      }
      if (results.every(Boolean)) {
        $autoLaunchPhase.set('running');
      } else {
        timer = setTimeout(() => {
          void checkAll();
        }, 2000);
      }
    };

    void checkAll();

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [phase, sandboxStatus]);

  // Transition running/waiting → idle when sandbox stops (user clicked Stop)
  useEffect(() => {
    if (phase !== 'running' && phase !== 'waiting') {
      return;
    }

    if (sandboxStatus.type === 'exited' || sandboxStatus.type === 'error') {
      $autoLaunchPhase.set('idle');
    }
  }, [phase, sandboxStatus]);

  const retry = useCallback(() => {
    $autoLaunchError.set(null);
    $autoLaunchPhase.set('checking');
  }, []);

  const launch = useCallback(() => {
    if (!store.workspaceDir) {
      return;
    }

    hasAutoLaunched.current = false;
    $autoLaunchPhase.set('ready');
  }, [store.workspaceDir]);

  return { phase, retry, launch };
};
