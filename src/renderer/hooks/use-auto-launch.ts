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
import { getProfileMenuLabel } from '@/renderer/features/SandboxProfile/profile-list';
import { toast } from '@/renderer/features/Toast/state';
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
  /** Project id, forwarded to ProcessManager for per-project profile lookup. */
  projectId?: string;
  /**
   * Per-launch sandbox profile override. Wins over project + default
   * resolution in ProcessManager. Set by the pre-launch SandboxPicker.
   */
  profileNameOverride?: string;
  /**
   * Conversation session id — used both as the snapshot key (per-session
   * workspace persistence) and the agent server's session id (chat history,
   * WS ``serverCall`` scoping). Caller is responsible for ensuring this is
   * non-null when launching (pre-mint upstream).
   */
  sessionId?: string;
  /**
   * Docker container id from a previous launch. Forwarded to ``omni serve``
   * so the SDK can warm-reattach via ``client.resume(state)``. Stale ids
   * are safe — the SDK falls back to a fresh container + snapshot
   * rehydrate. The renderer reads back the resolved id from the readiness
   * payload (which may differ in the rehydrate / fresh tiers) and persists
   * it for the next launch.
   */
  containerId?: string;
  /** Logger tag. */
  logLabel?: string;
};

/**
 * Unified auto-launch hook. Drives the sandbox lifecycle for any agent process.
 *
 * Side effects are driven by XState invoke actors — no phase-gated useEffects.
 */
