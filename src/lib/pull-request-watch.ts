/**
 * Pure helpers for the pull-request watcher (`src/main/pull-request-watcher.ts`):
 * parse a stored `PullRequestLink.url` back into provider coordinates, build the
 * REST endpoints to poll, normalize both providers' responses onto the
 * OPEN/MERGED/CLOSED vocabulary, and compute the transition/review events a
 * poll pass should deliver.
 *
 * The watcher polls the provider APIs directly from the main/server process
 * (with the stored credential) rather than `docker exec`-ing the container
 * CLIs like `container-pull-request.ts` does — PR *events* matter precisely
 * when the container is no longer around to ask.
 */
import type { PullRequestEventKind } from '@/shared/types';

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

export type PullRequestRef =
  | { provider: 'github'; host: string; owner: string; repo: string; number: number }
  | { provider: 'azure'; host: string; org: string; project: string; repo: string; number: number };

/**
 * Parse a browser PR URL (the shape `PullRequestLink.url` stores) into provider
 * coordinates. Handles GitHub (`github.com` and GHES hosts) `/{owner}/{repo}/pull/{n}`,
 * Azure DevOps `dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`, and
 * legacy `{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{id}`.
 * Returns null for anything else.
 */
export function parsePullRequestUrl(url: string): PullRequestRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (host === 'dev.azure.com') {
    if (seg.length >= 6 && seg[2] === '_git' && seg[4]?.toLowerCase() === 'pullrequest') {
      const number = Number(seg[5]);
      if (Number.isInteger(number)) {
        return { provider: 'azure', host, org: seg[0]!, project: seg[1]!, repo: seg[3]!, number };
      }
    }
    return null;
  }
  if (host.endsWith('.visualstudio.com')) {
    const org = host.slice(0, -'.visualstudio.com'.length);
    if (seg.length >= 5 && seg[1] === '_git' && seg[3]?.toLowerCase() === 'pullrequest') {
      const number = Number(seg[4]);
      if (Number.isInteger(number)) {
        return { provider: 'azure', host, org, project: seg[0]!, repo: seg[2]!, number };
      }
    }
    return null;
  }
  if (seg.length >= 4 && seg[2] === 'pull') {
    const number = Number(seg[3]);
    if (Number.isInteger(number)) {
      return { provider: 'github', host, owner: seg[0]!, repo: seg[1]!, number };
    }
  }
  return null;
}

/** Display label for the PR's repository (`owner/repo` or `project/repo`). */
export function pullRequestRepoLabel(ref: PullRequestRef): string {
  return ref.provider === 'github' ? `${ref.owner}/${ref.repo}` : `${ref.project}/${ref.repo}`;
}

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

/** GHES nests its API under `/api/v3`; github.com uses the `api.` subdomain. */
const githubApiBase = (host: string): string =>
  host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;

/** The PR object endpoint (state / merged / title). */
export function pullRequestApiUrl(ref: PullRequestRef): string {
  if (ref.provider === 'github') {
    return `${githubApiBase(ref.host)}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}`;
  }
  const base =
    ref.host === 'dev.azure.com' ? `https://dev.azure.com/${encodeURIComponent(ref.org)}` : `https://${ref.host}`;
  return (
    `${base}/${encodeURIComponent(ref.project)}/_apis/git/repositories/` +
    `${encodeURIComponent(ref.repo)}/pullRequests/${ref.number}?api-version=7.1`
  );
}

/** GitHub only: the PR's reviews list (approvals / change requests). */
export function pullRequestReviewsApiUrl(ref: PullRequestRef & { provider: 'github' }): string {
  return `${pullRequestApiUrl(ref)}/reviews?per_page=100`;
}

