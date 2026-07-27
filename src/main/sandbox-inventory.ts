/**
 * Container inventory + substrate probe for the Sandboxes tab
 * (`sandbox:list-containers` / `sandbox:remove-container` /
 * `sandbox:sweep-orphans` / `sandbox:substrate-status`).
 *
 * Built on the same exec plumbing as `docker-orphan-cleanup.ts` (shared label
 * const + login-shell env resolution), so enumeration runs wherever dockerd
 * is in every topology. Electron-free and dependency-injected: ownership is
 * joined against providers the registration sites supply (live agent
 * processes with labels, warm-reattach claims from `codeTabs[].containerId`).
 */

import { parseResidentPrincipal } from '@/lib/resident-agent';
import {
  cleanupOrphanedContainers,
  defaultDockerExecDeps,
  type DockerExecFn,
  OMNI_CONTAINER_LABEL,
} from '@/main/docker-orphan-cleanup';
import type { IIpcListener } from '@/shared/ipc-listener';
import type { CodeTab, ResidentAgent, SandboxContainerSummary, SandboxSubstrateStatus } from '@/shared/types';

export type ContainerOwner = { containerId: string; label: string };

export type SandboxInventoryDeps = {
  execFileFn: DockerExecFn;
  getEnv: () => Record<string, string>;
  /** Containers of live agent processes, with a human label (session/tab title). */
  getProcessOwners: () => ContainerOwner[];
  /** Warm-reattach claims from `codeTabs[].containerId`, with tab labels. */
  getWarmReattachIds: () => ContainerOwner[];
};

export const defaultSandboxInventoryDeps = (): Pick<SandboxInventoryDeps, 'execFileFn' | 'getEnv'> =>
  defaultDockerExecDeps();

const EXEC_OPTS_BASE = { encoding: 'utf8' } as const;

// ---------------------------------------------------------------------------
// Ownership labeling (pure helpers shared by both registration sites)
// ---------------------------------------------------------------------------

/**
 * Human label for a code tab: ticket title, routine name, or app id; plain
 * chat columns fall back to "Chat".
 */
export const codeTabLabel = (tab: Pick<CodeTab, 'ticketTitle' | 'routineName' | 'customAppId'>): string =>
  tab.ticketTitle ?? tab.routineName ?? tab.customAppId ?? 'Chat';

/**
 * Join live process containers to labels. Code-tab processes are keyed by the
 * tab id; resident processes by `agent:<id>` (label = resident name). Falls
 * back to the process id when nothing friendlier is known.
 */
export const processOwnersFromState = (
  containerOwners: Array<{ processId: string; containerId: string }>,
  codeTabs: CodeTab[],
  residents: Array<Pick<ResidentAgent, 'id' | 'name'>>
): ContainerOwner[] =>
  containerOwners.map(({ processId, containerId }) => {
    const tab = codeTabs.find((t) => t.id === processId);
    if (tab) {
      return { containerId, label: codeTabLabel(tab) };
    }
    const residentId = parseResidentPrincipal(processId);
    const resident = residentId ? residents.find((r) => r.id === residentId) : undefined;
    return { containerId, label: resident?.name ?? processId };
  });

/** Warm-reattach claims: every persisted tab containerId, labeled by its tab. */
export const warmReattachOwnersFromTabs = (codeTabs: CodeTab[]): ContainerOwner[] =>
  codeTabs
    .filter((t): t is CodeTab & { containerId: string } => !!t.containerId)
    .map((t) => ({
      containerId: t.containerId,
      label: codeTabLabel(t),
    }));

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * `docker ps --format {{json .}}` yields short (12-char) ids while the store
 * and omni serve payloads carry full 64-char ids — match by prefix in either
 * direction (same rule as the orphan sweep).
 */
const idsMatch = (a: string, b: string): boolean => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

const findOwner = (
  containerId: string,
  deps: Pick<SandboxInventoryDeps, 'getProcessOwners' | 'getWarmReattachIds'>
): { ownerKind: SandboxContainerSummary['ownerKind']; ownerLabel: string | null } => {
  // Precedence: live process > warm-reattach claim > orphan. A container both
  // live and persisted on a tab shows as the live session's.
  const processOwner = deps.getProcessOwners().find((o) => idsMatch(o.containerId, containerId));
  if (processOwner) {
    return { ownerKind: 'process', ownerLabel: processOwner.label };
  }
  const warmOwner = deps.getWarmReattachIds().find((o) => idsMatch(o.containerId, containerId));
  if (warmOwner) {
    return { ownerKind: 'warm-reattach', ownerLabel: warmOwner.label };
  }
  return { ownerKind: 'orphan', ownerLabel: null };
};

