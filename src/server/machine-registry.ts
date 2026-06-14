/**
 * Cloud-side registry of which Electron WebSockets are currently live for
 * each (principal, machineId).
 *
 * Composes:
 *   - `MachinesRepo`  — durable PG row per machine (`registered_at`,
 *     `last_seen_at`, label, platform).
 *   - In-memory `active` map — `machineId → { ws, principalId, sessionsAnchored }`.
 *     Only the WS reference lives here; everything persistent goes through
 *     the repo so a server restart reloads correctly.
 *
 * The plan's Q4 picks **last-WS-wins** semantics: if two Electrons present
 * the same `machineId`, the most-recently-registered WS becomes the active
 * dispatch target. The earlier WS stays connected for its own per-session
 * IPC; reverse-RPCs just won't go to it anymore.
 *
 * Q5: trust on first connect — the WS that calls `bindFromWs` was
 * authenticated upstream (signed runtime token derived from EasyAuth), so
 * the principal in the WS context is the principal we attribute the machine
 * to. No second approval step.
 */
import type { MachineRow, MachinesRepo } from 'omni-projects-db';
import type { WebSocket } from 'ws';

import type { MachineIdentity, MachineSummary } from '@/shared/types';

type Active = {
  ws: WebSocket;
  principalId: string;
  label: string;
  platform: string;
  /** sessionIds the cloud has anchored to this machine. */
  sessionsAnchored: Set<string>;
};

export type MachineRegistryEvents = {
  /** Called after any change a listener should re-list for. */
  onChanged?: (principalId: string) => void;
  /**
   * Fired when an Electron's WS BIND lands — typically a reconnect after
   * the laptop was offline. Hook for Phase 6 adoption: the cloud iterates
   * its known sessions for the machine and asks the Electron whether each
   * is still running locally.
   */
  onMachineOnline?: (machineId: string, principalId: string) => void;
  /** Fired when a machine's WS drops (laptop offline). The cloud broadcasts a
   *  `host-offline` overlay to every local session anchored to it so renderers
   *  show the banner immediately (the agent keeps running in the cloud). */
  onMachineOffline?: (machineId: string, principalId: string) => void;
};

export class MachineRegistry {
  /** Active by machineId — only one entry per id; last bind wins. */
  private readonly active = new Map<string, Active>();
  /** Reverse: ws → machineId, so disconnect can clean up. */
  private readonly byWs = new WeakMap<WebSocket, string>();
  /** machineId → friendly label, retained even while the machine is OFFLINE
   *  (the active entry is dropped on disconnect) so the host-offline banner can
   *  still name the machine. */
  private readonly labels = new Map<string, string>();
  private readonly listeners: MachineRegistryEvents;

  constructor(
    private readonly repo: MachinesRepo,
    listeners: MachineRegistryEvents = {}
  ) {
    this.listeners = listeners;
  }

  /**
   * Bind *ws* as the live dispatch target for *info.machineId* under
   * *principalId*. Upserts the persistent row + bumps `last_seen_at`.
   * Returns the durable row for the caller to broadcast.
   */
  async bindFromWs(ws: WebSocket, principalId: string, info: MachineIdentity): Promise<MachineRow> {
    await this.repo.register(principalId, info);
    const prior = this.active.get(info.machineId);
    // If we already had a different WS for this machine, release the
    // back-ref before overwriting so a later disconnect on the old WS
    // doesn't kick out the new one.
    if (prior && prior.ws !== ws) {
      this.byWs.delete(prior.ws);
      console.log(
        `[machine] swap principal=${principalId} machine=${info.machineId} label=${info.label} (prior WS released)`
      );
    } else if (!prior) {
      console.log(
        `[machine] bind principal=${principalId} machine=${info.machineId} label=${info.label} platform=${info.platform}`
      );
    }
    const entry: Active = {
      ws,
      principalId,
      label: info.label,
      platform: info.platform,
      sessionsAnchored: prior?.sessionsAnchored ?? new Set<string>(),
    };
    this.active.set(info.machineId, entry);
    this.labels.set(info.machineId, info.label);
    this.byWs.set(ws, info.machineId);
    this.listeners.onChanged?.(principalId);
    this.listeners.onMachineOnline?.(info.machineId, principalId);
    const row = await this.repo.get(principalId, info.machineId);
    if (!row) {
      // Shouldn't happen — we just upserted it.
      throw new Error(`MachineRegistry: register succeeded but row not found for ${info.machineId}`);
    }
    return row;
  }

