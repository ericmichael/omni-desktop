import { useStore } from '@nanostores/react';
import { useActorRef, useSelector } from '@xstate/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { fromCallback } from 'xstate';

import {
  $omniRuntimeReadiness,
  ensureRuntimeReady,
  type OmniRuntimeReadiness,
  retryRuntimeCheck,
} from '@/renderer/features/Omni/state';
import { $agentStatuses, agentProcessApi } from '@/renderer/services/agent-process';
import { emitter } from '@/renderer/services/ipc';
import { $initialized, persistedStoreApi } from '@/renderer/services/store';
import { type AutoLaunchEvent, autoLaunchMachine, type AutoLaunchPhase } from '@/shared/machines/auto-launch.machine';
import { createMachineLogger } from '@/shared/machines/machine-logger';

export type { AutoLaunchPhase };

type UseAutoLaunchOptions = {
  /** Unique process identifier — "chat" or a CodeTabId. */
  processId: string;
  /** Workspace directory. When null the machine won't launch. */
  workspaceDir: string | null;
  /**
   * When true, check `project:get-supervisor-sandbox-status` before starting
   * to avoid launching a duplicate sandbox when a supervisor already owns one.
   */
  supervisorAware?: boolean;
  /** Logger tag. */
  logLabel?: string;
};

/**
 * Unified auto-launch hook. Drives the sandbox lifecycle for any agent process.
 *
 * Side effects are driven by XState invoke actors — no phase-gated useEffects.
 */
