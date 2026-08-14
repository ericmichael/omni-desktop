import { describe, expect, it, vi } from 'vitest';

import { PullRequestWatcher, type PullRequestWatcherDeps } from '@/main/pull-request-watcher';
import type { PullRequestLink, Ticket } from '@/shared/types';

const NOW = Date.parse('2026-08-13T12:00:00Z');

const link = (overrides: Partial<PullRequestLink> = {}): PullRequestLink => ({
  url: 'https://github.com/acme/launcher/pull/142',
  number: 142,
  state: 'OPEN',
  title: 'Fix the thing',
  provider: 'github',
  createdAt: NOW - 60_000,
  lastSeenAt: NOW - 30_000,
  ...overrides,
});

const ticket = (overrides: Partial<Ticket> = {}): Ticket =>
  ({
    id: 'tick_1',
    projectId: 'proj_1',
    title: 'Ship the thing',
    assignee: 'agent:res_1',
    pullRequests: [link()],
    ...overrides,
  }) as Ticket;

/** JSON `fetch` stub keyed by URL substring; unmatched URLs 404. */
const fakeFetch = (routes: Record<string, unknown>): PullRequestWatcherDeps['fetchFn'] =>
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { etag: `"${hit[0]}"` } });
  }) as unknown as PullRequestWatcherDeps['fetchFn'];

const cred = { id: 'cred_1', host: 'github.com', username: 'x-access-token', last4: '1234', createdAt: NOW };

type MockedDeps = PullRequestWatcherDeps & {
  updateTicket: ReturnType<typeof vi.fn>;
  setGlobalLinks: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
};

const makeDeps = (
  overrides: Partial<PullRequestWatcherDeps> & { fetchFn: PullRequestWatcherDeps['fetchFn'] }
): MockedDeps =>
  ({
    getSnapshot: () => ({
      tickets: [ticket()],
      pullRequestLinks: [],
      gitCredentials: [cred],
    }),
    resolveGitToken: async () => 'tok',
    updateTicket: vi.fn(),
    setGlobalLinks: vi.fn(),
    onEvent: vi.fn(),
    now: () => NOW,
    ...overrides,
  }) as MockedDeps;

