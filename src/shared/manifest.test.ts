/**
 * Type-only smoke test for the manifest types. The point is to prove
 * that the three representative launcher project shapes — chat-only,
 * local-workspace, git-remote — fit the type system without any
 * `as any` escapes. If any of these stop compiling, the types regressed.
 */
import { describe, expect, it } from 'vitest';

import type {
  Capability,
  Manifest,
  ManifestEntry,
  McpServerConfig,
  ProjectConfig,
  RuntimeConfig,
} from './manifest';
import { DEFAULT_CAPABILITIES, EMPTY_MANIFEST } from './manifest';

describe('manifest types', () => {
  it('chat-only / Personal project', () => {
    const config: ProjectConfig = {
      manifest: EMPTY_MANIFEST,
      capabilities: [
        { type: 'filesystem' },
        { type: 'shell' },
        {
          type: 'skills',
          skills_path: '.agents',
          lazy_from: { source: { type: 'local_dir', src: '~/.config/omni_code/skills' } },
        },
      ],
      runtime: { client: 'docker', options: { image: 'omni-sandbox:latest' } },
      mcp_servers: [
        {
          type: 'stdio',
          name: 'omni-projects',
          command: 'node',
          args: ['/.../packages/projects-mcp/dist/cli.js'],
          env: { OMNI_PROJECT_ID: 'proj_personal' },
        },
      ],
    };
    expect(config.manifest.entries).toEqual({});
  });

  it('local-workspace project (existing git repo on disk)', () => {
    const config: ProjectConfig = {
      manifest: {
        root: '/workspace',
        entries: {
          '.': {
            type: 'local_dir',
            src: '/home/eric/repos/myapi',
            writable: true,
          },
          'README.md': {
            type: 'local_file',
            src: '/home/eric/repos/myapi/README.md',
            optional: true,
          },
        },
        environment: {
          value: {
            OMNI_PROJECT_ID: 'proj_abc123',
            OPENAI_API_KEY: { type: 'omni_keychain', key: 'openai' },
          },
        },
        users: [{ name: 'agent' }],
      },
      capabilities: [
        ...DEFAULT_CAPABILITIES,
        {
          type: 'skills',
          lazy_from: { source: { type: 'local_dir', src: '~/.config/omni_code/skills' } },
        },
      ],
      runtime: {
        client: 'docker',
        options: { image: 'omni-sandbox:latest', exposed_ports: [9000] },
      },
      run_as: 'agent',
    };
    const root = config.manifest.entries?.['.'];
    expect(root?.type).toBe('local_dir');
  });

  it('git-remote project', () => {
    const config: ProjectConfig = {
      manifest: {
        root: '/workspace',
        entries: {
          '.': {
            type: 'git_repo',
            host: 'github.com',
            repo: 'openai/openai-python',
            ref: 'main',
          },
        },
      },
      capabilities: DEFAULT_CAPABILITIES,
      runtime: { client: 'docker', options: { image: 'omni-sandbox:latest' } },
    };
    const root = config.manifest.entries?.['.'];
    expect(root?.type).toBe('git_repo');
  });

  it('discriminated unions narrow correctly', () => {
    const entries: ManifestEntry[] = [
      { type: 'file', content: 'hello' },
      { type: 'local_dir', src: '/x' },
      { type: 'git_repo', host: 'github.com', repo: 'a/b' },
    ];
    for (const e of entries) {
      switch (e.type) {
        case 'file':
          expect(e.content).toBe('hello');
          break;
        case 'local_dir':
          expect(e.src).toBe('/x');
          break;
        case 'git_repo':
          expect(e.repo).toBe('a/b');
          break;
        default:
          // Don't require exhaustiveness — MountEntry shares a generic type
          // discriminator across cloud providers, so the union has more
          // members than we hand-code here.
          break;
      }
    }
  });

  it('runtime config narrows by client', () => {
    const docker: RuntimeConfig = {
      client: 'docker',
      options: { image: 'omni:latest' },
    };
    if (docker.client === 'docker') {
      expect(docker.options.image).toBe('omni:latest');
    }

    const local: RuntimeConfig = { client: 'unix_local' };
    if (local.client === 'unix_local') {
      // options is optional for unix_local
      expect(local.options).toBeUndefined();
    }
  });

  it('mcp server config covers all three transports', () => {
    const servers: McpServerConfig[] = [
      { type: 'stdio', name: 'a', command: 'node', args: ['cli.js'] },
      { type: 'sse', name: 'b', url: 'https://example/sse' },
      { type: 'streamable_http', name: 'c', url: 'https://example/http' },
    ];
    expect(servers).toHaveLength(3);
  });

  it('capability union narrows', () => {
    const caps: Capability[] = [
      { type: 'filesystem' },
      { type: 'shell' },
      { type: 'compaction', policy: { type: 'dynamic', target_pct: 0.7 } },
      { type: 'compaction', policy: { type: 'static', threshold: 240_000 } },
      { type: 'skills' },
      { type: 'memory' },
    ];
    expect(caps).toHaveLength(6);
  });

  it('manifest is fully optional', () => {
    // Manifest with nothing in it should compile — represents the SDK default.
    const m: Manifest = {};
    expect(m.root).toBeUndefined();
  });
});
