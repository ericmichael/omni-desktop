/**
 * Tests for project-source.ts — type guards and extraction helpers.
 */
import { describe, expect, it } from 'vitest';

import {
  findDuplicateSourceIdentity,
  getLocalWorkspaceDir,
  hasRepo,
  isLocalSource,
  normalizeGitRemoteUrl,
  normalizeLocalSourcePath,
  requireLocalWorkspaceDir,
  sourceIdentityKey,
  validateProjectSources,
} from '@/shared/project-source';
import type { Project, ProjectSource } from '@/shared/types';

const localSource: ProjectSource = { id: 'local', mountName: 'my-app', kind: 'local', workspaceDir: '/home/user/projects/my-app' };
const gitSource: ProjectSource = { id: 'git', mountName: 'repo', kind: 'git-remote', repoUrl: 'https://github.com/org/repo.git' };

describe('getLocalWorkspaceDir', () => {
  it('returns workspaceDir for local source', () => {
    expect(getLocalWorkspaceDir(localSource)).toBe('/home/user/projects/my-app');
  });

  it('returns undefined for git-remote source', () => {
    expect(getLocalWorkspaceDir(gitSource)).toBeUndefined();
  });

  it('returns undefined for undefined source', () => {
    expect(getLocalWorkspaceDir(undefined)).toBeUndefined();
  });
});

describe('requireLocalWorkspaceDir', () => {
  it('returns workspaceDir for local source', () => {
    expect(requireLocalWorkspaceDir(localSource)).toBe('/home/user/projects/my-app');
  });

  it('throws for git-remote source', () => {
    expect(() => requireLocalWorkspaceDir(gitSource)).toThrow('requires a local project source');
  });

  it('throws for undefined source', () => {
    expect(() => requireLocalWorkspaceDir(undefined)).toThrow('requires a local project source');
  });
});

describe('isLocalSource', () => {
  it('returns true for local source', () => {
    expect(isLocalSource(localSource)).toBe(true);
  });

  it('returns false for git-remote source', () => {
    expect(isLocalSource(gitSource)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isLocalSource(undefined)).toBe(false);
  });
});

describe('hasRepo', () => {
  it('returns true when project has a source', () => {
    const project = { sources: [localSource] } as Project;
    expect(hasRepo(project)).toBe(true);
  });

  it('returns false when project has no source', () => {
    const project = { sources: [] } as unknown as Project;
    expect(hasRepo(project)).toBe(false);
  });

  it('returns false when source is null', () => {
    const project = { sources: [] } as unknown as Project;
    expect(hasRepo(project)).toBe(false);
  });
});

describe('source identity', () => {
  it('normalizes local paths by trimming separators and Windows casing', () => {
    expect(normalizeLocalSourcePath(' C:\\Users\\Me\\Repo\\ ')).toBe('c:/users/me/repo');
    expect(normalizeLocalSourcePath('/Users/Me/Repo///')).toBe('/Users/Me/Repo');
  });

  it('normalizes common Git URL spellings to the same identity', () => {
    expect(normalizeGitRemoteUrl('https://github.com/Owner/Repo.git/')).toBe('github.com/owner/repo');
    expect(normalizeGitRemoteUrl('git@github.com:owner/repo.git')).toBe('github.com/owner/repo');
    expect(sourceIdentityKey({ id: 's1', mountName: 'repo', kind: 'git-remote', repoUrl: 'ssh://git@github.com/owner/repo.git' })).toBe(
      'git-remote:github.com/owner/repo'
    );
  });

  it('detects duplicate local source identities with different mount names', () => {
    const duplicate = findDuplicateSourceIdentity([
      { id: 's1', mountName: 'repo', kind: 'local', workspaceDir: '/tmp/repo' },
      { id: 's2', mountName: 'repo-copy', kind: 'local', workspaceDir: '/tmp/repo/' },
    ]);
    expect(duplicate?.id).toBe('s2');
  });

  it('validates mount names and source identities independently', () => {
    expect(() =>
      validateProjectSources([
        { id: 's1', mountName: 'repo', kind: 'git-remote', repoUrl: 'https://github.com/owner/repo.git' },
        { id: 's2', mountName: 'repo-copy', kind: 'git-remote', repoUrl: 'git@github.com:owner/repo.git' },
      ])
    ).toThrow('already includes that repository');
    expect(() =>
      validateProjectSources([
        { id: 's1', mountName: 'repo', kind: 'local', workspaceDir: '/tmp/repo-a' },
        { id: 's2', mountName: 'repo', kind: 'local', workspaceDir: '/tmp/repo-b' },
      ])
    ).toThrow('Duplicate mount name');
  });
});
