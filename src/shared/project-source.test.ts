/**
 * Tests for project-source.ts — type guards and extraction helpers.
 */
import { describe, expect, it } from 'vitest';

import { getLocalWorkspaceDir, hasRepo, isLocalSource, requireLocalWorkspaceDir } from '@/shared/project-source';
import type { Project, ProjectSource } from '@/shared/types';

const localSource: ProjectSource = { kind: 'local', workspaceDir: '/home/user/projects/my-app' };
const gitSource: ProjectSource = { kind: 'git-remote', repoUrl: 'https://github.com/org/repo.git' };

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
    const project = { source: localSource } as Project;
    expect(hasRepo(project)).toBe(true);
  });

  it('returns false when project has no source', () => {
    const project = { source: undefined } as unknown as Project;
    expect(hasRepo(project)).toBe(false);
  });

  it('returns false when source is null', () => {
    const project = { source: null } as unknown as Project;
    expect(hasRepo(project)).toBe(false);
  });
});
