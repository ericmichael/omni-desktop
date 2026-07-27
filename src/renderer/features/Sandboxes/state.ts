import { atom } from 'nanostores';

/**
 * Sandboxes rail-tab state. Phase 1 holds only the master-list selection;
 * the data atoms (profiles, containers, substrate status) land with the
 * `sandbox:*` IPC wave that fills the panes.
 */

/** The three fixed master nodes of the Sandboxes tab. */
export type SandboxesPane = 'health' | 'profiles' | 'running';

/** Detail-pane selection: which fixed master node is open. */
export const $sandboxesSelectedPane = atom<SandboxesPane>('health');
