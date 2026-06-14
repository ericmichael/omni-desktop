/**
 * Container-side pull request detection (GitHub + Azure DevOps).
 *
 * The agent opens the real PR from inside the running container (it pushes the
 * branch and runs ``gh pr create`` / ``az repos pr create`` — both CLIs are
 * installed in the sandbox image and logged in at session boot). The host may
 * not even have the branch, so detection has to run where the branch and the
 * authenticated CLIs live: inside the container, via ``docker exec``.
 *
 * Mirrors the ``docker exec`` posture of :module:`@/lib/container-files-changed`
 * (same uid that owns ``/workspace/*``, same per-source mount layout), but runs
 * a PR CLI rather than ``git`` — so it sets the container working directory
 * with ``-w`` and lets each CLI auto-detect org/repo from the remote.
 *
 * The remote host decides the provider: ``github.com`` → ``gh pr view``,
 * ``dev.azure.com`` / ``*.visualstudio.com`` → ``az repos pr list``. Any
 * failure — container down, CLI missing, no remote, no PR for the current
 * branch, not authenticated — collapses to ``null`` (the UI shows no badge
 * rather than an error).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import type { ContainerPullRequest } from '@/shared/types';

const execFileAsync = promisify(execFile);

const WORKSPACE_ROOT = '/workspace';
const TIMEOUT_MS = 15_000;
// Same uid that owns /workspace/* (set by the devbox profile's chown init
// step). Matches EXEC_USER in container-files-changed.ts.
const EXEC_USER = '1000:1000';

/** Resolve a per-source mount path inside the container. */
const mountPath = (mountName: string): string => `${WORKSPACE_ROOT}/${mountName}`;

/**
 * Run an arbitrary command inside one source's mounted subdirectory and return
 * stdout. Throws if the command exits non-zero — callers catch and map to null.
 */
const containerExec = async (containerId: string, mountName: string, cmd: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(
    'docker',
    ['exec', '-u', EXEC_USER, '-w', mountPath(mountName), containerId, ...cmd],
    { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }
  );
  return stdout;
};

// ---------------------------------------------------------------------------
// Host detection (pure)
// ---------------------------------------------------------------------------

/**
 * Extract the host from a git remote URL. Handles scp-like SSH
 * (``git@host:path``), ``ssh://`` URLs, and ``https://`` URLs. Returns null
 * when the URL is empty or unparseable.
 */
