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

  it('returns null for a closed (unmerged) PR', () => {
    const out = JSON.stringify({ number: 7, url: 'https://x/pull/7', state: 'CLOSED' });
    expect(parsePullRequestJson(out)).toBeNull();
  });

  it('passes a merged PR through (renders as the ✓ badge)', () => {
    const out = JSON.stringify({ number: 7, url: 'https://x/pull/7', state: 'MERGED' });
    expect(parsePullRequestJson(out)).toEqual({ number: 7, url: 'https://x/pull/7', state: 'MERGED' });
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

  it('maps completed → MERGED and skips abandoned PRs', () => {
    const out = JSON.stringify([
      { pullRequestId: 9, status: 'completed', repository: { webUrl: 'https://x/_git/r' } },
      { pullRequestId: 10, status: 'abandoned', repository: { webUrl: 'https://x/_git/r' } },
    ]);
    expect(parseAzurePullRequestList(out)).toEqual({
      number: 9,
      url: 'https://x/_git/r/pullrequest/9',
      state: 'MERGED',
    });
  });

  it('composes the URL from REST url + names when webUrl is null (the `pr list` shape)', () => {
    // `az repos pr list` returns a slim repository reference: webUrl is null,
    // and the REST url carries the project GUID between org and /_apis/.
    // Mirrors a real dev.azure.com response.
    const out = JSON.stringify([
      {
        pullRequestId: 823,
        status: 'active',
        title: 'Update SOM strategic planning landing copy',
        repository: {
          id: '403c51fc-72e9-46c1-aed6-784b7228f2e2',
          name: 'SOM-FacultyPortal',
          url: 'https://dev.azure.com/UTRGVSom/9833695e-5020-4b48-9da8-5e0fa0f76fb1/_apis/git/repositories/403c51fc-72e9-46c1-aed6-784b7228f2e2',
          webUrl: null,
          project: { name: 'SOM-FacultyPortal' },
        },
      },
    ]);
    expect(parseAzurePullRequestList(out)).toEqual({
      number: 823,
      url: 'https://dev.azure.com/UTRGVSom/SOM-FacultyPortal/_git/SOM-FacultyPortal/pullrequest/823',
      state: 'OPEN',
      title: 'Update SOM strategic planning landing copy',
    });
  });

  it('composes the URL for legacy visualstudio.com REST urls (no project GUID segment)', () => {
    const out = JSON.stringify([
      {
        pullRequestId: 7,
        status: 'active',
        repository: {
          name: 'repo',
          url: 'https://acme.visualstudio.com/_apis/git/repositories/403c51fc-72e9-46c1-aed6-784b7228f2e2',
          project: { name: 'My Project' },
        },
      },
    ]);
    expect(parseAzurePullRequestList(out)).toEqual({
      number: 7,
      url: 'https://acme.visualstudio.com/My%20Project/_git/repo/pullrequest/7',
      state: 'OPEN',
    });
  });

  it('returns null when neither webUrl nor REST url + names are usable', () => {
    const out = JSON.stringify([{ pullRequestId: 9, status: 'active' }]);
    expect(parseAzurePullRequestList(out)).toBeNull();
    const noNames = JSON.stringify([
      {
        pullRequestId: 9,
        status: 'active',
        repository: { url: 'https://dev.azure.com/o/_apis/git/repositories/x' },
      },
    ]);
    expect(parseAzurePullRequestList(noNames)).toBeNull();
  });

  it('returns null on an empty list or non-JSON', () => {
    expect(parseAzurePullRequestList('[]')).toBeNull();
    expect(parseAzurePullRequestList('')).toBeNull();
  });
});

describe('parsePullRequestListJson (GitHub, open + merged PRs)', () => {
  it('returns open and merged PRs, dropping closed-unmerged ones', () => {
    const out = JSON.stringify([
      { number: 1, url: 'https://x/pull/1', state: 'OPEN', title: 'One' },
      { number: 2, url: 'https://x/pull/2', state: 'CLOSED' },
      { number: 3, url: 'https://x/pull/3', state: 'MERGED' },
    ]);
    expect(parsePullRequestListJson(out)).toEqual([
      { number: 1, url: 'https://x/pull/1', state: 'OPEN', title: 'One' },
      { number: 3, url: 'https://x/pull/3', state: 'MERGED' },
    ]);
  });

  it('returns [] on empty list or non-JSON', () => {
    expect(parsePullRequestListJson('[]')).toEqual([]);
    expect(parsePullRequestListJson('')).toEqual([]);
  });
});

describe('parseAzurePullRequestListAll (active + completed PRs)', () => {
  it('returns a badge per surviving PR, normalizing completed → MERGED', () => {
    const out = JSON.stringify([
      { pullRequestId: 11, status: 'active', repository: { webUrl: 'https://dev.azure.com/o/p/_git/r' } },
      { pullRequestId: 12, status: 'completed', repository: { webUrl: 'https://dev.azure.com/o/p/_git/r' } },
      { pullRequestId: 13, status: 'abandoned', repository: { webUrl: 'https://dev.azure.com/o/p/_git/r' } },
    ]);
    expect(parseAzurePullRequestListAll(out)).toEqual([
      { number: 11, url: 'https://dev.azure.com/o/p/_git/r/pullrequest/11', state: 'OPEN' },
      { number: 12, url: 'https://dev.azure.com/o/p/_git/r/pullrequest/12', state: 'MERGED' },
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
