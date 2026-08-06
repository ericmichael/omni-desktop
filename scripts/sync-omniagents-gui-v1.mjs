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
const transportManifestPath = 'canonical/manifest.json';
const transportOpenRpcPath = 'canonical/omniagents-gui-v1.json';
const transportSchemaPath = 'canonical/gui-v1.schema.json';
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

const { values } = parseArgs({
  options: {
    sync: { type: 'boolean' },
    check: { type: 'boolean' },
    'verify-source': { type: 'boolean' },
    'verify-source-root': { type: 'string' },
    'source-ts': { type: 'string' },
    'source-manifest': { type: 'string' },
    'source-openrpc': { type: 'string' },
    'source-schema': { type: 'string' },
    'source-commit': { type: 'string' },
    'output-dir': { type: 'string' },
  },
});

const outputDir = values['output-dir']
  ? resolve(values['output-dir'])
  : resolve(root, 'src/generated/omniagents-gui-v1');
const artifactPath = resolve(outputDir, 'gui-v1.ts');
const provenancePath = resolve(outputDir, 'provenance.json');
const transportedManifestPath = resolve(outputDir, transportManifestPath);
const transportedOpenRpcPath = resolve(outputDir, transportOpenRpcPath);
const transportedSchemaPath = resolve(outputDir, transportSchemaPath);
const selectedModes = [values.sync, values.check, values['verify-source'], values['verify-source-root']].filter(
  Boolean
);

if (selectedModes.length !== 1) {
  throw new Error('Pass exactly one of --sync, --check, --verify-source, or --verify-source-root <path>');
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
    'source_openrpc',
    'source_schema',
    'transport_manifest',
    'transport_openrpc',
    'transport_schema',
    'transport_manifest_sha256',
    'transport_openrpc_sha256',
    'transport_schema_sha256',
    'generator',
    'generator_version',
    'toolchain',
  ];
  if (required.some((field) => provenance[field] === undefined)) {
    throw new Error('Protocol provenance is incomplete');
  }
  if (!/^[0-9a-f]{40}$/.test(provenance.source_commit)) {
    throw new Error('Protocol provenance source_commit must be a full lowercase Git commit');
  }
  const expectedPaths = {
    source_repository: expectedRepository,
    source_artifact: 'omniagents/backends/web/ui/src/protocol/generated/gui-v1.ts',
    source_manifest: 'protocol/openrpc/manifest.json',
    source_openrpc: openRpcPath,
    source_schema: schemaPath,
    transport_manifest: transportManifestPath,
    transport_openrpc: transportOpenRpcPath,
    transport_schema: transportSchemaPath,
  };
  for (const [field, expected] of Object.entries(expectedPaths)) {
    if (provenance[field] !== expected) {
      throw new Error(`Protocol provenance ${field} must equal ${expected}`);
    }
  }
  const actual = sha256(artifact);
  if (actual !== provenance.generated_typescript_sha256) {
    throw new Error(
      `Generated artifact digest mismatch: expected ${provenance.generated_typescript_sha256}, actual ${actual}`
    );
  }
  const transportedManifest = await readFile(transportedManifestPath);
  const transportedOpenRpc = await readFile(transportedOpenRpcPath);
  const transportedSchema = await readFile(transportedSchemaPath);
  for (const [name, content, expected] of [
    ['manifest', transportedManifest, provenance.transport_manifest_sha256],
    ['OpenRPC document', transportedOpenRpc, provenance.transport_openrpc_sha256],
    ['schema', transportedSchema, provenance.transport_schema_sha256],
  ]) {
    const digest = sha256(content);
    if (digest !== expected) {
      throw new Error(`Transported ${name} digest mismatch: expected ${expected}, actual ${digest}`);
    }
  }
  const manifest = JSON.parse(transportedManifest.toString('utf8'));
  for (const field of ['protocol_version', 'canonical_sha256', 'generator', 'generator_version']) {
    if (JSON.stringify(manifest[field]) !== JSON.stringify(provenance[field])) {
      throw new Error(`Protocol provenance ${field} does not match the transported manifest`);
    }
  }
  if (JSON.stringify(manifest.toolchain) !== JSON.stringify(provenance.toolchain)) {
    throw new Error('Protocol provenance toolchain does not match the transported manifest');
  }
  const canonicalDigest = sha256(
    Buffer.concat([canonicalBytes(transportedOpenRpc), canonicalBytes(transportedSchema)])
  );
  if (canonicalDigest !== manifest.canonical_sha256) {
    throw new Error('Transported canonical digest does not match its OpenRPC and schema bytes');
  }
  return { artifact, provenance, transportedManifest, transportedOpenRpc, transportedSchema };
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

const sourceRepositoryMatches = (sourceRoot) => {
  const result = spawnSync('git', ['-C', sourceRoot, 'remote', 'get-url', '--all', 'origin'], { encoding: 'utf8' });
  if (result.status !== 0) return false;
  return result.stdout.trim().split('\n').map(normalizeRepository).includes(expectedRepository);
};

