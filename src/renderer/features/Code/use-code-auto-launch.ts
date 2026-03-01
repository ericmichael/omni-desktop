import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  $omniInstallProcessStatus,
  $omniRuntimeInfo,
  omniInstallApi,
  refreshOmniRuntimeInfo,
} from '@/renderer/features/Omni/state';
import { emitter } from '@/renderer/services/ipc';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';
import type { CodeTabId } from '@/shared/types';

import { $codeTabErrors, $codeTabPhases, $codeTabStatuses, codeApi } from './state';

export type AutoLaunchPhase = 'checking' | 'installing' | 'ready' | 'starting' | 'running' | 'error' | 'idle';

/**
 * Per-tab auto-launch hook. Drives the sandbox lifecycle for a single Code tab.
 * Adapted from the global useAutoLaunch in Omni, but reads/writes per-tab atoms.
 */
export const useCodeAutoLaunch = (tabId: CodeTabId, workspaceDir: string | null) => {
  const initialized = useStore($initialized);
  const installStatus = useStore($omniInstallProcessStatus);
  const store = useStore(persistedStoreApi.$atom);

  const allStatuses = useStore($codeTabStatuses);
  const allPhases = useStore($codeTabPhases);
  const sandboxStatus = useMemo(
    () => allStatuses[tabId] ?? { type: 'uninitialized' as const, timestamp: Date.now() },
    [allStatuses, tabId]
  );
  const phase: AutoLaunchPhase = allPhases[tabId] ?? 'checking';

  const hasAutoLaunched = useRef(false);
  const didTriggerInstall = useRef(false);
  const didTriggerStart = useRef(false);
  const lastStartTimestamp = useRef<number | null>(null);

  const setPhase = useCallback(
    (p: AutoLaunchPhase) => {
      $codeTabPhases.setKey(tabId, p);
    },
    [tabId]
  );

  const setError = useCallback(
    (e: string | null) => {
      $codeTabErrors.setKey(tabId, e);
    },
    [tabId]
  );

  // Phase: checking → installing (if not installed) or → ready
  useEffect(() => {
    if (!initialized || phase !== 'checking' || !workspaceDir) {
      return;
    }

    let cancelled = false;
    refreshOmniRuntimeInfo().then(() => {
      if (cancelled) {
        return;
      }
      const info = $omniRuntimeInfo.get();
      if (info.isInstalled) {
        setPhase('ready');
      } else {
        didTriggerInstall.current = true;
        omniInstallApi.startInstall(false);
        setPhase('installing');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialized, phase, workspaceDir, setPhase]);

  // Phase: installing → ready or → error
  useEffect(() => {
    if (phase !== 'installing') {
      return;
    }
    if (installStatus.type === 'completed') {
      refreshOmniRuntimeInfo();
      setPhase('ready');
      didTriggerInstall.current = false;
    } else if (installStatus.type === 'error') {
      setError(installStatus.error.message);
      setPhase('error');
      didTriggerInstall.current = false;
    } else if (installStatus.type === 'canceled') {
      setPhase('idle');
      didTriggerInstall.current = false;
    }
  }, [phase, installStatus, setPhase, setError]);

  // Phase: ready → starting
  useEffect(() => {
    if (phase !== 'ready' || !workspaceDir) {
      return;
    }

    if (hasAutoLaunched.current) {
      setPhase('idle');
      return;
    }

    let cancelled = false;

    const startSandbox = async () => {
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
          await persistedStoreApi.setKey('onboardingComplete', false);
          return;
        }
      } catch {
        // proceed anyway
      }

      if (cancelled) {
        return;
      }

      hasAutoLaunched.current = true;
      didTriggerStart.current = true;
      lastStartTimestamp.current = Date.now();
      codeApi.startSandbox(tabId, {
        workspaceDir,
        sandboxVariant: store.sandboxVariant,
      });
      setPhase('starting');
    };

    void startSandbox();

    return () => {
      cancelled = true;
    };
  }, [phase, workspaceDir, store.sandboxVariant, tabId, setPhase]);

  // Phase: starting → running or → error/idle
  useEffect(() => {
    if (phase !== 'starting') {
      return;
    }
    if (sandboxStatus.type === 'running') {
      setPhase('running');
      didTriggerStart.current = false;
    } else if (sandboxStatus.type === 'error') {
      setError(sandboxStatus.error.message);
      setPhase('error');
      didTriggerStart.current = false;
    } else if (sandboxStatus.type === 'exited') {
      const startTs = lastStartTimestamp.current;
      if (!startTs || sandboxStatus.timestamp > startTs) {
        setPhase('idle');
        didTriggerStart.current = false;
      }
    }
  }, [phase, sandboxStatus, setPhase, setError]);

  // running → idle when sandbox stops
  useEffect(() => {
    if (phase !== 'running') {
      return;
    }
    if (sandboxStatus.type === 'exited' || sandboxStatus.type === 'error') {
      setPhase('idle');
    }
  }, [phase, sandboxStatus, setPhase]);

  const retry = useCallback(() => {
    setError(null);
    setPhase('checking');
  }, [setPhase, setError]);

  const launch = useCallback(() => {
    if (!workspaceDir) {
      return;
    }
    hasAutoLaunched.current = false;
    setPhase('ready');
  }, [workspaceDir, setPhase]);

  return { phase, retry, launch };
};
