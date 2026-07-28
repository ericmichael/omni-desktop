# GUI protocol provenance

Omni Desktop consumes the generated GUI v1 TypeScript contract from OmniAgents. The checked-in transport envelope contains `gui-v1.ts`, `provenance.json`, and the canonical manifest, OpenRPC document, and JSON Schema under `canonical/`. Provenance pins the exact upstream commit and paths, per-file digests, canonical digest, generator version, and toolchain metadata.

## Verify the transported artifact

Run the same secret-free check used by required CI:

```bash
npm run protocol:check
```

The check verifies every transported byte digest, fixed source and transport path, full source commit format, manifest metadata, and the canonical digest recomputed from the transported OpenRPC and schema. It requires no network or access to the private OmniAgents repository.

## Verify a pinned source

Clone or fetch OmniAgents so the pinned commit exists locally, then run:

```bash
npm run protocol:verify-source -- /path/to/omniagents
```

Verification is read-only. It checks the source repository identity, resolves the exact commit without checking it out, compares the generated TypeScript bytes, compares manifest metadata, and recomputes the canonical digest from the pinned OpenRPC document and JSON Schema. A branch tip or working-tree file cannot substitute for the pinned commit.

## Update the contract

Land the canonical OmniAgents protocol change first. From an authorized OmniAgents clone at that exact landed commit, sync the complete transport envelope:

```bash
npm run protocol:sync -- \
  --source-ts /path/to/omniagents/omniagents/backends/web/ui/src/protocol/generated/gui-v1.ts \
  --source-manifest /path/to/omniagents/protocol/openrpc/manifest.json \
  --source-openrpc /path/to/omniagents/protocol/openrpc/omniagents-gui-v1.json \
  --source-schema /path/to/omniagents/protocol/openrpc/schemas/gui-v1.schema.json \
  --source-commit <full-omniagents-commit>
npm run protocol:check
npm run protocol:verify-source -- /path/to/omniagents
```

Review the generated artifact, provenance, and all canonical transport files together. Do not hand-edit them or pin an unreviewed branch head. `protocol:verify-source` proves the transport matches the private source commit during update/review; required CI subsequently preserves that reviewed binding offline. Protocol compatibility and release governance remain canonical in OmniAgents.
