/**
 * Cloud side of "computer-as-sandbox". Prepares a `host_bridge` sandbox profile
 * so the cloud's `omni serve` (the agent — which stays in the cloud) targets a
 * user's laptop as its sandbox backend.
 *
 * Flow, per `local:<machineId>` session:
 *   1. Reverse-RPC `compute:ensure-host` to the machine's live WS → the laptop
 *      launches `omni sandbox-host` and returns its loopback `execPort` + the
 *      resolved local workspace dir.
 *   2. Write `<configDir>/sandbox/host-bridge-<sandboxKey>.yml` whose
 *      `client.endpoint` points at this launcher's relay
 *      (`/proxy/local/<machineId>/<sandboxKey>/<execPort>`). The cloud
 *      `omni serve` dials that on loopback; the relay forwards exec/fs/pty
 *      frames over the machine WS to the laptop's exec server.
 *
 * The agent process, model keys, env, and `PgSessionStorage` all stay in the
 * cloud — only the sandbox surface crosses to the laptop.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IHostBridgePreparer } from '@/main/process-manager';
import type { MachineRegistry } from '@/server/machine-registry';
import type { WsHandler } from '@/server/ws-handler';

export class HostBridgeUnavailableError extends Error {
  constructor(
    readonly kind: 'host-offline' | 'machine-at-capacity',
    readonly machineId: string,
    readonly extras: Record<string, unknown> = {}
  ) {
    super(`${kind}:${machineId}`);
    this.name = 'HostBridgeUnavailableError';
  }
}

type EnsureHostResult = {
  ok: boolean;
  execPort?: number;
  workspace?: string;
  error?: string;
};

export class HostBridgePreparer implements IHostBridgePreparer {
  constructor(
    private readonly wsHandler: WsHandler,
    private readonly registry: MachineRegistry,
    private readonly configDir: string,
    /** Loopback origin of this launcher (where `omni serve` dials the relay). */
    private readonly launcherPort: number
  ) {}

  async prepare(
    machineId: string,
    sandboxKey: string,
    opts: { workspaceDir?: string }
  ): Promise<{ profilePath: string }> {
    const ws = this.registry.getActiveWs(machineId);
    if (!ws) {
      throw new HostBridgeUnavailableError('host-offline', machineId);
    }

    let result: EnsureHostResult;
    try {
      result = await this.wsHandler.invokeOnWs<EnsureHostResult>(ws, 'compute:ensure-host', [
        { sessionId: sandboxKey, workspaceHint: opts.workspaceDir },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('machine-at-capacity')) {
        throw new HostBridgeUnavailableError('machine-at-capacity', machineId);
      }
      throw err;
    }
    if (!result?.ok || typeof result.execPort !== 'number') {
      throw new HostBridgeUnavailableError('host-offline', machineId, {
        reason: result?.error,
      });
    }

    // Trailing `/ws` is REQUIRED: the relay route is
    // `/proxy/local/:machineId/:sessionId/:port/*`, whose `/*` needs a segment
    // after the port. Without it the request falls through to the generic
    // `/proxy/:proxyName/*` handler (proxyName="local") → "No upstream". The
    // laptop's `omni sandbox-host` accepts any path, so `/ws` is just a marker
    // that satisfies the wildcard and lets the local-tunnel route win.
    const endpoint =
      `ws://127.0.0.1:${this.launcherPort}/proxy/local/` +
      `${encodeURIComponent(machineId)}/${encodeURIComponent(sandboxKey)}/${result.execPort}/ws`;

    // manifest.root is the laptop path the host reported; the host overrides it
    // anyway (it owns its own filesystem layout), but reporting it keeps the
    // profile honest and lets ${workspace_dir} resolve sensibly.
    const root = result.workspace || '/workspace';
    const profile = {
      version: 1,
      client: { type: 'host_bridge', endpoint },
      manifest: { root },
      terminal: { command: 'bash -i', cwd: root },
    };

    const dir = join(this.configDir, 'sandbox');
    mkdirSync(dir, { recursive: true });
    const profilePath = join(dir, `host-bridge-${sanitize(sandboxKey)}.yml`);
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf-8');

    // Anchor the session to the machine so that, when the machine's WS drops,
    // the registry's release snapshot includes it — that's what drives the
    // `host-offline` status broadcast + the reconnect/resume flow. `sandboxKey`
    // IS the cloud agent processId, which is exactly the id `agent-process:status`
    // is keyed by.
    this.registry.anchorSession(machineId, sandboxKey);
    return { profilePath };
  }

  machineState(machineId: string): { online: boolean; label?: string } {
    return this.registry.machineState(machineId);
  }

  async release(machineId: string, sandboxKey: string): Promise<void> {
    this.registry.releaseSession(machineId, sandboxKey);
    const ws = this.registry.getActiveWs(machineId);
    if (!ws) {
      return;
    }
    try {
      await this.wsHandler.invokeOnWs<void>(ws, 'compute:stop-host', [sandboxKey]);
    } catch {
      // Best-effort; the host reaps its own sandbox-host on disconnect/quit.
    }
  }
}

/** Keep the profile filename filesystem-safe (processIds are URL-ish ids). */
const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');
