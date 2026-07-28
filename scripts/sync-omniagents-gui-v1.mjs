#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const expectedRepository = 'https://github.com/utrgv-software-engineering/omniagents.git';
const openRpcPath = 'protocol/openrpc/omniagents-gui-v1.json';
const schemaPath = 'protocol/openrpc/schemas/gui-v1.schema.json';
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

const { values } = parseArgs({
  options: {
    sync: { type: 'boolean' },
    check: { type: 'boolean' },
    'verify-source-root': { type: 'string' },
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
const selectedModes = [values.sync, values.check, values['verify-source-root']].filter(Boolean);

if (selectedModes.length !== 1) {
  throw new Error('Pass exactly one of --sync, --check, or --verify-source-root <path>');
}

const readLocal = async () => {
  const artifact = await readFile(artifactPath);
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const required = [
    'protocol_version',
    'canonical_sha256',
    'generated_typescript_sha256',
    'source_repository',
    'source_commit',
    'source_artifact',
    'source_manifest',
    'generator',
    'generator_version',
    'toolchain',
  ];
  if (required.some((field) => provenance[field] === undefined)) {
    throw new Error('Protocol provenance is incomplete');
  }
  const actual = sha256(artifact);
  if (actual !== provenance.generated_typescript_sha256) {
    throw new Error(
      `Generated artifact digest mismatch: expected ${provenance.generated_typescript_sha256}, actual ${actual}`
    );
  }
  return { artifact, provenance };
};

const git = (sourceRoot, args, encoding = 'utf8') => {
  const result = spawnSync('git', ['-C', sourceRoot, ...args], { encoding });
  if (result.status !== 0) {
    throw new Error(`Git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
};

const normalizeRepository = (repository) =>
  repository
    .trim()
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/\/$/, '');

const gitShow = (sourceRoot, commit, path, encoding) => git(sourceRoot, ['show', `${commit}:${path}`], encoding);

const canonicalBytes = (content) => {
  const value = JSON.parse(content);
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, sort(input[key])])
      );
    }
    return input;
  };
  return Buffer.from(`${JSON.stringify(sort(value), null, 2)}\n`);
};

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
    source_repository: expectedRepository,
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
} else if (values.check) {
  const { provenance } = await readLocal();
  console.log(`Verified OmniAgents GUI protocol ${provenance.protocol_version} (${provenance.source_commit})`);
} else {
  const sourceRoot = resolve(values['verify-source-root']);
  const { artifact, provenance } = await readLocal();
  if (normalizeRepository(provenance.source_repository) !== expectedRepository) {
    throw new Error(`Unexpected provenance source repository: ${provenance.source_repository}`);
  }
  const remotes = git(sourceRoot, ['remote', 'get-url', '--all', 'origin']).trim().split('\n').map(normalizeRepository);
  if (!remotes.includes(expectedRepository)) {
    throw new Error(`Source root origin does not match ${expectedRepository}`);
  }
  git(sourceRoot, ['cat-file', '-e', `${provenance.source_commit}^{commit}`]);
  const sourceArtifact = gitShow(sourceRoot, provenance.source_commit, provenance.source_artifact, null);
  if (!Buffer.from(sourceArtifact).equals(artifact)) {
    throw new Error('Generated artifact does not match the pinned OmniAgents commit');
  }
  const sourceManifest = JSON.parse(gitShow(sourceRoot, provenance.source_commit, provenance.source_manifest, 'utf8'));
  for (const field of ['protocol_version', 'canonical_sha256', 'generator', 'generator_version']) {
    if (JSON.stringify(sourceManifest[field]) !== JSON.stringify(provenance[field])) {
      throw new Error(`Protocol provenance ${field} does not match the pinned OmniAgents manifest`);
    }
  }
  if (JSON.stringify(sourceManifest.toolchain) !== JSON.stringify(provenance.toolchain)) {
    throw new Error('Protocol provenance toolchain does not match the pinned OmniAgents manifest');
  }
  const openRpc = gitShow(sourceRoot, provenance.source_commit, openRpcPath, 'utf8');
  const schema = gitShow(sourceRoot, provenance.source_commit, schemaPath, 'utf8');
  const canonicalDigest = sha256(Buffer.concat([canonicalBytes(openRpc), canonicalBytes(schema)]));
  if (canonicalDigest !== sourceManifest.canonical_sha256) {
    throw new Error('Pinned OmniAgents canonical digest does not match its OpenRPC and schema bytes');
  }
  console.log(`Verified OmniAgents source ${provenance.protocol_version} at ${provenance.source_commit}`);
}
