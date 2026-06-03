# AGENTS.md — Omni Desktop

## Scope

- This file covers the whole `omni-desktop` repository.
- Prefer proving launcher behavior from the user's perspective before declaring UI work complete.
- Agents are allowed to install project dependencies and use repo-local or temporary runtime state for verification.

## Setup

- Required runtime: Node `22+` and npm. The dev sandbox currently provides Node `22.13.1`.
- Install dependencies with `npm install`. This runs `electron-rebuild`, downloads `uv`, and attempts to download the sandbox binary.
- It is acceptable if sandbox release download logs `release not found` and skips the download during local development.
- Do not run `npm audit fix` or broad upgrade commands unless explicitly asked.
- Keep generated app state out of the repo while running Vite watchers. Use a temp config directory such as `XDG_CONFIG_HOME=/tmp/omni-desktop-e2e-xdg`; do not put `XDG_CONFIG_HOME` under the repo because Vite will watch Electron cache files and thrash reloads.

## Credentials And Models

- The agent compute environment may provide OpenAI-compatible credentials as `SANDBOX_OPENAI_BASE_URL` and `SANDBOX_OPENAI_API_KEY`.
- For launcher/Electron verification, export them as `OPENAI_BASE_URL` and `OPENAI_API_KEY` before launch.
- Never write literal API keys into tracked files, logs, or docs. If creating `.env`, it must stay ignored and contain references or local-only secrets.
- To preseed an isolated launcher profile with an OpenAI-compatible `gpt-5.2` provider, use the seed store helpers. Keep `store.envVars` empty for this path; the Electron process already exports `OPENAI_BASE_URL` and `OPENAI_API_KEY`, and setting `envVars` to `${SANDBOX_OPENAI_BASE_URL}` will pass that literal string through to the agent server and break model calls.

```bash
rm -rf /tmp/omni-desktop-e2e-xdg
mkdir -p /tmp/omni-desktop-e2e-xdg
XDG_CONFIG_HOME=/tmp/omni-desktop-e2e-xdg node --input-type=module <<'NODE'
import { readStore, writeStore } from './scripts/seed/store-io.mjs';
const store = await readStore();
store.onboardingComplete = true;
store.modelsConfig = {
  version: 3,
  default: 'sandbox/gpt-5.2',
  voice_default: null,
  providers: {
    sandbox: {
      type: 'openai-compatible',
      base_url: '${OPENAI_BASE_URL}',
      api_key: '${OPENAI_API_KEY}',
      models: { 'gpt-5.2': { model: 'gpt-5.2' } }
    }
  }
};
store.envVars = '';
await writeStore(store);
NODE
```

## Electron E2E Driving

- Launch Electron in development with a CDP port enabled. Use a port that is known to be free; `9333` is common but can conflict with stale child processes, so `9444` is a safer default for E2E runs.

```bash
export XDG_CONFIG_HOME=/tmp/omni-desktop-e2e-xdg
export OMNI_DEBUG_PORT=9444
export OPENAI_BASE_URL="$SANDBOX_OPENAI_BASE_URL"
export OPENAI_API_KEY="$SANDBOX_OPENAI_API_KEY"
export DISPLAY=:0
npm run dev
```

- Use `DISPLAY=:0` when the human should see the Electron window in VNC. Use `xvfb-run -a npm run dev` only for hidden/headless proof runs.
- For long-running verification, start it as a background job instead of blocking the agent turn.
- Before launch, stop stale `electron-vite`, Electron, and `omni serve` processes from previous runs. After launch, confirm the CDP port belongs to Electron: `ss -ltnp | rg '9444|5173'` should show `9444` owned by `electron`, not `python`.
- Verify CDP is up with `curl http://127.0.0.1:9444/json/version` and list pages with `curl http://127.0.0.1:9444/json/list`.
- Drive the Electron renderer using Playwright over CDP:

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp('http://127.0.0.1:9444')
    page = next(
        page
        for context in browser.contexts
        for page in context.pages
        if 'localhost:' in page.url
    )
    page.wait_for_function('() => document.body && document.body.innerText.includes("Settings")')
    print(page.locator('body').inner_text())
    browser.close()
```

- The built-in app-control system is also CDP-backed. Relevant files are `src/main/app-control-cdp.ts`, `src/main/app-control-manager.ts`, and `src/shared/app-control-types.ts`.
- CDP refs/snapshots are invalidated after navigation; re-snapshot before clicking again.

## Web And VNC Surfaces

- The sandbox image includes Chromium, Python Playwright, `@playwright/cli`, `chrome-binary`, VNC/noVNC, and browser MCP environment variables.
- For headed browser checks inside VNC, use `DISPLAY=:0 playwright-cli open --headed http://localhost:<port>/`.
- If `$DISPLAY` is unknown, inspect `/tmp/.X11-unix`; `X0` means `DISPLAY=:0`.
- When launching Python Playwright headed, prefer setting `DISPLAY=:0` in the shell. Do not pass a minimal `env={"DISPLAY": ":0"}` to `browser.launch()` unless you also preserve `PLAYWRIGHT_BROWSERS_PATH`; otherwise the `chrome-binary` shim may not find Chromium.
- Use browser/UI evidence in this order: accessibility snapshot or rendered text, console logs, network logs, screenshots, then video/tracing for harder issues.

## Browser / Server E2E Driving

- Server mode uses `HOME`, not Electron's `XDG_CONFIG_HOME`, for its local JSON store at `~/.config/Omni Code/config.json`. Use an isolated home for tests:

