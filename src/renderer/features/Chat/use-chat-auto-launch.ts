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

import { $chatProcessStatus, chatApi } from './state';

export type ChatAutoLaunchPhase = AutoLaunchPhase;

/**
 * Unified auto-launch hook for Chat. ChatManager handles all modes
 * (local, sandbox/docker, podman, vm, platform) via AgentProcess.
 *
 * Side effects are driven by XState invoke actors — no phase-gated useEffects.
 */
export const useChatAutoLaunch = () => {
  const initialized = useStore($initialized);
  const store = useStore(persistedStoreApi.$atom);
  const sandboxEnabled = store.sandboxEnabled;

  // Refs for mutable values so actor callbacks always see current values
  const storeRef = useRef(store);
  storeRef.current = store;

  // Stable actor implementations
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
      const s = storeRef.current;
      if (!s.workspaceDir) {
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
        chatApi.start({
          workspaceDir: s.workspaceDir!,
          sandboxVariant: s.sandboxVariant,
        });
        sendBack({ type: 'CONFIG_OK' });
      })();
      return () => { cancelled = true; };
    }),

    watchProcessStatus: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
      let cancelled = false;

      // Seed the atom with the current server-side status so we don't miss
      // a transition that happened before this page load.
      emitter.invoke('chat-process:get-status').then((status) => {
        if (cancelled || !status || status.type === 'uninitialized') return;
        $chatProcessStatus.set(status);
      }).catch(() => {});

      const unsub = $chatProcessStatus.subscribe((status) => {
        if (status.type === 'running' || status.type === 'connecting') {
          sendBack({ type: 'SANDBOX_RUNNING' });
        } else if (status.type === 'error') {
          sendBack({ type: 'SANDBOX_ERROR', error: status.error.message });
        } else if (status.type === 'exited') {
          sendBack({ type: 'SANDBOX_EXITED' });
        }
      });
      return () => { cancelled = true; unsub(); };
    }),
  }), []); // eslint-disable-line react-hooks/exhaustive-deps -- reads from refs

  const inspect = useMemo(() => createMachineLogger('autoLaunch:chat', {
    tags: { sandbox: sandboxEnabled ? (store.sandboxBackend ?? 'docker') : 'local' },
  }), [sandboxEnabled, store.sandboxBackend]);

  const machine = useMemo(() => autoLaunchMachine.provide({ actors }), [actors]);
  const actor = useActorRef(machine, { inspect });
  const phase = useSelector(actor, (snap) => snap.value as AutoLaunchPhase);
  const error = useSelector(actor, (snap) => snap.context.error);

  // Reset when sandboxEnabled or sandboxBackend changes
  const lastSandboxEnabled = useRef(sandboxEnabled);
  const lastSandboxBackend = useRef(store.sandboxBackend);
  useEffect(() => {
    if (lastSandboxEnabled.current !== sandboxEnabled || lastSandboxBackend.current !== store.sandboxBackend) {
      lastSandboxEnabled.current = sandboxEnabled;
      lastSandboxBackend.current = store.sandboxBackend;
      actor.send({ type: 'RESET' });
      if (initialized) {
        actor.send({ type: 'LAUNCH' });
      }
    }
  }, [sandboxEnabled, store.sandboxBackend, initialized, actor]);

  // Trigger: send LAUNCH when initialized
  useEffect(() => {
    if (!initialized) return;
    const snap = actor.getSnapshot();
    if (snap.value === 'idle' && !snap.context.hasLaunched) {
      actor.send({ type: 'LAUNCH' });
    }
  }, [initialized, actor]);

  const retry = useCallback(() => {
    actor.send({ type: 'RETRY' });
  }, [actor]);

  const launch = useCallback(() => {
    if (!store.workspaceDir) return;
    actor.send({ type: 'RELAUNCH' });
  }, [store.workspaceDir, actor]);

  return { phase, error, retry, launch, sandboxEnabled };
};