const discoverSourceRoot = () => {
  const configured = process.env.OMNIAGENTS_SOURCE_ROOT?.trim();
  if (configured) {
    const candidate = resolve(configured);
    if (!sourceRepositoryMatches(candidate)) {
      throw new Error(`OMNIAGENTS_SOURCE_ROOT does not identify the ${expectedRepository} checkout: ${candidate}`);
    }
    return candidate;
  }

  // Omni's development workspace keeps launcher and omniagents as siblings.
  // CI jobs with a different checkout layout should set OMNIAGENTS_SOURCE_ROOT.
  const candidates = [resolve(root, '../omniagents')];
  const discovered = candidates.find(sourceRepositoryMatches);
  if (discovered) return discovered;

  throw new Error(
    `Could not find an OmniAgents source checkout. Set OMNIAGENTS_SOURCE_ROOT to a checkout of ${expectedRepository}.`
  );
};

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
  if (
    !values['source-ts'] ||
    !values['source-manifest'] ||
    !values['source-openrpc'] ||
    !values['source-schema'] ||
    !values['source-commit']
  ) {
    throw new Error(
      '--sync requires --source-ts, --source-manifest, --source-openrpc, --source-schema, and --source-commit'
    );
  }
  if (!/^[0-9a-f]{40}$/.test(values['source-commit'])) {
    throw new Error('--source-commit must be a full lowercase Git commit');
  }
  const sourceArtifact = await readFile(resolve(values['source-ts']));
  const sourceManifestBytes = await readFile(resolve(values['source-manifest']));
  const sourceOpenRpc = await readFile(resolve(values['source-openrpc']));
  const sourceSchema = await readFile(resolve(values['source-schema']));
  const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8'));
  const canonicalDigest = sha256(Buffer.concat([canonicalBytes(sourceOpenRpc), canonicalBytes(sourceSchema)]));
  if (canonicalDigest !== sourceManifest.canonical_sha256) {
    throw new Error('Source canonical digest does not match its OpenRPC and schema bytes');
  }
  const provenance = {
    protocol_version: sourceManifest.protocol_version,
    canonical_sha256: sourceManifest.canonical_sha256,
    generated_typescript_sha256: sha256(sourceArtifact),
    source_repository: expectedRepository,
    source_commit: values['source-commit'],
    source_artifact: 'omniagents/backends/web/ui/src/protocol/generated/gui-v1.ts',
    source_manifest: 'protocol/openrpc/manifest.json',
    source_openrpc: openRpcPath,
    source_schema: schemaPath,
    transport_manifest: transportManifestPath,
    transport_openrpc: transportOpenRpcPath,
    transport_schema: transportSchemaPath,
    transport_manifest_sha256: sha256(sourceManifestBytes),
    transport_openrpc_sha256: sha256(sourceOpenRpc),
    transport_schema_sha256: sha256(sourceSchema),
    generator: sourceManifest.generator,
    generator_version: sourceManifest.generator_version,
    toolchain: sourceManifest.toolchain,
  };
  await mkdir(resolve(outputDir, 'canonical'), { recursive: true });
  await writeFile(artifactPath, sourceArtifact);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  await writeFile(transportedManifestPath, sourceManifestBytes);
  await writeFile(transportedOpenRpcPath, sourceOpenRpc);
  await writeFile(transportedSchemaPath, sourceSchema);
  console.log(`Synced OmniAgents GUI protocol ${provenance.protocol_version}`);
} else if (values.check) {
  const { provenance } = await readLocal();
  console.log(`Verified OmniAgents GUI protocol ${provenance.protocol_version} (${provenance.source_commit})`);
} else {
  const sourceRoot = values['verify-source-root'] ? resolve(values['verify-source-root']) : discoverSourceRoot();
  const { artifact, provenance, transportedManifest, transportedOpenRpc, transportedSchema } = await readLocal();
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
  const sourceManifestBytes = gitShow(sourceRoot, provenance.source_commit, provenance.source_manifest, null);
  if (!Buffer.from(sourceManifestBytes).equals(transportedManifest)) {
    throw new Error('Transported manifest does not match the pinned OmniAgents commit');
  }
  for (const field of ['protocol_version', 'canonical_sha256', 'generator', 'generator_version']) {
    if (JSON.stringify(sourceManifest[field]) !== JSON.stringify(provenance[field])) {
      throw new Error(`Protocol provenance ${field} does not match the pinned OmniAgents manifest`);
    }
  }
  if (JSON.stringify(sourceManifest.toolchain) !== JSON.stringify(provenance.toolchain)) {
    throw new Error('Protocol provenance toolchain does not match the pinned OmniAgents manifest');
  }
  const openRpc = gitShow(sourceRoot, provenance.source_commit, provenance.source_openrpc, null);
  const schema = gitShow(sourceRoot, provenance.source_commit, provenance.source_schema, null);
  if (!Buffer.from(openRpc).equals(transportedOpenRpc)) {
    throw new Error('Transported OpenRPC document does not match the pinned OmniAgents commit');
  }
  if (!Buffer.from(schema).equals(transportedSchema)) {
    throw new Error('Transported schema does not match the pinned OmniAgents commit');
  }
  const canonicalDigest = sha256(Buffer.concat([canonicalBytes(openRpc), canonicalBytes(schema)]));
  if (canonicalDigest !== sourceManifest.canonical_sha256) {
    throw new Error('Pinned OmniAgents canonical digest does not match its OpenRPC and schema bytes');
  }
  console.log(`Verified OmniAgents source ${provenance.protocol_version} at ${provenance.source_commit}`);
}