/** Shape of one `docker ps --format '{{json .}}'` line (fields we read). */
type DockerPsRow = { ID?: string; Names?: string; Image?: string; CreatedAt?: string; State?: string };

export const listContainers = async (deps: SandboxInventoryDeps): Promise<SandboxContainerSummary[]> => {
  const opts = { ...EXEC_OPTS_BASE, timeout: 15_000, env: deps.getEnv() };
  const { stdout } = await deps.execFileFn(
    'docker',
    ['ps', '-a', '--filter', `label=${OMNI_CONTAINER_LABEL}`, '--format', '{{json .}}'],
    opts
  );
  const summaries: SandboxContainerSummary[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let row: DockerPsRow;
    try {
      row = JSON.parse(trimmed) as DockerPsRow;
    } catch {
      console.warn(`[sandbox-inventory] skipping unparseable docker ps line: ${trimmed}`);
      continue;
    }
    if (!row.ID) {
      continue;
    }
    summaries.push({
      id: row.ID,
      name: row.Names ?? '',
      image: row.Image ?? '',
      createdAt: row.CreatedAt ?? '',
      state: row.State ?? '',
      ...findOwner(row.ID, deps),
    });
  }
  return summaries;
};

/**
 * Force-remove a container. Throws (with the owner label) when the id is
 * still claimed by a live process or a warm-reattach tab — the UI surfaces
 * the reason instead of a disabled mystery button.
 */
export const removeContainer = async (deps: SandboxInventoryDeps, id: string): Promise<void> => {
  const { ownerKind, ownerLabel } = findOwner(id, deps);
  if (ownerKind !== 'orphan') {
    const claim = ownerKind === 'process' ? 'a running session' : 'a resumable session';
    throw new Error(`Container is in use by ${claim}: ${ownerLabel ?? id}`);
  }
  const opts = { ...EXEC_OPTS_BASE, timeout: 15_000, env: deps.getEnv() };
  await deps.execFileFn('docker', ['rm', '-f', id], opts);
};

/** Run the orphan cleanup pass on demand; protected set = both owner lists. */
export const sweepOrphans = async (deps: SandboxInventoryDeps): Promise<{ removed: string[] }> => {
  const removed = await cleanupOrphanedContainers({
    execFileFn: deps.execFileFn,
    getEnv: deps.getEnv,
    getProtectedContainerIds: () =>
      [...deps.getProcessOwners(), ...deps.getWarmReattachIds()].map((o) => o.containerId),
  });
  return { removed: removed ?? [] };
};

// ---------------------------------------------------------------------------
// Substrate probe
// ---------------------------------------------------------------------------

export const getSubstrateStatus = async (
  deps: Pick<SandboxInventoryDeps, 'execFileFn' | 'getEnv'>
): Promise<SandboxSubstrateStatus> => {
  const opts = { ...EXEC_OPTS_BASE, timeout: 10_000, env: deps.getEnv() };
  try {
    const { stdout } = await deps.execFileFn('docker', ['version', '--format', '{{.Server.Version}}'], opts);
    const version = stdout.trim();
    return version ? { docker: 'ok', dockerVersion: version } : { docker: 'ok' };
  } catch (err) {
    // Binary not on PATH → docker isn't installed; any other failure (the CLI
    // exists but exits non-zero) → the daemon isn't reachable.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { docker: code === 'ENOENT' ? 'missing' : 'daemon-down' };
  }
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the container channels on either shell's IPC listener. */
export const registerSandboxInventoryHandlers = (ipc: IIpcListener, deps: SandboxInventoryDeps): void => {
  ipc.handle('sandbox:list-containers', () => listContainers(deps));
  ipc.handle('sandbox:remove-container', (_, id: string) => removeContainer(deps, id));
  ipc.handle('sandbox:sweep-orphans', () => sweepOrphans(deps));
  ipc.handle('sandbox:substrate-status', () => getSubstrateStatus(deps));
};
