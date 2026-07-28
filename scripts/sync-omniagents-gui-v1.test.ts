import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const script = resolve(root, 'scripts/sync-omniagents-gui-v1.mjs');
const artifact = resolve(root, 'src/generated/omniagents-gui-v1/gui-v1.ts');
const provenance = resolve(root, 'src/generated/omniagents-gui-v1/provenance.json');

const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

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
});
