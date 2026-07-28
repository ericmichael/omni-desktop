#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

const { values } = parseArgs({
  options: {
    sync: { type: 'boolean' },
    check: { type: 'boolean' },
    'source-ts': { type: 'string' },
    'source-manifest': { type: 'string' },
    'source-commit': { type: 'string' },
    'output-dir': { type: 'string' },
  },
});

const outputDir = values['output-dir']
  ? resolve(values['output-dir'])
  : resolve(root, 'src/generated/omniagents-gui-v1');
const artifactPath = resolve(outputDir, 'gui-v1.ts');
const provenancePath = resolve(outputDir, 'provenance.json');

if (values.sync === values.check) {
  throw new Error('Pass exactly one of --sync or --check');
}

if (values.sync) {
  if (!values['source-ts'] || !values['source-manifest'] || !values['source-commit']) {
    throw new Error('--sync requires --source-ts, --source-manifest, and --source-commit');
  }
  const sourceArtifact = await readFile(resolve(values['source-ts']));
  const sourceManifest = JSON.parse(await readFile(resolve(values['source-manifest']), 'utf8'));
  const provenance = {
    protocol_version: sourceManifest.protocol_version,
    canonical_sha256: sourceManifest.canonical_sha256,
    generated_typescript_sha256: sha256(sourceArtifact),
    source_repository: 'https://github.com/utrgv-software-engineering/omniagents.git',
    source_commit: values['source-commit'],
    source_artifact: 'omniagents/backends/web/ui/src/protocol/generated/gui-v1.ts',
    source_manifest: 'protocol/openrpc/manifest.json',
    generator: sourceManifest.generator,
    generator_version: sourceManifest.generator_version,
    toolchain: sourceManifest.toolchain,
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(artifactPath, sourceArtifact);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`Synced OmniAgents GUI protocol ${provenance.protocol_version}`);
} else {
  const artifact = await readFile(artifactPath);
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const actual = sha256(artifact);
  if (actual !== provenance.generated_typescript_sha256) {
    throw new Error(
      `Generated artifact digest mismatch: expected ${provenance.generated_typescript_sha256}, actual ${actual}`
    );
  }
  if (!provenance.protocol_version || !provenance.canonical_sha256 || !provenance.source_commit) {
    throw new Error('Protocol provenance is incomplete');
  }
  console.log(`Verified OmniAgents GUI protocol ${provenance.protocol_version} (${provenance.source_commit})`);
}
