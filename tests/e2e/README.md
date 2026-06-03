# Omni Desktop E2E Tests

This suite uses native Playwright Test for permanent user-story coverage. Use ad hoc scripts only for one-off debugging; user-visible regressions belong here.

## Commands

```bash
npm run test:e2e:server
npm run test:e2e:electron
npm run test:e2e
npm run test:e2e:headed
npm run test:e2e:ui
```

Server mode expects `npm run build:server` before `playwright test --project=server-local`; the npm scripts handle that. Electron mode launches `npm run dev` and connects over CDP.

## Layout

- `playwright.config.ts` defines Playwright projects for each launcher mode.
- `tests/e2e/fixtures/test.ts` owns mode startup and exposes `appPage`.
- `tests/e2e/specs/` contains user-story specs that should run across modes when possible.
- `tests/e2e/support/` contains deterministic temp-state and process helpers.

## Authoring Rules

- Prefer `getByRole`, `getByLabel`, `getByText`, and visible user language.
- Add `data-testid` only when the UI has no stable accessible selector.
- Keep mode-specific branching inside fixtures unless the user-facing behavior differs by mode.
- Every fixed user-visible regression should add or extend a Playwright spec.
- E2E state must stay in temp directories, never in the repo.

## Artifacts

Playwright writes reports to `artifacts/playwright-report/` and traces, screenshots, and videos to `artifacts/playwright-results/`. These paths are ignored locally and should be uploaded by CI on failure.
