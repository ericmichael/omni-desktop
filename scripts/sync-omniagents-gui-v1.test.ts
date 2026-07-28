import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const script = resolve(root, 'scripts/sync-omniagents-gui-v1.mjs');
const artifact = resolve(root, 'src/generated/omniagents-gui-v1/gui-v1.ts');
const provenance = resolve(root, 'src/generated/omniagents-gui-v1/provenance.json');

const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const git = (directory: string, ...args: string[]) => {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

const canonicalBytes = (value: unknown): Buffer => {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(sort);
    }
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, sort((input as Record<string, unknown>)[key])])
      );
    }
    return input;
  };
  return Buffer.from(`${JSON.stringify(sort(value), null, 2)}\n`);
};

const sha256 = async (...values: Buffer[]) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(Buffer.concat(values)).digest('hex');
};

const sourceFixture = async (prefix = 'omni-source-') => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const output = join(directory, 'desktop');
  const sourceArtifactPath = 'omniagents/backends/web/ui/src/protocol/generated/gui-v1.ts';
  const sourceManifestPath = 'protocol/openrpc/manifest.json';
  const openRpc = { info: { version: '1.0.0' }, methods: [] };
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: {} };
  const sourceArtifact = await readFile(artifact);
  const canonical = await sha256(canonicalBytes(openRpc), canonicalBytes(schema));
  const manifest = {
    protocol_version: '1.0.0',
    canonical_sha256: canonical,
    generator: 'scripts.protocol.generate_gui_protocol',
    generator_version: '1',
    toolchain: { fixture: '1' },
  };
  await mkdir(join(directory, 'omniagents/backends/web/ui/src/protocol/generated'), { recursive: true });
  await mkdir(join(directory, 'protocol/openrpc/schemas'), { recursive: true });
  await writeFile(join(directory, sourceArtifactPath), sourceArtifact);
  await writeFile(join(directory, sourceManifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, 'protocol/openrpc/omniagents-gui-v1.json'), canonicalBytes(openRpc));
  await writeFile(join(directory, 'protocol/openrpc/schemas/gui-v1.schema.json'), canonicalBytes(schema));
  git(directory, 'init');
  git(directory, 'config', 'user.email', 'fixture@example.com');
  git(directory, 'config', 'user.name', 'Fixture');
  git(directory, 'remote', 'add', 'origin', 'https://github.com/utrgv-software-engineering/omniagents.git');
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', 'fixture');
  const commit = git(directory, 'rev-parse', 'HEAD');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'gui-v1.ts'), sourceArtifact);
  await writeFile(
    join(output, 'provenance.json'),
    `${JSON.stringify(
      {
        ...manifest,
        generated_typescript_sha256: await sha256(sourceArtifact),
        source_repository: 'https://github.com/utrgv-software-engineering/omniagents.git',
        source_commit: commit,
        source_artifact: sourceArtifactPath,
        source_manifest: sourceManifestPath,
      },
      null,
      2
    )}\n`
  );
  return { directory, output, commit };
};

