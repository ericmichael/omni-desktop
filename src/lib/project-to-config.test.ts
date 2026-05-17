/**
 * Pin the legacy `Project` → `ProjectConfig` mapping for the project
 * shapes the launcher actually has in production.
 */
import { describe, expect, it } from 'vitest';

import type { ProjectConfigDefaults } from '@/lib/project-to-config';
import { parseGitRepoUrl, projectToConfig } from '@/lib/project-to-config';
import type { Project, ProjectId } from '@/shared/types';

const DEFAULTS: ProjectConfigDefaults = {
  skillsDir: '/home/test/.config/omni_code/skills',
  projectsMcpCliPath: '/opt/omni/packages/projects-mcp/dist/cli.js',
  defaultDockerImage: 'omni-sandbox:latest',
};

function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj_abc' as ProjectId,
    label: 'Test',
    slug: 'test',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('parseGitRepoUrl', () => {
  it('handles HTTPS with .git suffix', () => {
    expect(parseGitRepoUrl('https://github.com/openai/openai-python.git')).toEqual({
      host: 'github.com',
      repo: 'openai/openai-python',
    });
  });

  it('handles HTTPS without .git suffix', () => {
    expect(parseGitRepoUrl('https://github.com/openai/openai-python')).toEqual({
      host: 'github.com',
      repo: 'openai/openai-python',
    });
  });

  it('handles SSH short form', () => {
    expect(parseGitRepoUrl('git@github.com:openai/openai-python.git')).toEqual({
      host: 'github.com',
      repo: 'openai/openai-python',
    });
  });

  it('handles ssh:// protocol', () => {
    expect(parseGitRepoUrl('ssh://git@github.com/openai/openai-python.git')).toEqual({
      host: 'github.com',
      repo: 'openai/openai-python',
    });
  });

  it('handles nested repo paths (gitlab subgroups)', () => {
    expect(parseGitRepoUrl('https://gitlab.com/group/subgroup/repo.git')).toEqual({
      host: 'gitlab.com',
      repo: 'group/subgroup/repo',
    });
  });

  it('returns null for empty input', () => {
    expect(parseGitRepoUrl('')).toBeNull();
    expect(parseGitRepoUrl('   ')).toBeNull();
  });

  it('returns null for shapes we do not recognize', () => {
    expect(parseGitRepoUrl('not a url')).toBeNull();
  });
});

