# Omni Desktop E2E Tests

This suite uses native Playwright Test for permanent user-story coverage. Use ad hoc scripts only for one-off debugging; user-visible regressions belong here.

## Commands

```bash
npm run test:e2e:server
npm run test:e2e:electron
npm run test:e2e
npm run test:e2e:proof
npm run test:e2e:proof:server
npm run test:e2e:proof:electron
npm run test:e2e:headed
npm run test:e2e:ui
```

Server mode expects `npm run build:server` before `playwright test --project=server-local`; the npm scripts handle that. Electron mode launches `npm run dev` and connects over CDP.

Proof mode sets `VISUAL_PROOF=1` and runs the same specs with screenshots, 1920×1080 video, action overlays, and traces retained for review. It does not require duplicate proof-only specs. Proof runs default to `VISUAL_PROOF_SLOW_MO_MS=120`; override that value to speed up or slow down action playback.

## Layout

- `playwright.config.ts` defines Playwright projects for each launcher mode.
- `tests/e2e/fixtures/test.ts` owns mode startup and exposes `appPage`.
- `tests/e2e/specs/` contains user-story specs that should run across modes when possible.
- `tests/e2e/support/` contains deterministic temp-state, proof-capture, and process helpers.

## Authoring Rules

- Prefer `getByRole`, `getByLabel`, `getByText`, and visible user language.
- Add `data-testid` only when the UI has no stable accessible selector.
- Keep mode-specific branching inside fixtures unless the user-facing behavior differs by mode.
- Every fixed user-visible regression should add or extend a Playwright spec.
- E2E state must stay in temp directories, never in the repo.
- Use `attachProofScreenshot()` from `tests/e2e/support/proof.ts` at meaningful checkpoints. It is a no-op outside `VISUAL_PROOF=1`, so normal E2E runs stay lean.

## Artifacts

Playwright writes normal reports to `artifacts/playwright-report/` and traces, screenshots, and videos to `artifacts/playwright-results/`. Proof runs write to `artifacts/playwright-proof-report/` and `artifacts/playwright-proof-results/`, with screenshots/video/trace enabled even for passing tests. These paths are ignored locally and should be uploaded by CI or attached for review when useful.
