# Pinned shadcn registry

This directory is the offline source of truth for stock components in `src/renderer/ds/ui`.

- Registry: `new-york-v4`
- Primitive implementation: Radix
- Upstream: `shadcn-ui/ui`
- The exact commit and SHA-256 of every source file are recorded in `../shadcn-registry-lock.json`.

`node scripts/check-shadcn-registry.mjs` compares semantic TypeScript/JSX tokens rather than formatted text. It normalizes only differences caused by this repository's `components.json`: the non-RSC `"use client"` directive, configured import aliases, formatting, import order, and named export order. Component structure, props, classes, operators, and behavior remain significant.

The `.tsx.upstream` suffix keeps verbatim upstream snapshots out of project formatting and lint rewrites. Normal verification is fully offline and fails if a snapshot differs from its pinned raw SHA-256.

Output modes:

```text
node scripts/check-shadcn-registry.mjs
node scripts/check-shadcn-registry.mjs --summary
node scripts/check-shadcn-registry.mjs --json
node scripts/check-shadcn-registry.mjs --self-test
```

The default report lists every semantic drift hunk and prints the hashes needed for an exact approval. Approvals live in `../shadcn-registry-approvals.json`; each one is bound to one component, the pinned upstream source hash, the complete local semantic hash, and a non-empty user-approved reason. Changed or obsolete approvals fail verification.

The sidebar is deliberately reported as `DEFERRED` while its migration is postponed. It is still unapproved drift and still fails verification.

When intentionally updating the pin, fetch every corresponding source from the lock's `upstreamDirectory` at one reviewed upstream commit, preserve it verbatim as `<component>.tsx.upstream`, update the commit constant in the checker, and run `node scripts/check-shadcn-registry.mjs --write-lock`. Review the snapshot and lock diff together. `--write-lock` never approves a local component deviation.
