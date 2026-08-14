/**
 * Background pull-request watcher: polls the provider REST APIs (GitHub /
 * Azure DevOps) for every persisted OPEN `PullRequestLink` and turns observed
 * changes into durable state updates plus `pr_event` resident wakeups.
 *
 * This is the launcher-side complement to `container-pull-request.ts`: that
 * path detects PRs *through the running container's* authenticated CLIs, so it
 * dies with the container. The watcher instead reads tokens from the secret
 * store (the same credentials `resolveGitAuth` injects at sandbox boot) and
 * talks to the APIs directly, so a merge or a review verdict is noticed even
 * when no column is open — exactly when a wakeup is worth something.
 *
 * Polling posture: one pass per minute over a bounded, recency-pruned watch
 * list. GitHub requests carry `If-None-Match`, so an unchanged PR costs a 304
 * that GitHub does not count against the rate limit; review polling only runs
 * for links that can actually wake someone (a ticket with an assignee). All
 * failures are best-effort: a link that errors is skipped until the next pass.
 */
import {
  checkRunsApiUrl,
  ciTransition,
  collectReviewEvents,
  normalizeAzurePullRequest,
  normalizeGithubPullRequest,
  parsePullRequestUrl,
  pullRequestApiUrl,
  type PullRequestRef,
  pullRequestRepoLabel,
  pullRequestReviewsApiUrl,
  pullRequestStateTransition,
  type PullRequestWatchEvent,
  summarizeCheckRuns,
} from '@/lib/pull-request-watch';
import { resolveCredentialForUrl } from '@/shared/git-credentials';
import type { PullRequestLink, StoreData, Ticket, TicketId } from '@/shared/types';

const POLL_INTERVAL_MS = 60_000;
/** First pass waits out app boot (managers hydrating, snapshot filling). */
const INITIAL_DELAY_MS = 20_000;
/** Watch-list bound per pass (most recently seen first). */
const MAX_WATCHED = 50;
/** Links not seen by any detector for this long stop being polled. */
const STALE_LINK_MS = 30 * 24 * 60 * 60_000;

/** Where a link lives — decides how a state change is persisted and who wakes. */
type WatchedLink = {
  link: PullRequestLink;
  home: { kind: 'ticket'; ticketId: TicketId; assignee?: string } | { kind: 'global' };
};

export type PullRequestWatcherDeps = {
  /** Current tickets + scoped links + credential metadata (tokens stay in the secret store). */
  getSnapshot: () => Pick<StoreData, 'tickets' | 'pullRequestLinks' | 'gitCredentials'>;
  resolveGitToken: (credentialId: string) => Promise<string | undefined>;
  fetchFn: typeof globalThis.fetch;
  /** Persist changed links on their owning ticket (the `pr_review` column home). */
  updateTicket: (ticketId: TicketId, patch: { pullRequests: PullRequestLink[] }) => void;
  /** Persist the changed global (ticket-less) link list. */
  setGlobalLinks: (links: PullRequestLink[]) => void;
  /** A watched PR changed. `assignee` is the owning ticket's assignee, verbatim. */
  onEvent: (ev: PullRequestWatchEvent & { ticketId?: TicketId; assignee?: string }) => void;
  now?: () => number;
};

