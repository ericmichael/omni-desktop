import { atom, onMount, task } from 'nanostores';

import { emitter } from '@/renderer/services/ipc';
import type {
  ProfileSummary,
  SandboxContainerSummary,
  SandboxSnapshotSummary,
  SandboxSubstrateStatus,
} from '@/shared/types';

/**
 * Sandboxes rail-tab state: the master-list selection plus the data atoms
 * fed by the `sandbox:*` channels. All fetches go through the normal
 * `emitter` (NOT `localEmitter`) so they resolve on the backend — which is
 * where the profiles and dockerd live in every topology (local, WSL daemon,
 * cloud).
 */

/** The four fixed master nodes of the Sandboxes tab. */
export type SandboxesPane = 'health' | 'profiles' | 'running' | 'snapshots';

/**
 * Detail-pane selection: which fixed master node is open. `null` = nothing
 * drilled into yet, which only mobile can show (the list fills the plane
 * there); the desktop two-pane layout falls back to the first node.
 */
export const $sandboxesSelectedPane = atom<SandboxesPane | null>(null);

/** Discovered profile catalog (`sandbox:list-profiles`); [] until the first fetch lands. */
export const $sandboxProfiles = atom<ProfileSummary[]>([]);

/** Containers carrying the omni-code label (`sandbox:list-containers`). */
export const $sandboxContainers = atom<SandboxContainerSummary[]>([]);

/** Workspace snapshot tars (`sandbox:list-snapshots`). */
export const $sandboxSnapshots = atom<SandboxSnapshotSummary[]>([]);

/** Docker substrate probe result; null until the first fetch lands. */
export const $substrateStatus = atom<SandboxSubstrateStatus | null>(null);

/**
 * Last `sandbox:*` fetch failure, for the active pane to surface. Refreshes
 * keep the last-known data on error — this is the only signal that it's stale.
 */
export const $sandboxesError = atom<string | null>(null);

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const refreshSandboxProfiles = async (): Promise<void> => {
  try {
    $sandboxProfiles.set(await emitter.invoke('sandbox:list-profiles'));
    $sandboxesError.set(null);
  } catch (err) {
    $sandboxesError.set(errorText(err));
  }
};

export const refreshSandboxContainers = async (): Promise<void> => {
  try {
    $sandboxContainers.set(await emitter.invoke('sandbox:list-containers'));
    $sandboxesError.set(null);
  } catch (err) {
    $sandboxesError.set(errorText(err));
  }
};

export const refreshSandboxSnapshots = async (): Promise<void> => {
  try {
    $sandboxSnapshots.set(await emitter.invoke('sandbox:list-snapshots'));
    $sandboxesError.set(null);
  } catch (err) {
    $sandboxesError.set(errorText(err));
  }
};

export const refreshSandboxSubstrate = async (): Promise<void> => {
  try {
    $substrateStatus.set(await emitter.invoke('sandbox:substrate-status'));
    $sandboxesError.set(null);
  } catch (err) {
    $sandboxesError.set(errorText(err));
  }
};

// Fetch-on-first-subscribe (Banner/$launcherVersion idiom): the profile
// pickers all read this atom, so the catalog loads the first time any of
// them renders — no per-surface fetch wiring.
onMount($sandboxProfiles, () => {
  task(async () => {
    await refreshSandboxProfiles();
  });
});