/** GitHub only: check runs for the PR's head commit (GitHub Actions et al.). */
export function checkRunsApiUrl(ref: PullRequestRef & { provider: 'github' }, sha: string): string {
  return (
    `${githubApiBase(ref.host)}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}` +
    `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`
  );
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

/** Provider-neutral live PR state, on the same vocabulary `PullRequestLink.state` uses. */
export type PullRequestLiveState = {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  title?: string;
  /** GitHub only: the PR's head commit, the key for check-run polling. */
  headSha?: string;
};

/** Normalize a GitHub `GET /pulls/{n}` body. `closed` splits on `merged`. */
export function normalizeGithubPullRequest(json: unknown): PullRequestLiveState | null {
  const d = json as { state?: unknown; merged?: unknown; title?: unknown; head?: { sha?: unknown } } | null;
  if (!d || typeof d.state !== 'string') {
    return null;
  }
  const state = d.state === 'open' ? 'OPEN' : d.merged === true ? 'MERGED' : 'CLOSED';
  return {
    state,
    ...(typeof d.title === 'string' ? { title: d.title } : {}),
    ...(typeof d.head?.sha === 'string' ? { headSha: d.head.sha } : {}),
  };
}

/** Normalize an Azure DevOps `GET pullRequests/{id}` body (active/completed/abandoned). */
export function normalizeAzurePullRequest(json: unknown): PullRequestLiveState | null {
  const d = json as { status?: unknown; title?: unknown } | null;
  const state =
    d?.status === 'active'
      ? 'OPEN'
      : d?.status === 'completed'
        ? 'MERGED'
        : d?.status === 'abandoned'
          ? 'CLOSED'
          : null;
  if (state === null) {
    return null;
  }
  return { state, ...(typeof d?.title === 'string' ? { title: d.title } : {}) };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** One thing that happened to a watched PR since the last poll. */
export type PullRequestWatchEvent = {
  kind: PullRequestEventKind;
  url: string;
  number: number;
  repo: string;
  title?: string;
  /** Reviewer login, for review-verdict kinds. */
  by?: string;
  /** Failing check names, for `ci_failed`. */
  checks?: string[];
};

/**
 * The state transition a poll observed, if any. Only OPEN links are watched,
 * so the interesting edges are exactly open→merged and open→closed-unmerged.
 */
export function pullRequestStateTransition(
  previousState: string,
  live: PullRequestLiveState
): 'merged' | 'closed' | null {
  if (previousState !== 'OPEN') {
    return null;
  }
  return live.state === 'MERGED' ? 'merged' : live.state === 'CLOSED' ? 'closed' : null;
}

export type PullRequestReviewEvent = { kind: 'approved' | 'changes_requested'; by: string; at: number };

/**
 * Diff a GitHub reviews list against the link's durable watermark.
 *
 * - `watermarkAt` undefined (first sight of this PR): no events — reviews that
 *   existed before we started watching were never "news" here — but the
 *   returned watermark covers them so only later reviews fire.
 * - Otherwise: APPROVED / CHANGES_REQUESTED reviews newer than the watermark
 *   become events, oldest first. COMMENTED / DISMISSED rows advance the
 *   watermark without firing (no digest path for ambient review chatter).
 *
 * The returned `watermarkAt` is what the caller persists on the link.
 */
export function collectReviewEvents(
  json: unknown,
  watermarkAt: number | undefined
): { events: PullRequestReviewEvent[]; watermarkAt: number } {
  const floor = watermarkAt ?? 0;
  let max = floor;
  const events: PullRequestReviewEvent[] = [];
  if (Array.isArray(json)) {
    for (const r of json as Array<{ user?: { login?: unknown }; state?: unknown; submitted_at?: unknown }>) {
      const at = typeof r?.submitted_at === 'string' ? Date.parse(r.submitted_at) : NaN;
      if (!Number.isFinite(at)) {
        continue;
      }
      if (at > max) {
        max = at;
      }
      if (watermarkAt === undefined || at <= floor) {
        continue;
      }
      const by = typeof r.user?.login === 'string' ? r.user.login : 'a reviewer';
      if (r.state === 'APPROVED') {
        events.push({ kind: 'approved', by, at });
      } else if (r.state === 'CHANGES_REQUESTED') {
        events.push({ kind: 'changes_requested', by, at });
      }
    }
  }
  events.sort((a, b) => a.at - b.at);
  return { events, watermarkAt: max };
}

// ---------------------------------------------------------------------------
// CI (GitHub check runs)
// ---------------------------------------------------------------------------

/** Settled-or-not view of one head commit's check runs. */
export type CheckRunSummary = { state: 'pending' | 'failing' | 'green'; failing: string[] };

const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);

/**
 * Summarize a GitHub `GET /commits/{sha}/check-runs` body.
 *
 * - Any run with a failing conclusion → `failing` immediately (early signal;
 *   the announce-once cursor absorbs later failures on the same commit).
 * - Otherwise any queued/in-progress run → `pending` (not announceable yet).
 * - Otherwise → `green` (skipped/neutral/cancelled runs don't block green).
 * - No runs at all → null: the repo has no checks, CI events never fire.
 */
export function summarizeCheckRuns(json: unknown): CheckRunSummary | null {
  const d = json as { check_runs?: unknown } | null;
  if (!d || !Array.isArray(d.check_runs) || d.check_runs.length === 0) {
    return null;
  }
  const failing: string[] = [];
  let pending = false;
  for (const run of d.check_runs as Array<{ name?: unknown; status?: unknown; conclusion?: unknown }>) {
    if (run?.status !== 'completed') {
      pending = true;
    } else if (typeof run.conclusion === 'string' && FAILING_CONCLUSIONS.has(run.conclusion)) {
      failing.push(typeof run.name === 'string' ? run.name : 'a check');
    }
  }
  if (failing.length > 0) {
    return { state: 'failing', failing };
  }
  return { state: pending ? 'pending' : 'green', failing: [] };
}

/**
 * What a settled check summary means against the link's announce cursor
 * (`ciState` + `ciSha`, persisted together — the state is meaningless without
 * the commit it was computed from).
 *
 * - `failing` announces once per failing head commit: a fresh failure AND a
 *   push that fails again both wake the agent; the same commit never repeats.
 * - `green` announces only as a recovery (previous cursor said failing) —
 *   green is the default expectation, not news.
 * - `pending` neither announces nor moves the cursor.
 */
export function ciTransition(
  prev: { state?: 'failing' | 'green'; sha?: string },
  sha: string,
  summary: CheckRunSummary
): { event: 'ci_failed' | 'ci_green' | null; next: 'failing' | 'green' | null } {
  if (summary.state === 'pending') {
    return { event: null, next: null };
  }
  if (summary.state === 'failing') {
    return { event: prev.state !== 'failing' || prev.sha !== sha ? 'ci_failed' : null, next: 'failing' };
  }
  return { event: prev.state === 'failing' ? 'ci_green' : null, next: 'green' };
}

/**
 * The wakeup detail line for a PR event — the `pr_event` idiom matches
 * `assignment`: a delta with the reference, the agent pulls the rest itself
 * (its sandbox has `gh` / `az` logged in).
 */
export function pullRequestEventDetail(ev: PullRequestWatchEvent): string {
  const pr = `pull request #${ev.number}${ev.title ? ` "${ev.title}"` : ''} in ${ev.repo}`;
  switch (ev.kind) {
    case 'merged':
      return `your ${pr} was merged`;
    case 'closed':
      return `your ${pr} was closed without merging`;
    case 'approved':
      return `${ev.by ?? 'a reviewer'} approved your ${pr}`;
    case 'changes_requested':
      return (
        `${ev.by ?? 'a reviewer'} requested changes on your ${pr} — ` +
        `read the review from your workspace (\`gh pr view ${ev.number} --comments\`) and address it`
      );
    case 'ci_failed':
      return (
        `CI is failing on your ${pr}${ev.checks?.length ? ` (${ev.checks.join(', ')})` : ''} — ` +
        `read the logs from your workspace (\`gh pr checks ${ev.number}\`) and fix it`
      );
    case 'ci_green':
      return `CI is green again on your ${pr}`;
  }
}

/**
 * The one-line #system row for a PR event — the team-visible record. Compact:
 * the channel log is scannable history, the actionable phrasing lives in the
 * assignee's wakeup detail.
 */
export function pullRequestSystemLine(ev: PullRequestWatchEvent): string {
  const pr = `PR #${ev.number}${ev.title ? ` "${ev.title}"` : ''} (${ev.repo})`;
  switch (ev.kind) {
    case 'merged':
      return `${pr} was merged`;
    case 'closed':
      return `${pr} was closed without merging`;
    case 'approved':
      return `${ev.by ?? 'a reviewer'} approved ${pr}`;
    case 'changes_requested':
      return `${ev.by ?? 'a reviewer'} requested changes on ${pr}`;
    case 'ci_failed':
      return `CI is failing on ${pr}${ev.checks?.length ? ` (${ev.checks.join(', ')})` : ''}`;
    case 'ci_green':
      return `CI is green again on ${pr}`;
  }
}