export class PullRequestWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** `If-None-Match` cache, keyed by request URL. In-memory only — after a
   *  restart the first pass re-fetches and the durable link state dedupes. */
  private etags = new Map<string, string>();
  /** URLs that already logged a failure — one warning each, not one per pass. */
  private warned = new Set<string>();
  /** Freshest head sha per PR url, from the last 200 PR body — lets check-run
   *  polling proceed on passes where the PR object itself 304s. */
  private headShas = new Map<string, string>();
  private polling = false;

  constructor(private deps: PullRequestWatcherDeps) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const tick = (): void => {
      this.timer = setTimeout(tick, POLL_INTERVAL_MS);
      this.timer.unref?.();
      void this.poll();
    };
    this.timer = setTimeout(tick, INITIAL_DELAY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One full pass. Exposed for tests; the interval calls it fire-and-forget. */
  poll = async (): Promise<void> => {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (err) {
      console.warn('[pr-watcher] poll pass failed:', err);
    } finally {
      this.polling = false;
    }
  };

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Collect the bounded watch list: OPEN links, ticket homes first (they can
   *  wake someone), deduped by URL, recency-pruned. */
  private watchList(snapshot: Pick<StoreData, 'tickets' | 'pullRequestLinks'>): WatchedLink[] {
    const cutoff = this.now() - STALE_LINK_MS;
    const byUrl = new Map<string, WatchedLink>();
    for (const ticket of snapshot.tickets ?? []) {
      for (const link of ticket.pullRequests ?? []) {
        if (link.state === 'OPEN' && link.lastSeenAt >= cutoff && !byUrl.has(link.url)) {
          byUrl.set(link.url, {
            link,
            home: { kind: 'ticket', ticketId: ticket.id, ...(ticket.assignee ? { assignee: ticket.assignee } : {}) },
          });
        }
      }
    }
    for (const link of snapshot.pullRequestLinks ?? []) {
      if (link.state === 'OPEN' && link.lastSeenAt >= cutoff && !byUrl.has(link.url)) {
        byUrl.set(link.url, { link, home: { kind: 'global' } });
      }
    }
    return [...byUrl.values()].sort((a, b) => b.link.lastSeenAt - a.link.lastSeenAt).slice(0, MAX_WATCHED);
  }

  private async pollOnce(): Promise<void> {
    const snapshot = this.deps.getSnapshot();
    const credentials = snapshot.gitCredentials ?? [];
    if (credentials.length === 0) {
      return;
    }
    const watched = this.watchList(snapshot);
    if (watched.length === 0) {
      return;
    }

    // Patched links accumulate per home; one write per ticket / one for the
    // global list at the end of the pass.
    const ticketPatches = new Map<TicketId, Map<string, PullRequestLink>>();
    let globalPatches: Map<string, PullRequestLink> | null = null;
    const events: Array<PullRequestWatchEvent & { ticketId?: TicketId; assignee?: string }> = [];

    for (const { link, home } of watched) {
      const ref = parsePullRequestUrl(link.url);
      if (!ref) {
        continue;
      }
      const cred = resolveCredentialForUrl(credentials, link.url);
      if (!cred) {
        continue;
      }
      const token = await this.deps.resolveGitToken(cred.id);
      if (!token) {
        continue;
      }
      try {
        const patch = await this.pollLink(link, home, ref, token, events);
        if (patch) {
          if (home.kind === 'ticket') {
            const forTicket = ticketPatches.get(home.ticketId) ?? new Map<string, PullRequestLink>();
            forTicket.set(link.url, patch);
            ticketPatches.set(home.ticketId, forTicket);
          } else {
            globalPatches ??= new Map<string, PullRequestLink>();
            globalPatches.set(link.url, patch);
          }
        }
      } catch (err) {
        if (!this.warned.has(link.url)) {
          this.warned.add(link.url);
          console.warn(`[pr-watcher] polling ${link.url} failed (will keep retrying quietly):`, err);
        }
      }
    }

    // Persist: re-read each home from the snapshot and swap the changed links
    // in by URL, so untouched links ride through unchanged.
    for (const [ticketId, patches] of ticketPatches) {
      const ticket = (snapshot.tickets ?? []).find((t: Ticket) => t.id === ticketId);
      if (!ticket) {
        continue;
      }
      this.deps.updateTicket(ticketId, {
        pullRequests: (ticket.pullRequests ?? []).map((l) => patches.get(l.url) ?? l),
      });
    }
    if (globalPatches) {
      const patches = globalPatches;
      this.deps.setGlobalLinks((snapshot.pullRequestLinks ?? []).map((l) => patches.get(l.url) ?? l));
    }
    for (const ev of events) {
      this.deps.onEvent(ev);
    }
  }

  /**
   * Poll one link: PR state (both providers) plus reviews (GitHub, only when
   * the home ticket has an assignee to wake). Returns the patched link when
   * anything durable changed, pushing observed events onto `events`.
   */
  private async pollLink(
    link: PullRequestLink,
    home: WatchedLink['home'],
    ref: PullRequestRef,
    token: string,
    events: Array<PullRequestWatchEvent & { ticketId?: TicketId; assignee?: string }>
  ): Promise<PullRequestLink | null> {
    const repo = pullRequestRepoLabel(ref);
    const homeCtx =
      home.kind === 'ticket' ? { ticketId: home.ticketId, ...(home.assignee ? { assignee: home.assignee } : {}) } : {};
    let patched: PullRequestLink | null = null;
    const patch = (fields: Partial<PullRequestLink>): void => {
      patched = { ...(patched ?? link), ...fields };
    };

    const prBody = await this.fetchJson(pullRequestApiUrl(ref), ref, token);
    if (prBody !== 'unchanged') {
      const live = ref.provider === 'github' ? normalizeGithubPullRequest(prBody) : normalizeAzurePullRequest(prBody);
      if (live) {
        if (live.headSha) {
          this.headShas.set(link.url, live.headSha);
        }
        if (live.title && live.title !== link.title) {
          patch({ title: live.title });
        }
        const transition = pullRequestStateTransition(link.state, live);
        if (transition) {
          patch({ state: live.state, lastSeenAt: this.now() });
          events.push({
            kind: transition,
            url: link.url,
            number: link.number,
            repo,
            ...((live.title ?? link.title) ? { title: live.title ?? link.title } : {}),
            ...homeCtx,
          });
        }
      }
    }

    // Review verdicts: GitHub only (ADO reviewer votes carry no timestamps to
    // cursor against — its links get state transitions only), and only where
    // there is someone to wake.
    if (ref.provider === 'github' && home.kind === 'ticket' && home.assignee) {
      const reviewsBody = await this.fetchJson(pullRequestReviewsApiUrl(ref), ref, token);
      if (reviewsBody !== 'unchanged') {
        const { events: reviewEvents, watermarkAt } = collectReviewEvents(reviewsBody, link.reviewWatermarkAt);
        // First sight persists the cursor even when it's 0 (no reviews yet) —
        // an undefined watermark suppresses events, so it must not survive
        // past the first poll or the PR's first review would be swallowed.
        if (link.reviewWatermarkAt === undefined || watermarkAt !== link.reviewWatermarkAt) {
          patch({ reviewWatermarkAt: watermarkAt });
        }
        for (const rev of reviewEvents) {
          events.push({
            kind: rev.kind,
            url: link.url,
            number: link.number,
            repo,
            by: rev.by,
            ...(link.title ? { title: link.title } : {}),
            ...homeCtx,
          });
        }
      }
    }

    // CI check runs: same gating as reviews, and only while the PR is still
    // OPEN (a PR that just merged/closed above needs no CI verdict). The head
    // sha comes from this pass's PR body when it was a 200, else the in-memory
    // cache, else the persisted cursor — a PR 304 doesn't mean checks are
    // unchanged (check completion doesn't touch the PR object's ETag).
    const stillOpen = ((patched as PullRequestLink | null)?.state ?? link.state) === 'OPEN';
    if (ref.provider === 'github' && home.kind === 'ticket' && home.assignee && stillOpen) {
      const sha = this.headShas.get(link.url) ?? link.ciSha;
      if (sha) {
        const checksBody = await this.fetchJson(checkRunsApiUrl(ref, sha), ref, token);
        if (checksBody !== 'unchanged') {
          const summary = summarizeCheckRuns(checksBody);
          if (summary) {
            const { event, next } = ciTransition({ state: link.ciState, sha: link.ciSha }, sha, summary);
            if (next && (next !== link.ciState || sha !== link.ciSha)) {
              patch({ ciState: next, ciSha: sha });
            }
            if (event) {
              events.push({
                kind: event,
                url: link.url,
                number: link.number,
                repo,
                ...(summary.failing.length > 0 ? { checks: summary.failing } : {}),
                ...(link.title ? { title: link.title } : {}),
                ...homeCtx,
              });
            }
          }
        }
      }
    }
    return patched;
  }

  /** Conditional GET: `'unchanged'` on 304, parsed JSON on 200, throws otherwise. */
  private async fetchJson(url: string, ref: PullRequestRef, token: string): Promise<unknown | 'unchanged'> {
    const headers: Record<string, string> =
      ref.provider === 'github'
        ? { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }
        : { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}` };
    const etag = this.etags.get(url);
    if (etag) {
      headers['If-None-Match'] = etag;
    }
    const resp = await this.deps.fetchFn(url, { headers });
    if (resp.status === 304) {
      return 'unchanged';
    }
    if (!resp.ok) {
      throw new Error(`${resp.status} ${resp.statusText}`);
    }
    const nextEtag = resp.headers.get('etag');
    if (nextEtag) {
      this.etags.set(url, nextEtag);
    }
    return resp.json();
  }
}

/** Factory in the launcher's `[instance, cleanup]` manager convention. */
export const createPullRequestWatcher = (deps: PullRequestWatcherDeps): [PullRequestWatcher, () => void] => {
  const watcher = new PullRequestWatcher(deps);
  watcher.start();
  return [
    watcher,
    () => {
      watcher.stop();
    },
  ];
};
