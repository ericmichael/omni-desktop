# GUI protocol provenance

Omni Desktop consumes the generated GUI v1 TypeScript contract from OmniAgents. The checked-in `provenance.json` pins the exact upstream commit, artifact path, manifest path, canonical digest, generator version, and toolchain metadata.

## Verify a pinned source

Clone or fetch OmniAgents so the pinned commit exists locally, then run:

```bash
npm run protocol:verify-source -- /path/to/omniagents
```

Verification is read-only. It checks the source repository identity, resolves the exact commit without checking it out, compares the generated TypeScript bytes, compares manifest metadata, and recomputes the canonical digest from the pinned OpenRPC document and JSON Schema. A branch tip or working-tree file cannot substitute for the pinned commit.

## Update the contract

Land the canonical OmniAgents protocol change first. From Omni Desktop, sync the generated TypeScript file and manifest from that exact landed commit:

```bash
npm run protocol:sync -- \
  --source-ts /path/to/omniagents/omniagents/backends/web/ui/src/protocol/generated/gui-v1.ts \
  --source-manifest /path/to/omniagents/protocol/openrpc/manifest.json \
  --source-commit <full-omniagents-commit>
npm run protocol:check
npm run protocol:verify-source -- /path/to/omniagents
```

Review the generated artifact and provenance together. Do not hand-edit either file or pin an unreviewed branch head. Protocol compatibility and release governance remain canonical in OmniAgents; Desktop reviewers verify only that the consumed artifact is exactly attributable to that canonical release.