  /** Drop the active binding for a WS that just closed. PG row is preserved.
   *  Returns the machineId + principalId of the dropped binding AND a
   *  snapshot of sessionIds anchored at the moment of release, so callers
   *  can broadcast host-offline status to every affected session. */
  releaseWs(
    ws: WebSocket
  ): { machineId: string; principalId: string; label: string; sessionsAnchored: string[] } | null {
    const machineId = this.byWs.get(ws);
    if (!machineId) {
      return null;
    }
    this.byWs.delete(ws);
    const entry = this.active.get(machineId);
    // Only delete the active entry if this WS is still the current one.
    // A newer bind would have already pointed it elsewhere — leave that be.
    if (entry?.ws === ws) {
      const snapshot = Array.from(entry.sessionsAnchored);
      this.active.delete(machineId);
      console.log(
        `[machine] release principal=${entry.principalId} machine=${machineId} label=${entry.label} anchored=${snapshot.length}`
      );
      this.listeners.onChanged?.(entry.principalId);
      this.listeners.onMachineOffline?.(machineId, entry.principalId);
      return {
        machineId,
        principalId: entry.principalId,
        label: entry.label,
        sessionsAnchored: snapshot,
      };
    }
    return null;
  }

  /**
   * The WS currently designated to receive reverse-RPCs for this machine,
   * or null if the machine is offline (no live WS). Caller checks online
   * status BEFORE issuing a reverse-RPC so it can return a structured
   * `host-offline` error fast instead of blocking on a 30s timeout.
   */
  getActiveWs(machineId: string): WebSocket | null {
    return this.active.get(machineId)?.ws ?? null;
  }

  /** True iff the machine is registered AND has a live WS bound right now. */
  isOnline(machineId: string): boolean {
    return this.active.has(machineId);
  }

  /** Online state + retained friendly label, for the host-offline overlay.
   *  Label survives while offline (see {@link labels}). */
  machineState(machineId: string): { online: boolean; label?: string } {
    const label = this.labels.get(machineId);
    return { online: this.active.has(machineId), ...(label ? { label } : {}) };
  }

  /** Track that *sessionId* is now running on *machineId* (for adoption). */
  anchorSession(machineId: string, sessionId: string): void {
    this.active.get(machineId)?.sessionsAnchored.add(sessionId);
  }

  /** Untrack a session — call on stop / adopt-failed / migrate. */
  releaseSession(machineId: string, sessionId: string): void {
    this.active.get(machineId)?.sessionsAnchored.delete(sessionId);
  }

  /** sessionIds the cloud thinks are still running on *machineId*. */
  anchoredSessions(machineId: string): string[] {
    return Array.from(this.active.get(machineId)?.sessionsAnchored ?? []);
  }

  /**
   * Build the renderer-facing summary for *principalId*. Joins the durable
   * PG list with the in-memory `online` flag. `isSelf` is calculated against
   * the caller's own machineId (passed in so the registry stays platform-
   * agnostic).
   */
  async listForPrincipal(principalId: string, callerMachineId?: string): Promise<MachineSummary[]> {
    const rows = await this.repo.list(principalId);
    return rows.map((r) => ({
      machineId: r.machine_id,
      label: r.label,
      platform: r.platform,
      online: this.active.has(r.machine_id),
      isSelf: callerMachineId === r.machine_id,
      registeredAt: r.registered_at,
      lastSeenAt: r.last_seen_at,
    }));
  }

  /** Remove a machine entirely (PG row + drop active binding if any). */
  async remove(principalId: string, machineId: string): Promise<void> {
    const entry = this.active.get(machineId);
    if (entry && entry.principalId === principalId) {
      this.active.delete(machineId);
      this.byWs.delete(entry.ws);
    }
    await this.repo.delete(principalId, machineId);
    this.listeners.onChanged?.(principalId);
  }

  /** Edit the label both on disk and in-memory. */
  async rename(principalId: string, machineId: string, label: string): Promise<void> {
    await this.repo.rename(principalId, machineId, label);
    const entry = this.active.get(machineId);
    if (entry && entry.principalId === principalId) {
      entry.label = label;
    }
    this.listeners.onChanged?.(principalId);
  }
}