describe('projectToConfig', () => {
  it('chat-only / Personal project — empty manifest entries', () => {
    const project = baseProject({ isPersonal: true, label: 'Personal', slug: 'personal' });
    const config = projectToConfig(project, DEFAULTS);

    expect(config.manifest.entries).toEqual({});
    expect(config.manifest.root).toBe('/workspace');
    expect(config.manifest.environment?.value['OMNI_PROJECT_ID']).toEqual({
      type: 'literal',
      value: 'proj_abc',
    });
  });

  it('local-workspace project — local_dir entry at "."', () => {
    const project = baseProject({
      source: { kind: 'local', workspaceDir: '/home/eric/repos/myapi', gitDetected: true },
    });
    const config = projectToConfig(project, DEFAULTS);

    expect(config.manifest.entries?.['.']).toEqual({
      type: 'local_dir',
      src: '/home/eric/repos/myapi',
      writable: true,
    });
  });

  it('git-remote project — git_repo entry with parsed host/repo and ref', () => {
    const project = baseProject({
      source: {
        kind: 'git-remote',
        repoUrl: 'https://github.com/anthropics/launcher.git',
        defaultBranch: 'main',
      },
    });
    const config = projectToConfig(project, DEFAULTS);

    expect(config.manifest.entries?.['.']).toEqual({
      type: 'git_repo',
      host: 'github.com',
      repo: 'anthropics/launcher',
      ref: 'main',
    });
  });

  it('git-remote project without defaultBranch — omits ref', () => {
    const project = baseProject({
      source: { kind: 'git-remote', repoUrl: 'https://github.com/a/b' },
    });
    const config = projectToConfig(project, DEFAULTS);

    const entry = config.manifest.entries?.['.'];
    expect(entry?.type).toBe('git_repo');
    expect(entry && 'ref' in entry ? entry.ref : 'missing').toBe('missing');
  });

  it('git-remote project with unparseable URL — falls back to empty entries', () => {
    const project = baseProject({
      source: { kind: 'git-remote', repoUrl: 'not-actually-a-url' },
    });
    const config = projectToConfig(project, DEFAULTS);

    expect(config.manifest.entries).toEqual({});
  });

  it('runtime always uses defaultDockerImage — project-level image overrides moved to sandbox profiles in v22', () => {
    const project = baseProject();
    const config = projectToConfig(project, DEFAULTS);

    expect(config.runtime).toEqual({
      client: 'docker',
      options: { image: 'omni-sandbox:latest' },
    });
  });

  it('mcp_servers always includes omni-projects scoped to this project id', () => {
    const project = baseProject({ id: 'proj_xyz' as ProjectId });
    const config = projectToConfig(project, DEFAULTS);

    expect(config.mcp_servers).toHaveLength(1);
    const omni = config.mcp_servers![0]!;
    expect(omni).toEqual({
      type: 'stdio',
      name: 'omni-projects',
      command: 'node',
      args: ['/opt/omni/packages/projects-mcp/dist/cli.js'],
      env: { OMNI_PROJECT_ID: 'proj_xyz' },
    });
  });

  it('extraMcpServers are appended after omni-projects', () => {
    const project = baseProject();
    const config = projectToConfig(project, {
      ...DEFAULTS,
      extraMcpServers: [
        { type: 'sse', name: 'github', url: 'https://example/sse' },
      ],
    });

    expect(config.mcp_servers).toHaveLength(2);
    expect(config.mcp_servers![1]).toEqual({
      type: 'sse',
      name: 'github',
      url: 'https://example/sse',
    });
  });

  it('default capabilities — filesystem, shell, skills, compaction', () => {
    const project = baseProject();
    const config = projectToConfig(project, DEFAULTS);

    expect(config.capabilities.map((c) => c.type)).toEqual([
      'filesystem',
      'shell',
      'skills',
      'compaction',
    ]);
  });

  it('skills capability wires the configured skills dir', () => {
    const project = baseProject();
    const config = projectToConfig(project, DEFAULTS);

    const skills = config.capabilities.find((c) => c.type === 'skills');
    expect(skills && skills.type === 'skills' ? skills.lazy_from?.source : null).toEqual({
      type: 'local_dir',
      src: '/home/test/.config/omni_code/skills',
    });
  });

  it('workspaceRoot default override propagates to manifest.root', () => {
    const project = baseProject();
    const config = projectToConfig(project, { ...DEFAULTS, workspaceRoot: '/agent' });

    expect(config.manifest.root).toBe('/agent');
  });

  it('round-trips a representative real project shape', () => {
    // Validates that all fields on a fully-populated Project map without
    // throwing. Fields not represented in ProjectConfig (autoDispatch,
    // pipeline, seedKey, slug, isPersonal) silently stay in the DB row.
    const project = baseProject({
      id: 'proj_full' as ProjectId,
      label: 'API Refactor',
      slug: 'api-refactor',
      isPersonal: false,
      source: {
        kind: 'local',
        workspaceDir: '/home/eric/repos/myapi',
        gitDetected: true,
      },
      autoDispatch: true,
      pipeline: { columns: [{ id: 'backlog', label: 'Backlog' }] },
    });
    const config = projectToConfig(project, DEFAULTS);

    expect(config.manifest.entries?.['.']).toMatchObject({ type: 'local_dir' });
    expect(config.runtime).toMatchObject({ options: { image: 'omni-sandbox:latest' } });
    const omni = config.mcp_servers?.[0];
    expect(omni?.type).toBe('stdio');
    if (omni?.type === 'stdio') {
      expect(omni.env?.['OMNI_PROJECT_ID']).toBe('proj_full');
    }
    expect(config.capabilities).toHaveLength(4);
  });
});
