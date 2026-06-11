import { describe, expect, it } from 'vitest';

import {
  defaultUsernameForHost,
  gitHostFromUrl,
  isSshRemote,
  resolveCredentialForUrl,
  tokenLast4,
} from '@/shared/git-credentials';
import type { GitCredential } from '@/shared/types';

const cred = (host: string): GitCredential => ({
  id: host,
  host,
  username: 'x-access-token',
  last4: 'abcd',
  createdAt: 0,
});

describe('gitHostFromUrl', () => {
  it('parses HTTPS remotes', () => {
    expect(gitHostFromUrl('https://github.com/owner/repo')).toBe('github.com');
    expect(gitHostFromUrl('https://github.com/owner/repo.git')).toBe('github.com');
    expect(gitHostFromUrl('https://gitlab.example.org/group/sub/repo')).toBe('gitlab.example.org');
  });

  it('parses SCP-style SSH remotes', () => {
    expect(gitHostFromUrl('git@github.com:owner/repo.git')).toBe('github.com');
    expect(gitHostFromUrl('git@gitlab.example.org:group/repo')).toBe('gitlab.example.org');
  });

  it('lowercases the host', () => {
    expect(gitHostFromUrl('https://GitHub.com/owner/repo')).toBe('github.com');
  });

  it('returns undefined for unparseable input', () => {
    expect(gitHostFromUrl('')).toBeUndefined();
    expect(gitHostFromUrl('   ')).toBeUndefined();
    expect(gitHostFromUrl('not a url')).toBeUndefined();
  });
});

describe('isSshRemote', () => {
  it('detects SCP and ssh:// forms', () => {
    expect(isSshRemote('git@github.com:owner/repo.git')).toBe(true);
    expect(isSshRemote('ssh://git@github.com/owner/repo')).toBe(true);
  });

  it('does not flag HTTPS remotes', () => {
    expect(isSshRemote('https://github.com/owner/repo')).toBe(false);
    expect(isSshRemote('http://github.com/owner/repo')).toBe(false);
  });
});

describe('resolveCredentialForUrl', () => {
  const creds = [cred('github.com'), cred('gitlab.example.org')];

  it('matches by host', () => {
    expect(resolveCredentialForUrl(creds, 'https://github.com/owner/repo')?.host).toBe('github.com');
    expect(resolveCredentialForUrl(creds, 'git@gitlab.example.org:group/repo')?.host).toBe('gitlab.example.org');
  });

  it('returns undefined when no host matches', () => {
    expect(resolveCredentialForUrl(creds, 'https://bitbucket.org/owner/repo')).toBeUndefined();
    expect(resolveCredentialForUrl(creds, 'garbage')).toBeUndefined();
  });
});

describe('defaultUsernameForHost', () => {
  it('maps known hosts to their token usernames', () => {
    expect(defaultUsernameForHost('github.com')).toBe('x-access-token');
    expect(defaultUsernameForHost('gitlab.example.org')).toBe('oauth2');
    expect(defaultUsernameForHost('bitbucket.org')).toBe('x-token-auth');
    expect(defaultUsernameForHost('git.internal.corp')).toBe('git');
  });
});

describe('tokenLast4', () => {
  it('returns the last 4 chars', () => {
    expect(tokenLast4('ghp_abcdef1234')).toBe('1234');
    expect(tokenLast4('xy')).toBe('xy');
  });
});