export const useAutoLaunch = (opts: UseAutoLaunchOptions) => {
  const { processId, supervisorAware = false, logLabel } = opts;
  const initialized = useStore($initialized);
  const store = useStore(persistedStoreApi.$atom);
  const sandboxEnabled = store.sandboxBackend !== 'none';

  // Refs so actor callbacks always see current values without recreating the actors object
  const processIdRef = useRef(processId);
  processIdRef.current = processId;
  const workspaceDirRef = useRef(opts.workspaceDir);
  workspaceDirRef.current = opts.workspaceDir;
  const previousWorkspaceDirRef = useRef(opts.workspaceDir);
  const storeRef = useRef(store);
  storeRef.current = store;
  const supervisorAwareRef = useRef(supervisorAware);
  supervisorAwareRef.current = supervisorAware;

  const actors = useMemo(() => ({
    checkRuntime: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
      const check = (val: OmniRuntimeReadiness) => {
        if (val.status === 'ready') {
 sendBack({ type: 'RUNTIME_READY' }); return true; 
}
        if (val.status === 'installing') {
 sendBack({ type: 'RUNTIME_OUTDATED' }); return true; 
}
        if (val.status === 'error') {
 sendBack({ type: 'RUNTIME_CHECK_FAILED', error: val.error }); return true; 
}
        return false;
      };

      const current = $omniRuntimeReadiness.get();
      if (current.status === 'idle') {
ensureRuntimeReady();
} else if (current.status === 'error') {
retryRuntimeCheck();
}

      if (check($omniRuntimeReadiness.get())) {
return () => {};
}
      const unsub = $omniRuntimeReadiness.subscribe((val) => check(val));
      return unsub;
    }),

    watchInstallStatus: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
      const unsub = $omniRuntimeReadiness.subscribe((val) => {
        if (val.status === 'ready') {
sendBack({ type: 'INSTALL_COMPLETED' });
} else if (val.status === 'error') {
sendBack({ type: 'INSTALL_FAILED', error: val.error });
} else if (val.status === 'idle') {
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
          if (cancelled) {
return;
}
          if (!hasProviders) {
            await persistedStoreApi.setKey('onboardingComplete', false);
            sendBack({ type: 'CONFIG_MISSING' });
            return;
          }
        } catch {
          if (cancelled) {
return;
}
        }
        if (cancelled) {
return;
}

        // If supervisor-aware, check for an existing supervisor sandbox first
        if (supervisorAwareRef.current) {
          const existing = $agentStatuses.get()[processIdRef.current];
          if (existing && (existing.type === 'running' || existing.type === 'connecting' || existing.type === 'starting')) {
            sendBack({ type: 'CONFIG_OK' });
            return;
          }
          try {
            const supervisorStatus = await emitter.invoke('project:get-supervisor-sandbox-status', processIdRef.current);
            if (!cancelled && supervisorStatus && (supervisorStatus.type === 'running' || supervisorStatus.type === 'connecting' || supervisorStatus.type === 'starting')) {
              $agentStatuses.setKey(processIdRef.current, supervisorStatus);
              sendBack({ type: 'CONFIG_OK' });
              return;
            }
          } catch { /* no supervisor sandbox */ }
          if (cancelled) {
return;
}
        }

        agentProcessApi.start(processIdRef.current, { workspaceDir: wd });
        sendBack({ type: 'CONFIG_OK' });
      })();
      return () => {
 cancelled = true; 
};
    }),

    watchProcessStatus: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
      let cancelled = false;
      let lastSentType: string | null = null;

      // Seed with current server-side status
      emitter.invoke('agent-process:get-status', processIdRef.current).then((status) => {
        if (cancelled || !status || status.type === 'uninitialized') {
return;
}
        $agentStatuses.setKey(processIdRef.current, status);
      }).catch(() => {});

      // Also check supervisor sandbox if applicable
      if (supervisorAwareRef.current) {
        emitter.invoke('project:get-supervisor-sandbox-status', processIdRef.current).then((status) => {
          if (cancelled || !status || status.type === 'uninitialized') {
return;
}
          const current = $agentStatuses.get()[processIdRef.current];
          if (!current || current.type === 'uninitialized') {
            $agentStatuses.setKey(processIdRef.current, status);
          }
        }).catch(() => {});
      }

      const unsub = $agentStatuses.subscribe((allStatuses) => {
        const status = allStatuses[processIdRef.current];
        if (!status) {
return;
}
        if (status.type === lastSentType) {
return;
}
        lastSentType = status.type;
        if (status.type === 'running' || status.type === 'connecting') {
sendBack({ type: 'SANDBOX_RUNNING' });
} else if (status.type === 'error') {
sendBack({ type: 'SANDBOX_ERROR', error: status.error.message });
} else if (status.type === 'exited') {
sendBack({ type: 'SANDBOX_EXITED' });
}
      });
      return () => {
 cancelled = true; unsub(); 
};
    }),
  }), []);  

  const inspect = useMemo(() => createMachineLogger(logLabel ?? `autoLaunch:${processId}`, {
    tags: { sandbox: store.sandboxBackend ?? 'none' },
  }), [processId, logLabel, store.sandboxBackend]);

  const machine = useMemo(() => autoLaunchMachine.provide({ actors }), [actors]);
  const actor = useActorRef(machine, { inspect });
  const phase = useSelector(actor, (snap) => snap.value as AutoLaunchPhase);
  const error = useSelector(actor, (snap) => snap.context.error);

  // Reset when sandbox backend changes
  const lastSandboxBackend = useRef(store.sandboxBackend);
  useEffect(() => {
    if (lastSandboxBackend.current !== store.sandboxBackend) {
      lastSandboxBackend.current = store.sandboxBackend;
      actor.send({ type: 'RESET' });
      if (initialized) {
        actor.send({ type: 'LAUNCH' });
      }
    }
  }, [store.sandboxBackend, initialized, actor]);

  // Trigger: send LAUNCH when initialized + workspace available
  useEffect(() => {
    if (!initialized || !opts.workspaceDir) {
return;
}
    const snap = actor.getSnapshot();
    if (snap.value === 'idle' && !snap.context.hasLaunched) {
      actor.send({ type: 'LAUNCH' });
    }
  }, [initialized, opts.workspaceDir, actor]);

  // Reset when workspaceDir changes (supervisor-aware processes guard against stopping supervisor sandboxes)
  useEffect(() => {
    const previousWorkspaceDir = previousWorkspaceDirRef.current;
    previousWorkspaceDirRef.current = opts.workspaceDir;

    if (!initialized || !opts.workspaceDir || !previousWorkspaceDir || previousWorkspaceDir === opts.workspaceDir) {
      return;
    }

    let cancelled = false;
    void (async () => {
      if (supervisorAwareRef.current) {
        try {
          const supervisorStatus = await emitter.invoke('project:get-supervisor-sandbox-status', processIdRef.current);
          if (!cancelled && supervisorStatus && (supervisorStatus.type === 'running' || supervisorStatus.type === 'connecting' || supervisorStatus.type === 'starting')) {
            return;
          }
        } catch {}
      }

      if (cancelled) {
return;
}
      await agentProcessApi.stop(processIdRef.current);
      if (cancelled) {
return;
}
      actor.send({ type: 'RESET' });
    })();

    return () => {
 cancelled = true; 
};
  }, [initialized, opts.workspaceDir, actor]);

  const retry = useCallback(() => {
    actor.send({ type: 'RETRY' });
  }, [actor]);

  const launch = useCallback(() => {
    if (!opts.workspaceDir) {
return;
}
    actor.send({ type: 'RELAUNCH' });
  }, [opts.workspaceDir, actor]);

  return { phase, error, retry, launch, actor };
};