describe('PullRequestWatcher.poll', () => {
  it('persists an open→merged flip on the ticket and wakes the assignee', async () => {
    const deps = makeDeps({
      fetchFn: fakeFetch({
        '/pulls/142/reviews': [],
        '/pulls/142': { state: 'closed', merged: true, title: 'Fix the thing' },
      }),
    });
    await new PullRequestWatcher(deps).poll();

    expect(deps.updateTicket).toHaveBeenCalledTimes(1);
    const [ticketId, patch] = deps.updateTicket.mock.calls[0]!;
    expect(ticketId).toBe('tick_1');
    expect(patch.pullRequests[0]).toMatchObject({ state: 'MERGED', reviewWatermarkAt: 0 });
    expect(deps.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'merged',
        number: 142,
        repo: 'acme/launcher',
        ticketId: 'tick_1',
        assignee: 'agent:res_1',
      })
    );
  });

  it('first sight arms the review cursor without firing; later reviews fire', async () => {
    const routes = {
      '/pulls/142/reviews': [] as unknown[],
      '/pulls/142': { state: 'open', merged: false, title: 'Fix the thing' },
    };
    const deps = makeDeps({ fetchFn: fakeFetch(routes) });
    const watcher = new PullRequestWatcher(deps);

    await watcher.poll();
    // No transition, but the undefined watermark must be persisted as 0.
    expect(deps.onEvent).not.toHaveBeenCalled();
    expect(deps.updateTicket).toHaveBeenCalledTimes(1);
    expect(deps.updateTicket.mock.calls[0]![1].pullRequests[0]).toMatchObject({ reviewWatermarkAt: 0 });

    // Next pass sees an armed cursor (0) and a fresh review → event fires.
    routes['/pulls/142/reviews'] = [
      { user: { login: 'alice' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-13T11:59:00Z' },
    ];
    const armed = makeDeps({
      fetchFn: fakeFetch(routes),
      getSnapshot: () => ({
        tickets: [ticket({ pullRequests: [link({ reviewWatermarkAt: 0 })] })],
        pullRequestLinks: [],
        gitCredentials: [cred],
      }),
    });
    await new PullRequestWatcher(armed).poll();
    expect(armed.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'changes_requested', by: 'alice', assignee: 'agent:res_1' })
    );
    expect(armed.updateTicket.mock.calls[0]![1].pullRequests[0]!.reviewWatermarkAt).toBe(
      Date.parse('2026-08-13T11:59:00Z')
    );
  });

  it('updates global (ticket-less) links without review polling or events', async () => {
    const fetchFn = fakeFetch({ '/pulls/142': { state: 'closed', merged: true } });
    const deps = makeDeps({
      fetchFn,
      getSnapshot: () => ({
        tickets: [],
        pullRequestLinks: [link({ sessionId: 'sess_1' })],
        gitCredentials: [cred],
      }),
    });
    await new PullRequestWatcher(deps).poll();

    expect(deps.setGlobalLinks).toHaveBeenCalledTimes(1);
    expect(deps.setGlobalLinks.mock.calls[0]![0][0]).toMatchObject({ state: 'MERGED' });
    // No assignee → the event still surfaces (entry points decide delivery)…
    expect(deps.onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'merged' }));
    expect(deps.onEvent.mock.calls[0]![0].assignee).toBeUndefined();
    // …and reviews were never requested.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('skips links with no matching credential or token, and survives request errors', async () => {
    const deps = makeDeps({
      fetchFn: fakeFetch({}), // every request 404s
      resolveGitToken: async (id) => (id === 'cred_1' ? 'tok' : undefined),
    });
    await new PullRequestWatcher(deps).poll();
    expect(deps.updateTicket).not.toHaveBeenCalled();
    expect(deps.onEvent).not.toHaveBeenCalled();

    const noCred = makeDeps({
      fetchFn: fakeFetch({ '/pulls/142': { state: 'closed', merged: true } }),
      getSnapshot: () => ({ tickets: [ticket()], pullRequestLinks: [], gitCredentials: [] }),
    });
    await new PullRequestWatcher(noCred).poll();
    expect(noCred.onEvent).not.toHaveBeenCalled();
  });

  it('sends If-None-Match on the second pass and treats 304 as unchanged', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers);
      if (headers['If-None-Match']) {
        return new Response(null, { status: 304 });
      }
      return new Response(JSON.stringify({ state: 'open', merged: false, title: 'Fix the thing' }), {
        status: 200,
        headers: { etag: '"abc"' },
      });
    }) as unknown as PullRequestWatcherDeps['fetchFn'];
    const deps = makeDeps({
      fetchFn,
      getSnapshot: () => ({
        tickets: [ticket({ pullRequests: [link({ reviewWatermarkAt: 5 })] })],
        pullRequestLinks: [],
        gitCredentials: [cred],
      }),
    });
    const watcher = new PullRequestWatcher(deps);
    await watcher.poll();
    await watcher.poll();
    expect(seen.some((h) => h['If-None-Match'] === '"abc"')).toBe(true);
    expect(deps.onEvent).not.toHaveBeenCalled();
    expect(deps.updateTicket).not.toHaveBeenCalled();
  });

  it('fires ci_failed once per failing head commit and persists the cursor', async () => {
    const routes: Record<string, unknown> = {
      '/pulls/142/reviews': [],
      '/pulls/142': { state: 'open', merged: false, title: 'Fix the thing', head: { sha: 'sha1' } },
      '/commits/sha1/check-runs': {
        check_runs: [
          { name: 'build', status: 'completed', conclusion: 'success' },
          { name: 'test', status: 'completed', conclusion: 'failure' },
        ],
      },
    };
    // Armed review cursor so only CI is in play.
    const snapshotWith = (l: PullRequestLink) => () => ({
      tickets: [ticket({ pullRequests: [l] })],
      pullRequestLinks: [],
      gitCredentials: [cred],
    });
    const deps = makeDeps({
      fetchFn: fakeFetch(routes),
      getSnapshot: snapshotWith(link({ reviewWatermarkAt: 0 })),
    });
    await new PullRequestWatcher(deps).poll();
    expect(deps.onEvent).toHaveBeenCalledTimes(1);
    expect(deps.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ci_failed', checks: ['test'], assignee: 'agent:res_1' })
    );
    expect(deps.updateTicket.mock.calls[0]![1].pullRequests[0]).toMatchObject({ ciState: 'failing', ciSha: 'sha1' });

    // Same commit still failing → quiet. New commit failing → announced again.
    const quiet = makeDeps({
      fetchFn: fakeFetch(routes),
      getSnapshot: snapshotWith(link({ reviewWatermarkAt: 0, ciState: 'failing', ciSha: 'sha1' })),
    });
    await new PullRequestWatcher(quiet).poll();
    expect(quiet.onEvent).not.toHaveBeenCalled();

    routes['/pulls/142'] = { state: 'open', merged: false, title: 'Fix the thing', head: { sha: 'sha2' } };
    routes['/commits/sha2/check-runs'] = routes['/commits/sha1/check-runs'];
    const pushed = makeDeps({
      fetchFn: fakeFetch(routes),
      getSnapshot: snapshotWith(link({ reviewWatermarkAt: 0, ciState: 'failing', ciSha: 'sha1' })),
    });
    await new PullRequestWatcher(pushed).poll();
    expect(pushed.onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ci_failed' }));
  });

  it('announces ci_green only as a recovery from failing', async () => {
    const routes = {
      '/pulls/142/reviews': [] as unknown[],
      '/pulls/142': { state: 'open', merged: false, title: 'Fix the thing', head: { sha: 'sha2' } },
      '/commits/sha2/check-runs': { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
    };
    const snapshotWith = (l: PullRequestLink) => () => ({
      tickets: [ticket({ pullRequests: [l] })],
      pullRequestLinks: [],
      gitCredentials: [cred],
    });
    const recovered = makeDeps({
      fetchFn: fakeFetch(routes),
      getSnapshot: snapshotWith(link({ reviewWatermarkAt: 0, ciState: 'failing', ciSha: 'sha1' })),
    });
    await new PullRequestWatcher(recovered).poll();
    expect(recovered.onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ci_green' }));
    expect(recovered.updateTicket.mock.calls[0]![1].pullRequests[0]).toMatchObject({
      ciState: 'green',
      ciSha: 'sha2',
    });

    // Green with no failing history: cursor persists silently, no event.
    const fresh = makeDeps({
      fetchFn: fakeFetch(routes),
      getSnapshot: snapshotWith(link({ reviewWatermarkAt: 0 })),
    });
    await new PullRequestWatcher(fresh).poll();
    expect(fresh.onEvent).not.toHaveBeenCalled();
    expect(fresh.updateTicket.mock.calls[0]![1].pullRequests[0]).toMatchObject({ ciState: 'green', ciSha: 'sha2' });
  });

  it('stays quiet while checks are pending and skips checks on ticket-less links', async () => {
    const routes = {
      '/pulls/142/reviews': [] as unknown[],
      '/pulls/142': { state: 'open', merged: false, title: 'Fix the thing', head: { sha: 'sha1' } },
      '/commits/sha1/check-runs': { check_runs: [{ name: 'build', status: 'in_progress' }] },
    };
    const deps = makeDeps({
      fetchFn: fakeFetch(routes),
      getSnapshot: () => ({
        tickets: [ticket({ pullRequests: [link({ reviewWatermarkAt: 0 })] })],
        pullRequestLinks: [],
        gitCredentials: [cred],
      }),
    });
    await new PullRequestWatcher(deps).poll();
    expect(deps.onEvent).not.toHaveBeenCalled();
    expect(deps.updateTicket).not.toHaveBeenCalled();

    const global = makeDeps({
      fetchFn: fakeFetch(routes),
      getSnapshot: () => ({
        tickets: [],
        pullRequestLinks: [link({ sessionId: 'sess_1', reviewWatermarkAt: 0 })],
        gitCredentials: [cred],
      }),
    });
    const globalFetch = global.fetchFn as ReturnType<typeof vi.fn>;
    await new PullRequestWatcher(global).poll();
    // Only the PR object itself — no reviews, no check-runs.
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores stale and non-OPEN links', async () => {
    const fetchFn = fakeFetch({ '/pulls/142': { state: 'closed', merged: true } });
    const deps = makeDeps({
      fetchFn,
      getSnapshot: () => ({
        tickets: [
          ticket({
            pullRequests: [
              link({ state: 'MERGED' }),
              link({ url: 'https://github.com/acme/old/pull/1', lastSeenAt: NOW - 40 * 24 * 60 * 60_000 }),
            ],
          }),
        ],
        pullRequestLinks: [],
        gitCredentials: [cred],
      }),
    });
    await new PullRequestWatcher(deps).poll();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