describe('OmniAgents GUI protocol sync', () => {
  it('verifies the checked-in artifact and provenance', () => {
    const result = run('--check');
    expect(result.status, result.stderr).toBe(0);
  });

  it('fails when the generated artifact is stale', async () => {
    const original = await readFile(artifact);
    await writeFile(artifact, Buffer.concat([original, Buffer.from('\n')]));
    try {
      const result = run('--check');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Generated artifact digest mismatch');
    } finally {
      await writeFile(artifact, original);
    }
  });

  it('fails when provenance is incomplete', async () => {
    const original = await readFile(provenance, 'utf8');
    const parsed = JSON.parse(original);
    delete parsed.canonical_sha256;
    await writeFile(provenance, `${JSON.stringify(parsed, null, 2)}\n`);
    try {
      const result = run('--check');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Protocol provenance is incomplete');
    } finally {
      await writeFile(provenance, original);
    }
  });

  it('produces deterministic artifact and provenance bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omni-protocol-'));
    const sourceArtifact = join(directory, 'gui-v1.ts');
    const sourceManifest = join(directory, 'manifest.json');
    await writeFile(sourceArtifact, await readFile(artifact));
    await writeFile(
      sourceManifest,
      JSON.stringify({
        protocol_version: '1.0.0',
        canonical_sha256: 'canonical',
        generator: 'generator',
        generator_version: '1',
        toolchain: {},
      })
    );
    const args = [
      '--sync',
      '--source-ts',
      sourceArtifact,
      '--source-manifest',
      sourceManifest,
      '--source-commit',
      'commit',
      '--output-dir',
      join(directory, 'output'),
    ];
    expect(run(...args).status).toBe(0);
    const outputArtifact = join(directory, 'output/gui-v1.ts');
    const outputProvenance = join(directory, 'output/provenance.json');
    const firstArtifact = await readFile(outputArtifact);
    const firstProvenance = await readFile(outputProvenance);
    expect(run(...args).status).toBe(0);
    expect(await readFile(outputArtifact)).toEqual(firstArtifact);
    expect(await readFile(outputProvenance)).toEqual(firstProvenance);
  });

  it('verifies artifact, metadata, and canonical bytes at the exact pinned commit', async () => {
    const fixture = await sourceFixture();
    const result = run('--verify-source-root', fixture.directory, '--output-dir', fixture.output);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(fixture.commit);
  });

  it('verifies a source repository path containing spaces', async () => {
    const fixture = await sourceFixture('omni source ');
    const result = run('--verify-source-root', fixture.directory, '--output-dir', fixture.output);
    expect(result.status, result.stderr).toBe(0);
  });

  it('fails when the pinned commit is missing', async () => {
    const fixture = await sourceFixture();
    const provenancePath = join(fixture.output, 'provenance.json');
    const parsed = JSON.parse(await readFile(provenancePath, 'utf8'));
    parsed.source_commit = '0000000000000000000000000000000000000000';
    await writeFile(provenancePath, `${JSON.stringify(parsed, null, 2)}\n`);
    const result = run('--verify-source-root', fixture.directory, '--output-dir', fixture.output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Git cat-file failed');
  });

  it('fails when the pinned upstream generated artifact differs', async () => {
    const fixture = await sourceFixture();
    await writeFile(
      join(fixture.directory, 'omniagents/backends/web/ui/src/protocol/generated/gui-v1.ts'),
      'export const tampered = true;\n'
    );
    git(fixture.directory, 'add', '.');
    git(fixture.directory, 'commit', '-m', 'tamper artifact');
    const provenancePath = join(fixture.output, 'provenance.json');
    const parsed = JSON.parse(await readFile(provenancePath, 'utf8'));
    parsed.source_commit = git(fixture.directory, 'rev-parse', 'HEAD');
    await writeFile(provenancePath, `${JSON.stringify(parsed, null, 2)}\n`);
    const result = run('--verify-source-root', fixture.directory, '--output-dir', fixture.output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match the pinned OmniAgents commit');
  });

  it('fails when the pinned upstream manifest differs', async () => {
    const fixture = await sourceFixture();
    const sourceManifestPath = join(fixture.directory, 'protocol/openrpc/manifest.json');
    const manifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
    manifest.generator_version = 'tampered';
    await writeFile(sourceManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    git(fixture.directory, 'add', '.');
    git(fixture.directory, 'commit', '-m', 'tamper manifest');
    const provenancePath = join(fixture.output, 'provenance.json');
    const parsed = JSON.parse(await readFile(provenancePath, 'utf8'));
    parsed.source_commit = git(fixture.directory, 'rev-parse', 'HEAD');
    await writeFile(provenancePath, `${JSON.stringify(parsed, null, 2)}\n`);
    const result = run('--verify-source-root', fixture.directory, '--output-dir', fixture.output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('generator_version');
  });

  it('fails when the provenance source path is tampered', async () => {
    const fixture = await sourceFixture();
    const provenancePath = join(fixture.output, 'provenance.json');
    const parsed = JSON.parse(await readFile(provenancePath, 'utf8'));
    parsed.source_artifact = 'missing/gui-v1.ts';
    await writeFile(provenancePath, `${JSON.stringify(parsed, null, 2)}\n`);
    const result = run('--verify-source-root', fixture.directory, '--output-dir', fixture.output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Git show failed');
  });

  it('fails when the provenance repository is tampered', async () => {
    const fixture = await sourceFixture();
    const provenancePath = join(fixture.output, 'provenance.json');
    const parsed = JSON.parse(await readFile(provenancePath, 'utf8'));
    parsed.source_repository = 'https://github.com/example/wrong.git';
    await writeFile(provenancePath, `${JSON.stringify(parsed, null, 2)}\n`);
    const result = run('--verify-source-root', fixture.directory, '--output-dir', fixture.output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unexpected provenance source repository');
  });

  it('fails when the source repository identity is wrong', async () => {
    const fixture = await sourceFixture();
    git(fixture.directory, 'remote', 'set-url', 'origin', 'https://github.com/example/wrong.git');
    const result = run('--verify-source-root', fixture.directory, '--output-dir', fixture.output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Source root origin does not match');
  });

  it('fails when provenance metadata is tampered', async () => {
    const fixture = await sourceFixture();
    const provenancePath = join(fixture.output, 'provenance.json');
    const parsed = JSON.parse(await readFile(provenancePath, 'utf8'));
    parsed.generator_version = 'tampered';
    await writeFile(provenancePath, `${JSON.stringify(parsed, null, 2)}\n`);
    const result = run('--verify-source-root', fixture.directory, '--output-dir', fixture.output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('generator_version');
  });

  it('fails when the pinned canonical documents do not match their manifest', async () => {
    const fixture = await sourceFixture();
    await writeFile(
      join(fixture.directory, 'protocol/openrpc/omniagents-gui-v1.json'),
      `${JSON.stringify({ info: { version: '2.0.0' }, methods: [] }, null, 2)}\n`
    );
    git(fixture.directory, 'add', '.');
    git(fixture.directory, 'commit', '-m', 'tamper canonical');
    const tamperedCommit = git(fixture.directory, 'rev-parse', 'HEAD');
    const provenancePath = join(fixture.output, 'provenance.json');
    const parsed = JSON.parse(await readFile(provenancePath, 'utf8'));
    parsed.source_commit = tamperedCommit;
    await writeFile(provenancePath, `${JSON.stringify(parsed, null, 2)}\n`);
    const result = run('--verify-source-root', fixture.directory, '--output-dir', fixture.output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('canonical digest');
  });
});
