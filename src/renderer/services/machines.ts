/**
 * Renderer-side machine identity + cloud registration.
 *
 * The Electron main process owns the persisted identity file; the renderer
 * just fetches it once at boot and (when cloud-linked) replays it to the
 * cloud over the existing WS via `machine:register`. The cloud answers with
 * a `machine:list-changed` event that mirrors here into `$machines`, and
 * the Settings UI + SandboxPicker read from that.
 */
import { atom } from 'nanostores';

import { emitter, ipc, isCloudLinked, isElectron, localEmitter, wsEmitter } from '@/renderer/services/ipc';
import type { MachineIdentity, MachineSummary } from '@/shared/types';

/** This Electron's stable identity. `null` until the main process replies. */
export const $machineIdentity = atom<MachineIdentity | null>(null);

/** Cloud-side list of machines for the signed-in principal. */
export const $machines = atom<MachineSummary[]>([]);

let pollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Boot the renderer's machine layer. Always reads the local identity (so the
 * Settings card can render it even when not cloud-linked); only registers +
 * subscribes to the cloud list when cloud-linked.
 *
 * Safe to call once at app start. Subsequent calls are a no-op because
 * `$machineIdentity` is sticky and the WS listener is registered with `ipc.on`
 * which dedupes by listener identity.
 */
export const initMachines = async (): Promise<void> => {
  if (!isElectron) {
    // Browser server mode has no local Electron — nothing to register.
    // The Settings card hides itself in this mode.
    return;
  }
  try {
    // Identity lives in local Electron main, even in cloud-linked mode.
    const identity = await localEmitter.invoke('cloud:get-machine-identity');
    $machineIdentity.set(identity);
  } catch (err) {
    console.warn('[machines] failed to read local identity:', err);
    return;
  }

  if (!isCloudLinked) {
    return;
  }

  // Push the identity up to the cloud; on a retry the cloud just upserts +
  // bumps last_seen_at. Best-effort: a transient failure here doesn't break
  // anything, the WS reconnect listener below will replay it.
  await registerOnce();

  // Replay registration on every WS (re)connect so a laptop coming out of
  // sleep — or any transient cloud restart — re-establishes its binding
  // without the user having to do anything.
  wsEmitter?.onConnect(() => {
    void registerOnce();
  });

  // The cloud broadcasts the principal's list whenever anything changes.
  // Mirror it here for the picker + Settings card.
  ipc.on('machine:list-changed', (list) => {
    $machines.set(list);
  });

  // Bootstrap the initial list by asking once.
  try {
    const list = await emitter.invoke('machine:list');
    $machines.set(list);
  } catch (err) {
    console.warn('[machines] initial list failed:', err);
  }
};

const registerOnce = async (): Promise<void> => {
  const id = $machineIdentity.get();
  if (!id) {
    return;
  }
  try {
    await emitter.invoke('machine:register', id);
  } catch (err) {
    // Most likely the WS hadn't connected yet — try again on a short delay,
    // and again on transport reconnect (the WS transport itself has its own
    // reconnect; we just re-register so the cloud refreshes its binding).
    console.warn('[machines] register failed, will retry:', err);
    if (pollTimer) {
      clearTimeout(pollTimer);
    }
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void registerOnce();
    }, 2000);
  }
};

/** User-edit path: rename locally + register with the new label. */
export const setMachineLabel = async (label: string): Promise<void> => {
  // `cloud:set-machine-label` rewrites the local machine.json — local main only.
  const next = await localEmitter.invoke('cloud:set-machine-label', label);
  $machineIdentity.set(next);
  if (isCloudLinked) {
    await registerOnce();
  }
};

/** Cloud-side delete (revokes dispatch rights). */
export const removeMachine = async (machineId: string): Promise<void> => {
  const list = await emitter.invoke('machine:remove', machineId);
  $machines.set(list);
};

/** Cloud-side rename of any machine (typically this one or a peer Electron). */
export const renameMachineRemote = async (machineId: string, label: string): Promise<void> => {
  const list = await emitter.invoke('machine:rename', machineId, label);
  $machines.set(list);
};
