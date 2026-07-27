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
import type {
  CodeTab,
  ResidentAgent,
  SandboxContainerSummary,
  SandboxImageStatus,
  SandboxSubstrateStatus,
} from '@/shared/types';

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

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
// Container logs
// ---------------------------------------------------------------------------

/** Hard cap on `docker logs --tail` — the renderer shows a viewer, not an archive. */
export const MAX_LOG_TAIL_LINES = 2_000;

/**
 * Tail of `docker logs` for one labeled container. The id is verified against
 * the same labeled listing the Running pane renders — a browser client must
 * not be able to read logs of arbitrary (non-omni) containers. Docker writes
 * the container's stderr stream to its own stderr, so both streams are
 * concatenated into one blob.
 */
export const getContainerLogs = async (
  deps: SandboxInventoryDeps,
  id: string,
  tailLines: number
): Promise<{ logs: string }> => {
  const requested = Number.isFinite(tailLines) ? Math.floor(tailLines) : 0;
  const tail = Math.min(Math.max(requested, 1), MAX_LOG_TAIL_LINES);
  const row = (await listContainers(deps)).find((c) => idsMatch(c.id, id));
  if (!row) {
    throw new Error(`No sandbox container with id ${id}`);
  }
  const opts = { ...EXEC_OPTS_BASE, timeout: 15_000, env: deps.getEnv() };
  // Use the listed id, not the caller's string — nothing unverified reaches the CLI.
  const { stdout, stderr } = await deps.execFileFn('docker', ['logs', '--tail', String(tail), row.id], opts);
  return { logs: stdout + stderr };
};

// ---------------------------------------------------------------------------
// Image management
// ---------------------------------------------------------------------------

/**
 * Conservative image-reference check: docker's ref charset without the full
 * grammar. Rules out flag injection (no leading `-`) and whitespace/shell
 * noise — anything docker would accept as a ref passes.
 */
const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

const assertImageRef = (image: string): void => {
  if (!IMAGE_REF_RE.test(image)) {
    throw new Error(`Invalid image reference: ${JSON.stringify(image)}`);
  }
};

const execErrorStderr = (err: unknown): string => {
  const stderr = (err as { stderr?: unknown } | undefined)?.stderr;
  return typeof stderr === 'string' ? stderr : '';
};

/** Presence + local size of *image* on this backend's dockerd. */
export const getImageStatus = async (deps: SandboxInventoryDeps, image: string): Promise<SandboxImageStatus> => {
  assertImageRef(image);
  const opts = { ...EXEC_OPTS_BASE, timeout: 15_000, env: deps.getEnv() };
  try {
    const { stdout } = await deps.execFileFn('docker', ['image', 'inspect', image, '--format', '{{.Size}}'], opts);
    const size = Number.parseInt(stdout.trim(), 10);
    return { image, present: true, sizeBytes: Number.isFinite(size) ? size : null };
  } catch (err) {
    // Absent image → docker exits 1 with "No such image" on stderr. Anything
    // else (ENOENT binary, daemon down) is a real failure the caller must see.
    if (/no such image/i.test(execErrorStderr(err)) || /no such image/i.test(errorMessage(err))) {
      return { image, present: false, sizeBytes: null };
    }
    throw err;
  }
};

/** `docker pull` can stream gigabytes — give it minutes, not seconds. */
const PULL_TIMEOUT_MS = 10 * 60 * 1_000;

/** Pull *image*; resolves on completion, rejects with the stderr tail. */
export const pullImage = async (deps: SandboxInventoryDeps, image: string): Promise<void> => {
  assertImageRef(image);
  const opts = { ...EXEC_OPTS_BASE, timeout: PULL_TIMEOUT_MS, env: deps.getEnv() };
  try {
    await deps.execFileFn('docker', ['pull', image], opts);
  } catch (err) {
    const tail = (execErrorStderr(err) || errorMessage(err)).trim().slice(-500);
    throw new Error(`docker pull ${image} failed: ${tail}`);
  }
};

/** Docker prints go-units human sizes — decimal kB/MB/GB (binary forms accepted for robustness). */
const SIZE_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 2 ** 10,
  mib: 2 ** 20,
  gib: 2 ** 30,
  tib: 2 ** 40,
};

/**
 * Parse docker's "Total reclaimed space" report into bytes. Null when the
 * line is absent (nothing pruned on some docker versions) or unparseable.
 */
export const parseReclaimedBytes = (output: string): number | null => {
  const match = /Total reclaimed space:\s*([\d.]+)\s*([A-Za-z]+)/.exec(output);
  if (!match) {
    return null;
  }
  const value = Number.parseFloat(match[1]!);
  const multiplier = SIZE_MULTIPLIERS[match[2]!.toLowerCase()];
  if (!Number.isFinite(value) || multiplier === undefined) {
    return null;
  }
  return Math.round(value * multiplier);
};

/** Remove dangling images (`docker image prune -f` — never tagged ones). */
export const pruneImages = async (deps: SandboxInventoryDeps): Promise<{ reclaimedBytes: number | null }> => {
  const opts = { ...EXEC_OPTS_BASE, timeout: 60_000, env: deps.getEnv() };
  const { stdout } = await deps.execFileFn('docker', ['image', 'prune', '-f'], opts);
  return { reclaimedBytes: parseReclaimedBytes(stdout) };
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
  ipc.handle('sandbox:container-logs', (_, id: string, tailLines: number) => getContainerLogs(deps, id, tailLines));
  ipc.handle('sandbox:image-status', (_, image: string) => getImageStatus(deps, image));
  ipc.handle('sandbox:pull-image', (_, image: string) => pullImage(deps, image));
  ipc.handle('sandbox:prune-images', () => pruneImages(deps));
};
