import { describe, expect, it } from 'vitest';

import {
  isAzureDevOpsHost,
  isGitHubHost,
  parseAzurePullRequestList,
  parseAzurePullRequestListAll,
  parsePullRequestJson,
  parsePullRequestListJson,
  parseRemoteHost,
} from './container-pull-request';

describe('parsePullRequestJson', () => {
  it('parses an open PR with all fields', () => {
    const out = JSON.stringify({
      number: 42,
      url: 'https://github.com/acme/repo/pull/42',
      state: 'OPEN',
      title: 'Ship source details',
    });
    expect(parsePullRequestJson(out)).toEqual({
      number: 42,
      url: 'https://github.com/acme/repo/pull/42',
      state: 'OPEN',
      title: 'Ship source details',
    });
  });

  it('returns null for a closed PR', () => {
    const out = JSON.stringify({ number: 7, url: 'https://x/pull/7', state: 'CLOSED' });
    expect(parsePullRequestJson(out)).toBeNull();
  });

  it('returns null for a merged PR', () => {
    const out = JSON.stringify({ number: 7, url: 'https://x/pull/7', state: 'MERGED' });
    expect(parsePullRequestJson(out)).toBeNull();
  });

  it('returns null when the number is missing', () => {
    const out = JSON.stringify({ url: 'https://x/pull/7', state: 'OPEN' });
    expect(parsePullRequestJson(out)).toBeNull();
  });

  it('returns null when the url is missing', () => {
    const out = JSON.stringify({ number: 7, state: 'OPEN' });
    expect(parsePullRequestJson(out)).toBeNull();
  });

  it('returns null on empty / non-JSON output (gh found no PR)', () => {
    expect(parsePullRequestJson('')).toBeNull();
    expect(parsePullRequestJson('no pull requests found')).toBeNull();
  });
});

describe('parseRemoteHost', () => {
  it('parses https remotes', () => {
    expect(parseRemoteHost('https://github.com/acme/repo.git')).toBe('github.com');
    expect(parseRemoteHost('https://dev.azure.com/org/proj/_git/repo')).toBe('dev.azure.com');
    expect(parseRemoteHost('https://acme@dev.azure.com/acme/proj/_git/repo')).toBe('dev.azure.com');
  });

  it('parses scp-like SSH remotes', () => {
    expect(parseRemoteHost('git@github.com:acme/repo.git')).toBe('github.com');
    expect(parseRemoteHost('git@ssh.dev.azure.com:v3/org/proj/repo')).toBe('ssh.dev.azure.com');
  });

  it('parses ssh:// remotes', () => {
    expect(parseRemoteHost('ssh://git@github.com/acme/repo.git')).toBe('github.com');
  });

  it('returns null for empty input', () => {
    expect(parseRemoteHost('')).toBeNull();
    expect(parseRemoteHost('   ')).toBeNull();
  });
});

describe('host classification', () => {
  it('recognizes GitHub hosts', () => {
    expect(isGitHubHost('github.com')).toBe(true);
    expect(isGitHubHost('dev.azure.com')).toBe(false);
  });

  it('recognizes Azure DevOps hosts', () => {
    expect(isAzureDevOpsHost('dev.azure.com')).toBe(true);
    expect(isAzureDevOpsHost('acme.visualstudio.com')).toBe(true);
    expect(isAzureDevOpsHost('ssh.dev.azure.com')).toBe(true);
    expect(isAzureDevOpsHost('github.com')).toBe(false);
  });
});

describe('parseAzurePullRequestList', () => {
  it('builds a browser URL from repository.webUrl for the first active PR', () => {
    const out = JSON.stringify([
      {
        pullRequestId: 123,
        status: 'active',
        repository: { webUrl: 'https://dev.azure.com/org/proj/_git/repo' },
      },
    ]);
    expect(parseAzurePullRequestList(out)).toEqual({
      number: 123,
      url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/123',
      state: 'OPEN',
    });
  });

  it('skips non-active PRs', () => {
    const out = JSON.stringify([
      { pullRequestId: 9, status: 'completed', repository: { webUrl: 'https://x/_git/r' } },
      { pullRequestId: 10, status: 'abandoned', repository: { webUrl: 'https://x/_git/r' } },
    ]);
    expect(parseAzurePullRequestList(out)).toBeNull();
  });

  it('returns null when repository.webUrl is missing', () => {
    const out = JSON.stringify([{ pullRequestId: 9, status: 'active' }]);
    expect(parseAzurePullRequestList(out)).toBeNull();
  });

  it('returns null on an empty list or non-JSON', () => {
    expect(parseAzurePullRequestList('[]')).toBeNull();
    expect(parseAzurePullRequestList('')).toBeNull();
  });
});

describe('parsePullRequestListJson (GitHub, all open PRs)', () => {
  it('returns every open PR in the array', () => {
    const out = JSON.stringify([
      { number: 1, url: 'https://x/pull/1', state: 'OPEN', title: 'One' },
      { number: 2, url: 'https://x/pull/2', state: 'CLOSED' },
      { number: 3, url: 'https://x/pull/3', state: 'OPEN' },
    ]);
    expect(parsePullRequestListJson(out)).toEqual([
      { number: 1, url: 'https://x/pull/1', state: 'OPEN', title: 'One' },
      { number: 3, url: 'https://x/pull/3', state: 'OPEN' },
    ]);
  });

  it('returns [] on empty list or non-JSON', () => {
    expect(parsePullRequestListJson('[]')).toEqual([]);
    expect(parsePullRequestListJson('')).toEqual([]);
  });
});

describe('parseAzurePullRequestListAll (all active PRs)', () => {
  it('returns a badge per active PR (e.g. one branch → two targets)', () => {
    const out = JSON.stringify([
      { pullRequestId: 11, status: 'active', repository: { webUrl: 'https://dev.azure.com/o/p/_git/r' } },
      { pullRequestId: 12, status: 'completed', repository: { webUrl: 'https://dev.azure.com/o/p/_git/r' } },
      { pullRequestId: 13, status: 'active', repository: { webUrl: 'https://dev.azure.com/o/p/_git/r' } },
    ]);
    expect(parseAzurePullRequestListAll(out)).toEqual([
      { number: 11, url: 'https://dev.azure.com/o/p/_git/r/pullrequest/11', state: 'OPEN' },
      { number: 13, url: 'https://dev.azure.com/o/p/_git/r/pullrequest/13', state: 'OPEN' },
    ]);
  });

  it('parseAzurePullRequestList returns just the first of them', () => {
    const out = JSON.stringify([
      { pullRequestId: 11, status: 'active', repository: { webUrl: 'https://x/_git/r' } },
      { pullRequestId: 13, status: 'active', repository: { webUrl: 'https://x/_git/r' } },
    ]);
    expect(parseAzurePullRequestList(out)).toEqual({
      number: 11,
      url: 'https://x/_git/r/pullrequest/11',
      state: 'OPEN',
    });
  });
});