export function parseRemoteHost(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  if (!url) {
    return null;
  }
  // scp-like form: ``[user@]host:path`` with no scheme.
  if (!url.includes('://')) {
    const scp = url.match(/^(?:[^@/]+@)?([^:/]+):/);
    if (scp?.[1]) {
      return scp[1].toLowerCase();
    }
  }
  try {
    const host = new URL(url).hostname;
    return host ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** True for GitHub remotes (github.com and GitHub Enterprise subdomains). */
export function isGitHubHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'github.com' || h.endsWith('.github.com') || h.includes('github');
}

/** True for Azure DevOps remotes: ``dev.azure.com`` and ``*.visualstudio.com``. */
export function isAzureDevOpsHost(host: string): boolean {
  const h = host.toLowerCase();
  return h.includes('azure.com') || h.includes('visualstudio.com');
}

// ---------------------------------------------------------------------------
// GitHub (pure parse + I/O)
// ---------------------------------------------------------------------------

/** Shape of the JSON ``gh pr view --json number,url,state,title`` returns. */
interface GhPrView {
  number?: number;
  url?: string;
  state?: string;
  title?: string;
}

/** Map a GitHub PR state to the normalized badge state. CLOSED (unmerged) → null. */
function normalizeGitHubState(state: unknown): 'OPEN' | 'MERGED' | null {
  if (state === 'OPEN' || state === 'MERGED') {
    return state;
  }
  return null;
}

/**
 * Parse the stdout of ``gh pr view --json number,url,state`` into a
 * {@link ContainerPullRequest}, or ``null`` when the output is unparseable,
 * missing required fields, or describes a closed-unmerged PR. Open and merged
 * PRs both surface (merged renders as a ✓ badge). Pure — no I/O.
 */
export function parsePullRequestJson(stdout: string): ContainerPullRequest | null {
  let parsed: GhPrView;
  try {
    parsed = JSON.parse(stdout) as GhPrView;
  } catch {
    return null;
  }

  const state = normalizeGitHubState(parsed.state);
  if (typeof parsed.number !== 'number' || typeof parsed.url !== 'string' || state === null) {
    return null;
  }

  return { number: parsed.number, url: parsed.url, state, ...(parsed.title ? { title: parsed.title } : {}) };
}

/**
 * Parse the stdout of ``gh pr list --json number,url,state`` (a JSON array) into
 * every open or merged PR. Used to surface multiple PRs from a single branch
 * (e.g. open to more than one base). Closed-unmerged PRs are dropped. Pure — no I/O.
 */
export function parsePullRequestListJson(stdout: string): ContainerPullRequest[] {
  let arr: unknown;
  try {
    arr = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) {
    return [];
  }
  const out: ContainerPullRequest[] = [];
  for (const item of arr as GhPrView[]) {
    const state = normalizeGitHubState(item?.state);
    if (typeof item?.number === 'number' && typeof item.url === 'string' && state !== null) {
      out.push({ number: item.number, url: item.url, state, ...(item.title ? { title: item.title } : {}) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Azure DevOps (pure parse + I/O)
// ---------------------------------------------------------------------------

/** Subset of an ``az repos pr list --output json`` array element. */
interface AzurePrListItem {
  pullRequestId?: number;
  status?: string;
  title?: string;
  repository?: {
    name?: string;
    url?: string;
    webUrl?: string | null;
    project?: { name?: string };
  };
}

const GUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Compose the browser URL for an Azure PR from a ``pr list`` repository
 * reference. The *list* REST endpoint returns a slim repository (``id``,
 * ``name``, ``url``, ``project`` — ``webUrl`` is null; only create/show
 * responses carry it), so the URL is built from the org base of the REST
 * ``url`` — ``{base}/{org}[/{projectGuid}]/_apis/git/repositories/{id}`` —
 * plus the project and repo *names*: GUID-based ``_git`` web URLs 404.
 * ``webUrl`` is still preferred when the server does send it. Returns null
 * when neither shape is usable.
 */
function azurePullRequestWebUrl(repo: AzurePrListItem['repository'], id: number): string | null {
  if (typeof repo?.webUrl === 'string' && repo.webUrl) {
    return `${repo.webUrl}/pullrequest/${id}`;
  }
  const restUrl = repo?.url;
  const project = repo?.project?.name;
  const name = repo?.name;
  if (typeof restUrl !== 'string' || !project || !name) {
    return null;
  }
  const apisIdx = restUrl.indexOf('/_apis/');
  if (apisIdx < 0) {
    return null;
  }
  // dev.azure.com REST urls carry the project GUID between org and /_apis/;
  // legacy {org}.visualstudio.com ones may not. Strip it when present.
  const segments = restUrl.slice(0, apisIdx).split('/');
  if (GUID_SEGMENT_RE.test(segments[segments.length - 1] ?? '')) {
    segments.pop();
  }
  return `${segments.join('/')}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}/pullrequest/${id}`;
}

/**
 * Parse the stdout of ``az repos pr list --status all --output json`` into
 * every active or completed PR. Azure returns a REST ``url`` (an API endpoint)
 * which isn't browser-openable, so each badge URL is composed by
 * {@link azurePullRequestWebUrl}. States normalize to the GitHub vocabulary
 * (``active`` → OPEN, ``completed`` → MERGED) so the UI treats both providers
 * uniformly; ``abandoned`` PRs are dropped. Pure — no I/O.
 */
export function parseAzurePullRequestListAll(stdout: string): ContainerPullRequest[] {
  let arr: unknown;
  try {
    arr = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) {
    return [];
  }
  const out: ContainerPullRequest[] = [];
  for (const item of arr as AzurePrListItem[]) {
    const state =
      item?.status === 'active' ? ('OPEN' as const) : item?.status === 'completed' ? ('MERGED' as const) : null;
    if (state === null) {
      continue;
    }
    const id = item.pullRequestId;
    if (typeof id !== 'number') {
      continue;
    }
    const url = azurePullRequestWebUrl(item.repository, id);
    if (!url) {
      continue;
    }
    out.push({ number: id, url, state, ...(item.title ? { title: item.title } : {}) });
  }
  return out;
}

/** First surviving Azure PR (the primary PR for the branch), or ``null``. Pure. */
export function parseAzurePullRequestList(stdout: string): ContainerPullRequest | null {
  return parseAzurePullRequestListAll(stdout)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Detection (I/O)
// ---------------------------------------------------------------------------

/** Resolve the origin remote URL of a source inside the container. */
async function containerRemoteUrl(containerId: string, mountName: string): Promise<string | null> {
  try {
    const out = await containerExec(containerId, mountName, ['git', 'remote', 'get-url', 'origin']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Resolve the current branch name of a source inside the container. */
async function containerCurrentBranch(containerId: string, mountName: string): Promise<string | null> {
  try {
    const out = await containerExec(containerId, mountName, ['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = out.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/** Resolve which PR provider (if any) backs a source's origin remote. */
async function resolveProvider(containerId: string, mountName: string): Promise<'github' | 'azure' | null> {
  const remoteUrl = await containerRemoteUrl(containerId, mountName);
  if (!remoteUrl) {
    return null;
  }
  const host = parseRemoteHost(remoteUrl);
  if (!host) {
    return null;
  }
  if (isGitHubHost(host)) {
    return 'github';
  }
  if (isAzureDevOpsHost(host)) {
    return 'azure';
  }
  return null;
}

/** GitHub: ``gh pr view`` resolves the primary PR for the current branch. */
async function detectGitHubPullRequest(containerId: string, mountName: string): Promise<ContainerPullRequest | null> {
  try {
    const [out, branch] = await Promise.all([
      containerExec(containerId, mountName, ['gh', 'pr', 'view', '--json', 'number,url,state,title']),
      containerCurrentBranch(containerId, mountName),
    ]);
    const pr = parsePullRequestJson(out);
    return pr ? { ...pr, provider: 'github', ...(branch ? { branch } : {}) } : null;
  } catch {
    return null;
  }
}

/**
 * GitHub: ``gh pr list --head <branch>`` enumerates every PR for the branch.
 * ``--state all`` so merged PRs surface (as ✓ badges); the parser drops
 * closed-unmerged ones.
 */
async function detectGitHubPullRequests(containerId: string, mountName: string): Promise<ContainerPullRequest[]> {
  const branch = await containerCurrentBranch(containerId, mountName);
  if (!branch) {
    // No resolvable branch name to filter by — fall back to the single
    // current-branch PR that ``gh pr view`` can still resolve.
    const pr = await detectGitHubPullRequest(containerId, mountName);
    return pr ? [pr] : [];
  }
  try {
    const out = await containerExec(containerId, mountName, [
      'gh',
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'number,url,state,title',
    ]);
    return parsePullRequestListJson(out).map((pr) => ({ ...pr, provider: 'github' as const, branch }));
  } catch {
    return [];
  }
}

/**
 * Azure DevOps: ``az repos pr list`` with ``--detect`` infers org/project/repo
 * from the origin remote. ``--status all`` so completed (merged) PRs surface;
 * the parser drops abandoned ones.
 */
async function detectAzurePullRequestList(containerId: string, mountName: string): Promise<ContainerPullRequest[]> {
  const branch = await containerCurrentBranch(containerId, mountName);
  try {
    const out = await containerExec(containerId, mountName, [
      'az',
      'repos',
      'pr',
      'list',
      '--status',
      'all',
      '--detect',
      'true',
      '--output',
      'json',
      ...(branch ? ['--source-branch', branch] : []),
    ]);
    return parseAzurePullRequestListAll(out).map((pr) => ({
      ...pr,
      provider: 'azure' as const,
      ...(branch ? { branch } : {}),
    }));
  } catch {
    return [];
  }
}

/**
 * Detect the primary open-or-merged pull request for the branch currently
 * checked out in ``/workspace/<mountName>``. Picks the provider from the origin
 * remote host. Returns ``null`` when there is no PR, the remote isn't a
 * supported host (plain directory / no remote / unsupported provider), or
 * anything goes wrong. Used by the per-source surfaces (ticket card, Files
 * Changed) that show one badge.
 */
export async function detectContainerPullRequest(
  containerId: string,
  mountName: string
): Promise<ContainerPullRequest | null> {
  if (!containerId || !mountName) {
    return null;
  }
  const provider = await resolveProvider(containerId, mountName);
  if (provider === 'github') {
    return detectGitHubPullRequest(containerId, mountName);
  }
  if (provider === 'azure') {
    return (await detectAzurePullRequestList(containerId, mountName))[0] ?? null;
  }
  return null;
}

/**
 * Detect *all* open-or-merged pull requests for the branch currently checked
 * out in ``/workspace/<mountName>`` (a branch can be open to more than one
 * base). Empty array when none / unsupported / error. Used by the deck + chat
 * banner.
 */
export async function detectContainerPullRequests(
  containerId: string,
  mountName: string
): Promise<ContainerPullRequest[]> {
  if (!containerId || !mountName) {
    return [];
  }
  const provider = await resolveProvider(containerId, mountName);
  if (provider === 'github') {
    return detectGitHubPullRequests(containerId, mountName);
  }
  if (provider === 'azure') {
    return detectAzurePullRequestList(containerId, mountName);
  }
  return [];
}
