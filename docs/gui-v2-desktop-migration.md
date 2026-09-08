# Desktop GUI protocol v2 migration

## Scope

Move outbound OmniAgents GUI clients to v2 without changing the independent
inbound `/ws/chat` protocol. Preserve session ownership, pending submissions,
and tile-local plans/artifacts. Reject incompatible or malformed initialization
before readiness, event dispatch, replay, or submission; never downgrade to v1.

## Implementation

- Desktop uses the generated v2 method map and version constant.
- Renderer and main-process clients share initialization validation and
  actionable version-mismatch errors. Existing connection-error UI provides retry.
- Fixed a retry ordering bug discovered by the new E2E story: the boot actor
  sampled the previous permanent RPC error before the replacement connection
  reset it, leaving the screen stuck despite a successful new handshake.
- The sync command accepts an explicit major, preserves historical v1 files,
  and requires v2 inputs to match a clean, pinned backend commit before writing.
- Current provenance pins backend commit
  `7335e631c11814c6e034f11155922594c1fce564`.

## Source-pin gate closed

Desktop's `noUncheckedIndexedAccess` check exposed four errors in the canonical
generated v2 version helper. The backend generator and both generated clients
have been corrected, with a strict TypeScript compilation regression
test. The correction passes 68 backend protocol tests and generation checks.

With user authorization, the four-file backend correction was committed as
`7335e631` (`Fix GUI v2 helpers under strict indexed access`). Desktop was synced
from that clean commit through `npm run protocol:sync`. Both
`npm run protocol:verify-source` and `npm run protocol:check` pass, as does
`npm run lint:tsc`. The 365 Desktop tests and 68 backend tests were rerun and
passed. Backend working tree is clean; nothing was pushed. The prior browser
and Electron visual proofs predate this type-narrowing-only generator correction.

Technical migration verification does not constitute maintainer approval of a
protocol release. Historical v1 baselines remain unchanged.

## Verification recorded during migration

- 365 focused Desktop RPC/session/handshake/sync tests passed (36 files),
  including a hook regression for the stale-error retry race.
- Sync tests: 19 passed, including rejection of dirty and mismatched v2 sources
  without overwriting output.
- Server/browser and Electron production bundles built successfully.
- New permanent story: `tests/e2e/specs/chat-protocol-version.spec.ts` injects a
  legacy-peer rejection at the renderer wire boundary, then restores the real
  v2 backend. This is not a deployment of an old backend runtime.
- Existing tile-generated-UI story passed in both server and Electron modes,
  including plan/artifact updates and reconnect. Reports are under
  `artifacts/protocol-v2-server-report` and `artifacts/protocol-v2-native-report`.
  Those initial reports also contain failed mismatch-test attempts (a stale
  browser bundle and an incorrect retry-button selector); subsequent
  `protocol-v2-final-*` attempts reproduced the real stale-error retry bug.
- The corrected recovery story passed in **both browser and Electron** after
  the retry fix. Successful reports are
  `artifacts/protocol-v2-retry-fixed-server-report/index.html` and
  `artifacts/protocol-v2-retry-fixed-native-report/index.html`. The native video
  was visually inspected with the preserved prompt and assistant reply visible.
- Targeted ESLint, diff-whitespace checks, and Desktop TypeScript pass.

Proof commands use `OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni`,
`VISUAL_PROOF=1`, and `VISUAL_PROOF_SLOW_MO_MS=20`:

```bash
PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/protocol-v2-retry-fixed-server-report npx playwright test tests/e2e/specs/chat-protocol-version.spec.ts --project=server-local --output=artifacts/protocol-v2-retry-fixed-server-results
DISPLAY=:0 E2E_ELECTRON_X11=1 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/protocol-v2-retry-fixed-native-report npx playwright test tests/e2e/specs/chat-protocol-version.spec.ts --project=electron-local --output=artifacts/protocol-v2-retry-fixed-native-results
```

These use isolated test profiles. No user database or Azure verification is in
scope. The migration was initially left uncommitted pending the final
release-readiness pass below.

## Final release-readiness pass

The final source is paired with backend `7335e631`. Both production builds and
TypeScript pass. The full Vitest suite passes **3,045 tests**, with **21 skipped**
(including environment-gated PostgreSQL tests). The broad run exposed a stale
supervisor test expecting blanket tool approval; it now checks the already
implemented automatic reviewer and asserts that blanket overrides are absent.
The five files affected by final test/import cleanup pass 74 targeted tests.

Commit scope includes accumulated chat/session ownership, tile routing,
recovery, durable cleanup, authentication isolation, and their tests. Local
voice capture/focus fixes belong to the earlier tile lifecycle work; the
separate realtime voice overhaul is not included. Runtime data, proof artifacts,
`docs/realtime-voice-overhaul-plan.md`, and
`docs/agentic-workflow-enforcement-plan.md` are excluded. A credential-signature
scan of changed source files found no matches; this is not a comprehensive
security audit. Historical audit notes above retain their original results.

Final proof commands (run after both builds completed):

All **six stories passed**: three server-local (2.5 minutes) and three
electron-local (2.2 minutes). The native video was inspected with updated A/B
plans and artifacts visible in their own tiles. Reports are
`artifacts/release-ready-server-report/index.html` and
`artifacts/release-ready-native-report/index.html`; traces and videos are retained
in those reports and the corresponding results directories. Scoped ESLint,
Prettier (excluding byte-pinned generated artifacts), and diff checks pass.

```bash
OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/release-ready-server-report npx playwright test tests/e2e/specs/chat-protocol-version.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts tests/e2e/specs/chat-silent-connection.spec.ts --project=server-local --output=artifacts/release-ready-server-results
DISPLAY=:0 E2E_ELECTRON_X11=1 OMNI_CLI_PATH=/home/emm/Omni/Workspace/omni-code/.venv/bin/omni VISUAL_PROOF=1 VISUAL_PROOF_SLOW_MO_MS=20 PLAYWRIGHT_HTML_OUTPUT_DIR=artifacts/release-ready-native-report npx playwright test tests/e2e/specs/chat-protocol-version.spec.ts tests/e2e/specs/tile-generated-ui.spec.ts tests/e2e/specs/chat-silent-connection.spec.ts --project=electron-local --output=artifacts/release-ready-native-results
```