export const useAutoLaunch = (opts: UseAutoLaunchOptions) => {
  const { processId, logLabel } = opts;
  const initialized = useStore($initialized);
  const store = useStore(persistedStoreApi.$atom);

  // Refs so actor callbacks always see current values without recreating the actors object
  const processIdRef = useRef(processId);
  processIdRef.current = processId;
  const workspaceDirRef = useRef(opts.workspaceDir);
  workspaceDirRef.current = opts.workspaceDir;
  const previousWorkspaceDirRef = useRef(opts.workspaceDir);
  const projectIdRef = useRef(opts.projectId);
  projectIdRef.current = opts.projectId;
  const profileNameOverrideRef = useRef(opts.profileNameOverride);
  profileNameOverrideRef.current = opts.profileNameOverride;
  const sessionIdRef = useRef(opts.sessionId);
  sessionIdRef.current = opts.sessionId;
  const containerIdRef = useRef(opts.containerId);
  containerIdRef.current = opts.containerId;
  const storeRef = useRef(store);
  storeRef.current = store;

  const actors = useMemo(
    () => ({
      checkRuntime: fromCallback<AutoLaunchEvent>(({ sendBack }) => {
        const check = (val: OmniRuntimeReadiness) => {
          if (val.status === 'ready') {
            sendBack({ type: 'RUNTIME_READY' });
            return true;
          }
          if (val.status === 'installing') {
            sendBack({ type: 'RUNTIME_OUTDATED' });
            return true;
          }
          if (val.status === 'error') {
            sendBack({ type: 'RUNTIME_CHECK_FAILED', error: val.error });
            return true;
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
            const modelsConfig = await emitter.invoke('settings:get-models-config');
            const hasProviders = Object.keys(modelsConfig.providers).length > 0;
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

          const existing = $agentStatuses.get()[processIdRef.current];
          if (
            existing &&
            (existing.type === 'running' || existing.type === 'connecting' || existing.type === 'starting')
          ) {
            sendBack({ type: 'CONFIG_OK' });
            return;
          }

          agentProcessApi.start(processIdRef.current, {
            workspaceDir: wd,
            ...(projectIdRef.current ? { projectId: projectIdRef.current } : {}),
            ...(profileNameOverrideRef.current ? { profileNameOverride: profileNameOverrideRef.current } : {}),
            ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
            ...(containerIdRef.current ? { containerId: containerIdRef.current } : {}),
          });
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
        emitter
          .invoke('agent-process:get-status', processIdRef.current)
          .then((status) => {
            if (cancelled || !status || status.type === 'uninitialized') {
              return;
            }
            $agentStatuses.setKey(processIdRef.current, status);
          })
          .catch(() => {});

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
          cancelled = true;
          unsub();
        };
      }),
    }),
    []
  );

  const inspect = useMemo(
    () =>
      createMachineLogger(logLabel ?? `autoLaunch:${processId}`, {
        tags: { sandbox: store.defaultProfileName ?? 'none' },
      }),
    [processId, logLabel, store.defaultProfileName]
  );

  const machine = useMemo(() => autoLaunchMachine.provide({ actors }), [actors]);
  const actor = useActorRef(machine, { inspect });
  const phase = useSelector(actor, (snap) => snap.value as AutoLaunchPhase);
  const error = useSelector(actor, (snap) => snap.context.error);

  // Reset when sandbox backend changes
  const lastSandboxBackend = useRef(store.defaultProfileName);
  useEffect(() => {
    if (lastSandboxBackend.current !== store.defaultProfileName) {
      lastSandboxBackend.current = store.defaultProfileName;
      actor.send({ type: 'RESET' });
      if (initialized) {
        actor.send({ type: 'LAUNCH' });
      }
    }
  }, [store.defaultProfileName, initialized, actor]);

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
      if (cancelled) {
        return;
      }
      await agentProcessApi.stop(processIdRef.current);
      if (cancelled) {
        return;
      }
      actor.send({ type: 'RESET' });
      // Drive the relaunch explicitly: the auto-launch effect's deps don't
      // change on RESET, so without this a workspace switch (new chat
      // conversation, session switch) can strand the machine in idle.
      actor.send({ type: 'LAUNCH' });
    })();

    return () => {
      cancelled = true;
    };
  }, [initialized, opts.workspaceDir, actor]);

  // React to a per-launch sandbox profile override change (written by the
  // SandboxPicker). Prefer an **in-place switch** over the live `omni serve`:
  // `sandbox.switch` snapshots the workspace, brings up the new backend, and
  // re-attaches it without restarting the process — so the WebSocket and the
  // conversation stay up; only the in-sandbox service panes reload. Fall back
  // to the old stop → RESET → LAUNCH only when an in-place switch isn't
  // possible (no live session yet, or `host`/missing profile, or the switch
  // failed). The general auto-launch effect above won't re-trigger on its own
  // (no dep changes on RESET), so we drive the relaunch from here.
  const previousProfileOverrideRef = useRef(opts.profileNameOverride);
  useEffect(() => {
    const previous = previousProfileOverrideRef.current;
    previousProfileOverrideRef.current = opts.profileNameOverride;
    if (!initialized || previous === opts.profileNameOverride) {
      return;
    }
    const nextProfile = opts.profileNameOverride;
    const status = $agentStatuses.get()[processIdRef.current];
    const isLiveSession = status?.type === 'running' || status?.type === 'connecting';

    if (!isLiveSession) {
      return;
    }

    let cancelled = false;
    void (async () => {
      if (nextProfile) {
        const res = await agentProcessApi.switchSandbox(processIdRef.current, nextProfile);
        if (cancelled) {
          return;
        }
        const label = getProfileMenuLabel(nextProfile);
        if (res.ok) {
          // Switched in place; the new services/containerId arrived via the
          // AgentProcessData status update — no relaunch, conversation intact.
          toast.success(`Now running on ${label}`);
          return;
        }
        if (!res.fallback) {
          // omni-code rolled back — the previous sandbox is still live, so
          // don't relaunch; just tell the user the switch didn't take.
          toast.error(
            `Couldn't switch to ${label}`,
            res.recovered === 'rolled_back' ? 'Restored the previous sandbox.' : res.reason
          );
          return;
        }
        if (res.recovered === 'lost') {
          toast.warning(`Sandbox was lost during the switch — restarting on ${label}…`);
        }
        // else: an unsupported in-place target (host/missing) — a normal
        // stop+relaunch, no toast needed.
      }
      // Fallback: tear down + relaunch on the new profile (idle/pre-launch,
      // host/missing profile, or a lost sandbox).
      await agentProcessApi.stop(processIdRef.current);
      if (cancelled) {
        return;
      }
      actor.send({ type: 'RESET' });
      if (workspaceDirRef.current) {
        actor.send({ type: 'LAUNCH' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialized, opts.profileNameOverride, actor]);

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
