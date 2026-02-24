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

export type AutoLaunchPhase = 'checking' | 'installing' | 'ready' | 'starting' | 'running' | 'error' | 'idle';

export const $autoLaunchPhase = atom<AutoLaunchPhase>('checking');
export const $autoLaunchError = atom<string | null>(null);

/**
 * Drives the auto-launch state machine. On first mount after initialization:
 * - If runtime is not installed, auto-installs it
 * - Once installed and workspace is set, auto-starts the sandbox
 * - Transitions to 'idle' after manual stop (no auto-restart)
 *
 * Phase progression: checking → installing → ready → starting → running
 * The CLI confirms services are up before emitting JSON, so we skip URL polling
 * and go directly from 'starting' to 'running'.
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
  const lastStartTimestamp = useRef<number | null>(null);

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
  // Checks model configuration before launching. If models aren't configured, resets onboarding
  // so the wizard is shown instead of a cryptic runtime error.
  // Skipped when layoutMode is 'chat' — the Chat tab handles its own launch.
  useEffect(() => {
    if (phase !== 'ready') {
      return;
    }

    if (store.layoutMode === 'chat') {
      $autoLaunchPhase.set('idle');
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

    let cancelled = false;

    const startSandbox = async () => {
      // Verify models are configured before attempting sandbox start.
      // Reads models.json directly instead of using the CLI, so this works even if the runtime isn't installed yet.
      try {
        const configDir = await emitter.invoke('config:get-omni-config-dir');
        const modelsConfig = (await emitter.invoke('config:read-json-file', `${configDir}/models.json`)) as {
          providers?: Record<string, unknown>;
        } | null;
        const hasProviders = modelsConfig?.providers && Object.keys(modelsConfig.providers).length > 0;

        if (cancelled) {
          return;
        }

        if (!hasProviders) {
          // Reset onboarding so the wizard is shown
          await persistedStoreApi.setKey('onboardingComplete', false);
          return;
        }
      } catch {
        // If we can't read the file, proceed anyway and let the sandbox report the error
      }

      if (cancelled) {
        return;
      }

      hasAutoLaunched.current = true;
      didTriggerStart.current = true;
      lastStartTimestamp.current = Date.now();
      sandboxApi.start({
        workspaceDir: store.workspaceDir!,
        useWorkDockerfile: store.useWorkDockerfile,
      });
      $autoLaunchPhase.set('starting');
    };

    void startSandbox();

    return () => {
      cancelled = true;
    };
  }, [phase, store]);

  // Phase: starting → running (CLI confirmed services up) or → error/idle
  useEffect(() => {
    if (phase !== 'starting') {
      return;
    }

    if (sandboxStatus.type === 'running') {
      $autoLaunchPhase.set('running');
      didTriggerStart.current = false;
    } else if (sandboxStatus.type === 'error') {
      $autoLaunchError.set(sandboxStatus.error.message);
      $autoLaunchPhase.set('error');
      didTriggerStart.current = false;
    } else if (sandboxStatus.type === 'exited') {
      const startTs = lastStartTimestamp.current;
      if (!startTs || sandboxStatus.timestamp > startTs) {
        $autoLaunchPhase.set('idle');
        didTriggerStart.current = false;
      }
    }
  }, [phase, sandboxStatus]);

  // Transition running → idle when sandbox stops (user clicked Stop)
  useEffect(() => {
    if (phase !== 'running') {
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
