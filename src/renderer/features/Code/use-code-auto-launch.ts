import { useStore } from '@nanostores/react';
import { useActorRef, useSelector } from '@xstate/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { fromCallback } from 'xstate';

import {
  $omniInstallProcessStatus,
  $omniRuntimeInfo,
  omniInstallApi,
  refreshOmniRuntimeInfo,
} from '@/renderer/features/Omni/state';
import { emitter } from '@/renderer/services/ipc';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';
import { autoLaunchMachine, type AutoLaunchEvent, type AutoLaunchPhase } from '@/shared/machines/auto-launch.machine';
import { createMachineLogger } from '@/shared/machines/machine-logger';
import type { CodeTabId } from '@/shared/types';

import { $codeTabErrors, $codeTabPhases, $codeTabStatuses, codeApi } from './state';

export type { AutoLaunchPhase };

/**
 * Per-tab auto-launch hook. Drives the sandbox lifecycle for a single Code tab.
 *
 * Side effects are driven by XState invoke actors — no phase-gated useEffects.
 * The machine invokes the correct service when entering each state, and XState
 * automatically cleans up (calls the returned dispose fn) on state exit.
 */
export const useCodeAutoLaunch = (tabId: CodeTabId, workspaceDir: string | null) => {
  const initialized = useStore($initialized);
  const store = useStore(persistedStoreApi.$atom);

  // Refs for mutable values so actor callbacks always see current values
  // without causing the actors object to be recreated.
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;
  const workspaceDirRef = useRef(workspaceDir);
  workspaceDirRef.current = workspaceDir;
  const previousWorkspaceDirRef = useRef(workspaceDir);
  const storeRef = useRef(store);
  storeRef.current = store;

  // Stable actor implementations — read mutable values from refs
  const actors = useMemo(() => ({
    checkRuntime: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
      let cancelled = false;
      refreshOmniRuntimeInfo()
        .then(() => {
          if (cancelled) return;
          const info = $omniRuntimeInfo.get();
          if (info.isInstalled && !info.isOutdated) {
            sendBack({ type: 'RUNTIME_READY' });
          } else {
            omniInstallApi.startInstall(info.isInstalled && info.isOutdated);
            sendBack({ type: 'RUNTIME_OUTDATED' });
          }
        })
        .catch((err) => {
          if (!cancelled) sendBack({ type: 'RUNTIME_CHECK_FAILED', error: String(err) });
        });
      return () => { cancelled = true; };
    }),

    watchInstallStatus: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
      const unsub = $omniInstallProcessStatus.subscribe((status) => {
        if (status.type === 'completed') {
          refreshOmniRuntimeInfo();
          sendBack({ type: 'INSTALL_COMPLETED' });
        } else if (status.type === 'error') {
          sendBack({ type: 'INSTALL_FAILED', error: status.error.message });
        } else if (status.type === 'canceled') {
          sendBack({ type: 'INSTALL_CANCELLED' });
        }
      });
      return unsub;
    }),

    checkConfigAndStart: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
      const wd = workspaceDirRef.current;
      if (!wd) {
        sendBack({ type: 'CONFIG_MISSING' });
        return;
      }
      let cancelled = false;
      (async () => {
        try {
          const configDir = await emitter.invoke('config:get-omni-config-dir');
          const modelsConfig = (await emitter.invoke('config:read-json-file', `${configDir}/models.json`)) as {
            providers?: Record<string, unknown>;
          } | null;
          const hasProviders = modelsConfig?.providers && Object.keys(modelsConfig.providers).length > 0;
          if (cancelled) return;
          if (!hasProviders) {
            await persistedStoreApi.setKey('onboardingComplete', false);
            sendBack({ type: 'CONFIG_MISSING' });
            return;
          }
        } catch {
          if (cancelled) return;
        }
        if (cancelled) return;
        // If a supervisor sandbox is already providing status for this tab
        // (e.g. auto-pilot started the sandbox), skip launching a duplicate.
        const existing = $codeTabStatuses.get()[tabIdRef.current];
        if (existing && (existing.type === 'running' || existing.type === 'connecting' || existing.type === 'starting')) {
          sendBack({ type: 'CONFIG_OK' });
          return;
        }
        // Also check if the supervisor (ProjectManager) owns a sandbox for this tab's ticket
        try {
          const supervisorStatus = await emitter.invoke('project:get-supervisor-sandbox-status', tabIdRef.current);
          if (!cancelled && supervisorStatus && (supervisorStatus.type === 'running' || supervisorStatus.type === 'connecting' || supervisorStatus.type === 'starting')) {
            $codeTabStatuses.setKey(tabIdRef.current, supervisorStatus);
            sendBack({ type: 'CONFIG_OK' });
            return;
          }
        } catch { /* no supervisor sandbox — proceed normally */ }
        if (cancelled) return;
        codeApi.startSandbox(tabIdRef.current, {
          workspaceDir: wd,
          sandboxVariant: storeRef.current.sandboxVariant,
          local: !storeRef.current.sandboxEnabled,
        });
        sendBack({ type: 'CONFIG_OK' });
      })();
      return () => { cancelled = true; };
    }),

    watchProcessStatus: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
      let cancelled = false;
      let lastSentType: string | null = null;

      // Seed the atom with the current server-side status so we don't miss
      // a transition that happened before this page load (push-only means
      // the atom is empty until the next status change).
      emitter.invoke('code:get-sandbox-status', tabIdRef.current).then((status) => {
        if (cancelled || !status || status.type === 'uninitialized') return;
        $codeTabStatuses.setKey(tabIdRef.current, status);
      }).catch(() => {});
      // Also check supervisor sandbox (ProjectManager) — in server mode the
      // per-client CodeManager won't know about it.
      emitter.invoke('project:get-supervisor-sandbox-status', tabIdRef.current).then((status) => {
        if (cancelled || !status || status.type === 'uninitialized') return;
        // Only set if the atom is still empty or uninitialized for this tab
        const current = $codeTabStatuses.get()[tabIdRef.current];
        if (!current || current.type === 'uninitialized') {
          $codeTabStatuses.setKey(tabIdRef.current, status);
        }
      }).catch(() => {});

      const unsub = $codeTabStatuses.subscribe((allStatuses) => {
        const tid = tabIdRef.current;
        const status = allStatuses[tid];
        if (!status) return;
        // Skip if the status type hasn't changed — avoids redundant events
        // when other tabs update the shared map or polling refreshes timestamps.
        if (status.type === lastSentType) return;
        lastSentType = status.type;
        if (status.type === 'running' || status.type === 'connecting') sendBack({ type: 'SANDBOX_RUNNING' });
        else if (status.type === 'error') sendBack({ type: 'SANDBOX_ERROR', error: status.error.message });
        else if (status.type === 'exited') sendBack({ type: 'SANDBOX_EXITED' });
      });
      return () => { cancelled = true; unsub(); };
    }),
  }), []); // eslint-disable-line react-hooks/exhaustive-deps -- reads from refs

  const inspect = useMemo(() => createMachineLogger('autoLaunch:code', {
    tags: { tab: tabId, workspace: workspaceDir ?? 'none' },
  }), [tabId, workspaceDir]);

  const machine = useMemo(() => autoLaunchMachine.provide({ actors }), [actors]);
  const actor = useActorRef(machine, { inspect });
  const phase = useSelector(actor, (snap) => snap.value as AutoLaunchPhase);

  // Sync machine state → nanostore atoms (for non-React consumers)
  useEffect(() => {
    const sub = actor.subscribe((snapshot) => {
      $codeTabPhases.setKey(tabId, snapshot.value as AutoLaunchPhase);
      $codeTabErrors.setKey(tabId, snapshot.context.error);
    });
    return () => sub.unsubscribe();
  }, [actor, tabId]);

  // Trigger: send LAUNCH when initialized + workspace available
  useEffect(() => {
    if (!initialized || !workspaceDir) return;
    const snap = actor.getSnapshot();
    if (snap.value === 'idle' && !snap.context.hasLaunched) {
      actor.send({ type: 'LAUNCH' });
    }
  }, [initialized, workspaceDir, actor]);

  useEffect(() => {
    const previousWorkspaceDir = previousWorkspaceDirRef.current;
    previousWorkspaceDirRef.current = workspaceDir;

    if (!initialized || !workspaceDir || !previousWorkspaceDir || previousWorkspaceDir === workspaceDir) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const supervisorStatus = await emitter.invoke('project:get-supervisor-sandbox-status', tabId);
        if (
          !cancelled &&
          supervisorStatus &&
          (supervisorStatus.type === 'running' || supervisorStatus.type === 'connecting' || supervisorStatus.type === 'starting')
        ) {
          return;
        }
      } catch {
      }

      if (cancelled) {
        return;
      }

      await codeApi.stopSandbox(tabId);
      if (cancelled) {
        return;
      }
      actor.send({ type: 'RESET' });
    })();

    return () => {
      cancelled = true;
    };
  }, [initialized, workspaceDir, actor, tabId]);

  const retry = useCallback(() => {
    actor.send({ type: 'RETRY' });
  }, [actor]);

  const launch = useCallback(() => {
    if (!workspaceDir) return;
    actor.send({ type: 'RELAUNCH' });
  }, [workspaceDir, actor]);

  return { phase, retry, launch };
};