```bash
rm -rf /tmp/omni-desktop-server-home
mkdir -p '/tmp/omni-desktop-server-home/.config/Omni Code'
cat > '/tmp/omni-desktop-server-home/.config/Omni Code/config.json' <<'JSON'
{
  "onboardingComplete": true,
  "defaultProfileName": "host",
  "modelsConfig": {
    "version": 3,
    "default": "sandbox/gpt-5.2",
    "voice_default": null,
    "providers": {
      "sandbox": {
        "type": "openai-compatible",
        "base_url": "${OPENAI_BASE_URL}",
        "api_key": "${OPENAI_API_KEY}",
        "models": { "gpt-5.2": { "model": "gpt-5.2" } }
      }
    }
  },
  "envVars": ""
}
JSON
```

- Build server/browser bundles once with `npm run build:server`.
- Start the built server in a background job:

```bash
export HOME=/tmp/omni-desktop-server-home
export XDG_CONFIG_HOME=/tmp/omni-desktop-server-home/.config
export OPENAI_BASE_URL="$SANDBOX_OPENAI_BASE_URL"
export OPENAI_API_KEY="$SANDBOX_OPENAI_API_KEY"
export HOST=127.0.0.1
export PORT=3001
export OMNI_WEB_AUTO_OPEN=false
npm run start:server
```

- Wait for `Server listening at http://127.0.0.1:3001`, then drive `http://127.0.0.1:3001/` with Playwright or `playwright-cli`.
- For visible VNC browser proof with Python Playwright:

```bash
DISPLAY=:0 python - <<'PY'
from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=False,
        executable_path='/opt/ms-playwright/chromium-1223/chrome-linux64/chrome',
        args=['--no-sandbox'],
    )
    page = browser.new_page()
    page.goto('http://127.0.0.1:3001/', wait_until='domcontentloaded')
    page.wait_for_function('() => document.body && document.body.innerText.includes("Chat")')
    print(page.locator('body').inner_text())
    browser.close()
PY
```

- A successful browser/server chat proof should show the submitted prompt and assistant response in the page body.

## Permanent Playwright E2E Suite

- Committed E2E tests use native Playwright Test, not throwaway YAML or one-off scripts.
- Add permanent user-story coverage under `tests/e2e/specs/` and shared startup helpers under `tests/e2e/fixtures/` or `tests/e2e/support/`.
- Prefer `getByRole`, `getByLabel`, and visible product language. Add `data-testid` only when no stable accessible selector exists.
- Keep mode-specific launch details in fixtures; specs should cover shared stories across `server-local` and `electron-local` where possible.
- Commands: `npm run test:e2e:server`, `npm run test:e2e:electron`, `npm run test:e2e`, `npm run test:e2e:headed`, `npm run test:e2e:ui`.
- Visual proof commands: `npm run test:e2e:proof`, `npm run test:e2e:proof:server`, `npm run test:e2e:proof:electron`. These run the same specs with `VISUAL_PROOF=1`, retaining screenshots, traces, and 1080p videos with action overlays. Set `VISUAL_PROOF_SLOW_MO_MS=<ms>` to adjust proof playback speed.
- Playwright reports and traces live under `artifacts/playwright-report/` and `artifacts/playwright-results/`. Visual proof reports live under `artifacts/playwright-proof-report/` and `artifacts/playwright-proof-results/`.
- Before moving any ticket to the `Review` column, generate visual proof artifacts for the user-facing behavior changed by the ticket. The user expects to inspect the Playwright proof report first to gain confidence that the app works from the user's perspective before reviewing the agent's work. In the ticket handoff, cite the exact proof command run and the proof report/results paths.

## Debugging Workflow

- Start with the narrowest proof: dependency install, app launch, CDP availability, then one user-visible assertion.
- Check logs before patching. Electron dev logs should show the renderer URL, CDP line, runtime install progress, and any Omni serve readiness JSON.
- If the UI appears blank, query CDP page title and body text before assuming React failed.
- If the app reloads repeatedly, make sure generated config/cache directories are outside the repo and not watched by Vite.
- If CDP is unreachable or hangs, check port ownership with `ss -ltnp`. A stale `omni serve` Python process can occupy the debug port and make agents chase the wrong target.
- If model calls fail with `Request URL is missing an 'http://' or 'https://' protocol`, inspect the launcher's stored `envVars`; a literal `${SANDBOX_OPENAI_BASE_URL}` likely clobbered `OPENAI_BASE_URL` in the child process.
- Common harmless Linux/Xvfb logs include missing DBus socket, GPU process initialization errors, and `APPIMAGE env is not defined`.
- The first isolated launch may install the Omni runtime with `uv`; wait for `Installation completed successfully`, Omni serve readiness JSON, and `Sandbox started` before testing agent flows.
- In server mode, if settings do not appear to apply, confirm you seeded `$HOME/.config/Omni Code/config.json`; `XDG_CONFIG_HOME` alone is not enough for `ServerStore`.

## Validation Commands

- Unit tests: `npm test -- --run` or targeted `npx vitest run <path>`.
- Type/lint checks: `npm run lint:tsc`, `npm run lint:eslint`, `npm run lint:prettier`.
- Production build: `npm run build`.
- Use targeted checks first; avoid broad lint/build runs during exploratory UI debugging unless needed.

## Git Hygiene

- Do not commit, stage, reset, or clean files unless the user explicitly asks.
- Preserve user changes. Check `git status -sb` before editing.
- Keep `.env`, temporary XDG config directories, runtime caches, screenshots, and job logs out of commits.
