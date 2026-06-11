/**
 * Electron-side handlers for the cloud's `compute:*` reverse-RPCs
 * (computer-as-sandbox).
 *
 * The agent runs in the cloud; this machine is only a *sandbox backend*. So
 * the cloud never asks us to run `omni serve` — it asks us to stand up an
 * `omni sandbox-host` exec server (see `SandboxHostManager`) and reports back
 * the loopback port, which the cloud wires into a `host_bridge` sandbox
 * profile. Tunnel relay handlers (`compute:tunnel-*`) live in
 * `tunnel-handler.ts` and carry the exec channel + exposed-port traffic.
 *
 * Allowlist (kept in sync with `renderer/services/compute.ts`):
 *   - `compute:ensure-host` — launch (or reuse) the exec server for a session.
 *   - `compute:stop-host`   — tear it down.
 */
import { app } from 'electron';

import { registerMainReverseHandler } from '@/main/reverse-rpc-bridge';
import { SandboxHostManager } from '@/main/sandbox-host-manager';

type EnsureHostArgs = {
  sessionId: string;
  /** Cloud-side workspace hint; the manager re-anchors it under the laptop's
   *  projects dir (cloud paths don't exist here). */
  workspaceHint?: string;
};

export const wireComputeReverseHandlers = (): (() => void) => {
  const hosts = new SandboxHostManager();
  const cleanups: Array<() => void> = [];

  cleanups.push(
    registerMainReverseHandler('compute:ensure-host', async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as EnsureHostArgs;
      if (!args.sessionId) {
        throw new Error('compute:ensure-host: sessionId required');
      }
      const result = await hosts.ensure(args.sessionId, args.workspaceHint);
      if (!result.ok && result.error === 'machine-at-capacity') {
        // Structured envelope the cloud maps to a machine-at-capacity banner.
        const cap = result as { maxSessions: number; currentSessions: number };
        throw new Error(`machine-at-capacity: max=${cap.maxSessions} current=${cap.currentSessions}`);
      }
      return result;
    })
  );

  cleanups.push(
    registerMainReverseHandler('compute:stop-host', async (sessionId: unknown) => {
      hosts.stop(String(sessionId));
      return { ok: true };
    })
  );

  const onQuit = (): void => hosts.stopAll();
  app.on('before-quit', onQuit);

  return () => {
    for (const fn of cleanups) fn();
    app.removeListener('before-quit', onQuit);
    hosts.stopAll();
  };
};
