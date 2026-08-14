import { describe, expect, it } from 'vitest';

import {
  checkRunsApiUrl,
  ciTransition,
  collectReviewEvents,
  normalizeAzurePullRequest,
  normalizeGithubPullRequest,
  parsePullRequestUrl,
  pullRequestApiUrl,
  pullRequestEventDetail,
  pullRequestRepoLabel,
  pullRequestReviewsApiUrl,
  pullRequestStateTransition,
  pullRequestSystemLine,
  summarizeCheckRuns,
} from './pull-request-watch';

describe('parsePullRequestUrl', () => {
  it('parses github.com PR urls', () => {
    expect(parsePullRequestUrl('https://github.com/acme/launcher/pull/142')).toEqual({
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'launcher',
      number: 142,
    });
  });

  it('parses GHES PR urls', () => {
    expect(parsePullRequestUrl('https://ghe.corp.example/acme/launcher/pull/7')).toMatchObject({
      provider: 'github',
      host: 'ghe.corp.example',
      number: 7,
    });
  });

  it('parses dev.azure.com PR urls', () => {
    expect(parsePullRequestUrl('https://dev.azure.com/myorg/My%20Project/_git/repo/pullrequest/55')).toEqual({
      provider: 'azure',
      host: 'dev.azure.com',
      org: 'myorg',
      project: 'My Project',
      repo: 'repo',
      number: 55,
    });
  });

  it('parses legacy visualstudio.com PR urls', () => {
    expect(parsePullRequestUrl('https://myorg.visualstudio.com/Proj/_git/repo/pullrequest/9')).toEqual({
      provider: 'azure',
      host: 'myorg.visualstudio.com',
      org: 'myorg',
      project: 'Proj',
      repo: 'repo',
      number: 9,
    });
  });

  it('rejects non-PR and malformed urls', () => {
    expect(parsePullRequestUrl('https://github.com/acme/launcher/issues/3')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/acme/launcher/pull/not-a-number')).toBeNull();
    expect(parsePullRequestUrl('https://dev.azure.com/myorg/proj/_git/repo')).toBeNull();
    expect(parsePullRequestUrl('not a url')).toBeNull();
  });
});

describe('api urls', () => {
  it('builds github.com and GHES endpoints', () => {
    const gh = parsePullRequestUrl('https://github.com/acme/launcher/pull/142')!;
    expect(pullRequestApiUrl(gh)).toBe('https://api.github.com/repos/acme/launcher/pulls/142');
    expect(pullRequestReviewsApiUrl(gh as never)).toBe(
      'https://api.github.com/repos/acme/launcher/pulls/142/reviews?per_page=100'
    );
    const ghes = parsePullRequestUrl('https://ghe.corp.example/acme/launcher/pull/7')!;
    expect(pullRequestApiUrl(ghes)).toBe('https://ghe.corp.example/api/v3/repos/acme/launcher/pulls/7');
  });

  it('builds Azure DevOps endpoints for both host forms', () => {
    const ado = parsePullRequestUrl('https://dev.azure.com/myorg/My%20Project/_git/repo/pullrequest/55')!;
    expect(pullRequestApiUrl(ado)).toBe(
      'https://dev.azure.com/myorg/My%20Project/_apis/git/repositories/repo/pullRequests/55?api-version=7.1'
    );
    const legacy = parsePullRequestUrl('https://myorg.visualstudio.com/Proj/_git/repo/pullrequest/9')!;
    expect(pullRequestApiUrl(legacy)).toBe(
      'https://myorg.visualstudio.com/Proj/_apis/git/repositories/repo/pullRequests/9?api-version=7.1'
    );
  });
});

describe('normalization + transitions', () => {
  it('normalizes github states (closed splits on merged)', () => {
    expect(normalizeGithubPullRequest({ state: 'open', title: 't' })).toEqual({ state: 'OPEN', title: 't' });
    expect(normalizeGithubPullRequest({ state: 'closed', merged: true })).toEqual({ state: 'MERGED' });
    expect(normalizeGithubPullRequest({ state: 'closed', merged: false })).toEqual({ state: 'CLOSED' });
    expect(normalizeGithubPullRequest({})).toBeNull();
  });

  it('normalizes azure statuses', () => {
    expect(normalizeAzurePullRequest({ status: 'active' })).toEqual({ state: 'OPEN' });
    expect(normalizeAzurePullRequest({ status: 'completed', title: 't' })).toEqual({ state: 'MERGED', title: 't' });
    expect(normalizeAzurePullRequest({ status: 'abandoned' })).toEqual({ state: 'CLOSED' });
    expect(normalizeAzurePullRequest({ status: 'notSet' })).toBeNull();
  });

  it('only OPEN links transition, to merged or closed', () => {
    expect(pullRequestStateTransition('OPEN', { state: 'MERGED' })).toBe('merged');
    expect(pullRequestStateTransition('OPEN', { state: 'CLOSED' })).toBe('closed');
    expect(pullRequestStateTransition('OPEN', { state: 'OPEN' })).toBeNull();
    expect(pullRequestStateTransition('MERGED', { state: 'MERGED' })).toBeNull();
  });

  it('labels repos per provider', () => {
    expect(pullRequestRepoLabel(parsePullRequestUrl('https://github.com/a/b/pull/1')!)).toBe('a/b');
    expect(pullRequestRepoLabel(parsePullRequestUrl('https://dev.azure.com/o/p/_git/r/pullrequest/1')!)).toBe('p/r');
  });
});

describe('collectReviewEvents', () => {
  const reviews = [
    { user: { login: 'alice' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-10T10:00:00Z' },
    { user: { login: 'bob' }, state: 'APPROVED', submitted_at: '2026-08-11T10:00:00Z' },
    { user: { login: 'carol' }, state: 'COMMENTED', submitted_at: '2026-08-12T10:00:00Z' },
  ];
  const t = (iso: string): number => Date.parse(iso);

  it('first sight fires nothing but covers existing reviews with the watermark', () => {
    const { events, watermarkAt } = collectReviewEvents(reviews, undefined);
    expect(events).toEqual([]);
    expect(watermarkAt).toBe(t('2026-08-12T10:00:00Z'));
  });

  it('first sight of a review-less PR yields watermark 0 (cursor armed)', () => {
    expect(collectReviewEvents([], undefined)).toEqual({ events: [], watermarkAt: 0 });
  });

  it('fires verdict reviews newer than the watermark, oldest first', () => {
    const { events, watermarkAt } = collectReviewEvents(reviews, t('2026-08-09T00:00:00Z'));
    expect(events).toEqual([
      { kind: 'changes_requested', by: 'alice', at: t('2026-08-10T10:00:00Z') },
      { kind: 'approved', by: 'bob', at: t('2026-08-11T10:00:00Z') },
    ]);
    // COMMENTED advances the watermark without firing.
    expect(watermarkAt).toBe(t('2026-08-12T10:00:00Z'));
  });

  it('re-running against the advanced watermark is quiet', () => {
    const first = collectReviewEvents(reviews, t('2026-08-09T00:00:00Z'));
    const second = collectReviewEvents(reviews, first.watermarkAt);
    expect(second.events).toEqual([]);
    expect(second.watermarkAt).toBe(first.watermarkAt);
  });

  it('tolerates malformed bodies', () => {
    expect(collectReviewEvents({ not: 'an array' }, 5)).toEqual({ events: [], watermarkAt: 5 });
    expect(collectReviewEvents([{ state: 'APPROVED' }], 5)).toEqual({ events: [], watermarkAt: 5 });
  });
});

describe('check runs', () => {
  const run = (name: string, status: string, conclusion?: string): object => ({ name, status, conclusion });

  it('extracts the head sha from the github PR body', () => {
    expect(normalizeGithubPullRequest({ state: 'open', head: { sha: 'abc123' } })).toEqual({
      state: 'OPEN',
      headSha: 'abc123',
    });
  });

  it('builds the check-runs endpoint', () => {
    const ref = parsePullRequestUrl('https://github.com/acme/launcher/pull/142')!;
    expect(checkRunsApiUrl(ref as never, 'abc123')).toBe(
      'https://api.github.com/repos/acme/launcher/commits/abc123/check-runs?per_page=100'
    );
  });

  it('summarizes: any failing conclusion wins, else pending, else green', () => {
    expect(
      summarizeCheckRuns({ check_runs: [run('build', 'completed', 'success'), run('test', 'completed', 'failure')] })
    ).toEqual({ state: 'failing', failing: ['test'] });
    // Failing wins even while others still run (early signal).
    expect(
      summarizeCheckRuns({ check_runs: [run('build', 'in_progress'), run('test', 'completed', 'timed_out')] })
    ).toEqual({ state: 'failing', failing: ['test'] });
    expect(summarizeCheckRuns({ check_runs: [run('build', 'queued'), run('test', 'completed', 'success')] })).toEqual({
      state: 'pending',
      failing: [],
    });
    // skipped/neutral/cancelled don't block green.
    expect(
      summarizeCheckRuns({
        check_runs: [run('build', 'completed', 'success'), run('lint', 'completed', 'skipped')],
      })
    ).toEqual({ state: 'green', failing: [] });
  });

  it('returns null when the repo has no checks (CI events never fire)', () => {
    expect(summarizeCheckRuns({ check_runs: [] })).toBeNull();
    expect(summarizeCheckRuns({ total_count: 0 })).toBeNull();
    expect(summarizeCheckRuns('garbage')).toBeNull();
  });

  it('announces failures once per failing head commit', () => {
    const failing = { state: 'failing' as const, failing: ['test'] };
    // Fresh failure.
    expect(ciTransition({}, 'sha1', failing)).toEqual({ event: 'ci_failed', next: 'failing' });
    // Same commit, still failing → quiet.
    expect(ciTransition({ state: 'failing', sha: 'sha1' }, 'sha1', failing)).toEqual({
      event: null,
      next: 'failing',
    });
    // A push that fails again is news.
    expect(ciTransition({ state: 'failing', sha: 'sha1' }, 'sha2', failing)).toEqual({
      event: 'ci_failed',
      next: 'failing',
    });
  });

  it('announces green only as a recovery; pending never moves the cursor', () => {
    const green = { state: 'green' as const, failing: [] };
    expect(ciTransition({ state: 'failing', sha: 'sha1' }, 'sha2', green)).toEqual({
      event: 'ci_green',
      next: 'green',
    });
    expect(ciTransition({}, 'sha1', green)).toEqual({ event: null, next: 'green' });
    expect(ciTransition({ state: 'green', sha: 'sha1' }, 'sha2', green)).toEqual({ event: null, next: 'green' });
    expect(ciTransition({ state: 'failing', sha: 'sha1' }, 'sha1', { state: 'pending', failing: [] })).toEqual({
      event: null,
      next: null,
    });
  });
});

describe('pullRequestEventDetail', () => {
  const base = { url: 'https://github.com/a/b/pull/142', number: 142, repo: 'a/b', title: 'Fix the thing' };

  it('renders each kind as a delta the agent can act on', () => {
    expect(pullRequestEventDetail({ ...base, kind: 'merged' })).toBe(
      'your pull request #142 "Fix the thing" in a/b was merged'
    );
    expect(pullRequestEventDetail({ ...base, kind: 'closed' })).toBe(
      'your pull request #142 "Fix the thing" in a/b was closed without merging'
    );
    expect(pullRequestEventDetail({ ...base, kind: 'approved', by: 'bob' })).toBe(
      'bob approved your pull request #142 "Fix the thing" in a/b'
    );
    expect(pullRequestEventDetail({ ...base, kind: 'changes_requested', by: 'alice' })).toContain(
      'alice requested changes on your pull request #142 "Fix the thing" in a/b'
    );
    expect(pullRequestEventDetail({ ...base, kind: 'changes_requested', by: 'alice' })).toContain(
      'gh pr view 142 --comments'
    );
  });

  it('renders CI kinds with the failing check names and the checks command', () => {
    const failed = pullRequestEventDetail({ ...base, kind: 'ci_failed', checks: ['build', 'test'] });
    expect(failed).toContain('CI is failing on your pull request #142 "Fix the thing" in a/b (build, test)');
    expect(failed).toContain('gh pr checks 142');
    expect(pullRequestEventDetail({ ...base, kind: 'ci_green' })).toBe(
      'CI is green again on your pull request #142 "Fix the thing" in a/b'
    );
  });

  it('omits the quoted title when unknown', () => {
    expect(pullRequestEventDetail({ url: base.url, number: 142, repo: 'a/b', kind: 'merged' })).toBe(
      'your pull request #142 in a/b was merged'
    );
  });
});

describe('pullRequestSystemLine', () => {
  const base = { url: 'https://github.com/a/b/pull/142', number: 142, repo: 'a/b', title: 'Fix the thing' };

  it('renders compact team-visible rows for every kind', () => {
    expect(pullRequestSystemLine({ ...base, kind: 'merged' })).toBe('PR #142 "Fix the thing" (a/b) was merged');
    expect(pullRequestSystemLine({ ...base, kind: 'closed' })).toBe(
      'PR #142 "Fix the thing" (a/b) was closed without merging'
    );
    expect(pullRequestSystemLine({ ...base, kind: 'approved', by: 'bob' })).toBe(
      'bob approved PR #142 "Fix the thing" (a/b)'
    );
    expect(pullRequestSystemLine({ ...base, kind: 'changes_requested', by: 'alice' })).toBe(
      'alice requested changes on PR #142 "Fix the thing" (a/b)'
    );
    expect(pullRequestSystemLine({ ...base, kind: 'ci_failed', checks: ['test'] })).toBe(
      'CI is failing on PR #142 "Fix the thing" (a/b) (test)'
    );
    expect(pullRequestSystemLine({ ...base, kind: 'ci_green' })).toBe(
      'CI is green again on PR #142 "Fix the thing" (a/b)'
    );
  });
});
