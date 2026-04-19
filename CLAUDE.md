# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Omni Code Launcher — an Electron + React desktop app for installing the Omni Code runtime and launching Docker-based sandboxes. Also ships a browser/server build (Fastify + WebSocket) that runs the same renderer without Electron.

## Commands

```bash
npm i                      # Install deps; postinstall runs electron-rebuild (node-pty),
                           # downloads uv, and downloads/builds the omni-sandbox binary
npm run dev                # Electron dev with hot reload (electron-vite)
npm run build              # Build main + preload + renderer into out/
npm run package            # Clean + download assets + build + electron-builder (→ dist/)
npm run publish            # Same as package, but publishes to GitHub Releases

npm run lint               # Runs ESLint, Prettier, tsc, knip, dpdm concurrently
npm run fix                # eslint --fix + prettier --write

npm test                   # vitest (rebuilds node-pty first)
npm run test:no-watch      # One-shot vitest run
npx vitest run src/lib/result.test.ts   # Single test file

# Browser/server mode (no Electron)
npm run dev:server         # Concurrent: server watch build + browser Vite dev on :5173
npm run build:server       # Build server + browser SPA
npm run start:server       # Run built server from out/server/index.mjs (default :3001)

npm run build:sandbox      # Rebuild the Rust omni-sandbox binary (requires rustup)
```

`npm test` re-runs `electron-rebuild` against node-pty every time — needed because the binary is compiled against Electron's Node ABI, which differs from system Node.

## Architecture

### Two runtime targets

The same renderer ships in two shells:

1. **Electron** (`src/main/index.ts`) — full desktop app, electron-store for persistence, direct IPC via `@electron-toolkit/typed-ipc`.
2. **Server mode** (`src/server/index.ts`) — Fastify + `ws`, same managers behind a WebSocket RPC. `vite.server.config.ts` aliases `electron`, `electron-store`, `electron-context-menu`, `electron-updater`, and `@electron-toolkit/typed-ipc/main` to shims in `src/server/` so main-process managers run unchanged.

The browser build (`vite.browser.config.ts`) produces a standalone SPA that proxies `/api`, `/ws`, and `/proxy` to the Fastify server and shims Electron-only renderer imports to empty stubs.

### Transport abstraction

IPC goes through `TransportEmitter` / `TransportListener` interfaces (`src/shared/transport.ts`). Two implementations in `src/renderer/transport/`:
- `ElectronTransportEmitter/Listener` — wraps typed-ipc
- `WsTransportEmitter/Listener` — JSON-RPC-ish over a single WebSocket, with reconnect + message queue; fetches an auth token from `/api/ws-token` (loopback-only) before dialing `/ws`

`src/renderer/services/ipc.ts` picks the transport at startup. All channel signatures live in `src/shared/types.ts` (`IpcEvents` renderer→main, `IpcRendererEvents` main→renderer).

Server-side, `WsHandler` keeps a `persistentSessions` map keyed by `sessionId` from the client so managers and sandbox containers **survive WS reconnections and React remounts** — if you're adding a manager that holds long-lived state, wire it into `wireGlobalHandlers` (shared across clients) or `wireClientManagers` (per-session) in `src/server/managers.ts`.

### Shared IPC handlers

`src/shared/ipc-handlers.ts` registers channels that behave identically under Electron and server mode (`config:*`, `util:*`, `skills:*`). Both entry points pass in an `IIpcListener` adapter plus a `fetchFn` and `launcherVersion` so the module has no Electron imports. Electron-specific handlers (dialogs, shell, window) stay in `src/main/index.ts`.

### Main-process managers

Lifecycle pattern: each manager is a factory returning `[instance, cleanup]`. Registered from `src/main/index.ts` (Electron) and `src/server/managers.ts` (server). Key ones:

- `MainProcessManager` (`main-process-manager.ts`) — Electron window + store IPC
- `ProcessManager` (`process-manager.ts`) — all agent processes (chat + code tabs) keyed by string ID, driven by `AgentProcess` (`agent-process.ts`); optionally delegates to a `PlatformClient` in enterprise mode
- `ProjectManager` (`project-manager.ts`) — projects / tickets / pages / inbox / milestones; composes `InboxManager`, `MilestoneManager`, `PageManager`, `SupervisorOrchestrator`, and the `ticket-machine`. Runs schema migrations on boot.
- `OmniInstallManager` — Python + venv via bundled `uv` binary
- `ConsoleManager` — PTY terminal (node-pty)
- `WorkspaceSyncManager`, `ExtensionManager`, `AppControlManager`

Managers expose a timestamped `getStatus()` and broadcast updates via `sendToWindow` (Electron) / `sendToAll` (server). Store changes fan out on the `store:changed` channel.

### XState machines (shared)

`src/shared/machines/` holds pure XState v5 definitions used by the renderer — `chat-session`, `chat-boot`, `rpc-client`, `page-editor`, `terminal-tab`, `auto-launch`. They have no React, IPC, or DOM imports, and reuse pure helpers from `src/lib/` (e.g. `session-filter`). When adding chat/session state, extend the machine rather than adding side-channel React state.

### Renderer structure

- `src/renderer/features/` — feature modules; each owns its components + a `state.ts` (nanostores atom bundle). Current features: `AppControl`, `Auth`, `Banner`, `Chat`, `Code`, `Console`, `Dashboards`, `Inbox`, `Initiatives`, `Notebooks`, `Omni`, `Onboarding`, `Pages`, `Projects`, `SettingsModal`, `Tickets`, `Toast`, `WorkspaceSync`, `XTermLogViewer`.
- `src/renderer/ds/` — design system primitives (Fluent + Radix + custom)
- `src/renderer/services/` — cross-cutting: `ipc`, `store` (mirrors main-process store into an atom), `status` (polls `main-process:get-status`), `navigation`, `agent-process`, `config`, `dev`
- `src/renderer/common/` — shared UI (webview, layouts)
- `src/renderer/transport/` — Electron and WS transport adapters

### Extensions

`src/main/extensions/` ships built-in extension manifests (currently Marimo). The registry (`registry.ts`) is built-in only today but the manifest contract is the same one that will load user-installed extensions from `~/.omni/extensions/` later.

### Sandbox binary

`omni-sandbox` is a Rust binary built from a sibling `sandbox-cli/` repo by `scripts/download-sandbox.mjs` during `postinstall`. If Rust is missing, the download is skipped with a warning — run `npm run build:sandbox` later. On Linux, `bubblewrap` is also required at runtime.

### Enterprise / platform mode

`OMNI_PLATFORM_URL` is read at build time (`electron.vite.config.ts`, `vite.browser.config.ts`, `vite.server.config.ts`) and inlined as `__PLATFORM_URL__`. When set, `ProcessManager.platformClient` is populated and sandbox operations can be delegated to a remote management plane. Open-source builds leave it empty and everything runs locally.

### Artifacts protocol

Electron registers a privileged `artifact:` scheme before `app.ready` (`src/main/index.ts`). The handler serves agent-generated files with a strict CSP that blocks script execution — `bypassCSP` is intentionally **not** set. If you extend the artifact pipeline, don't loosen the response headers.

## Conventions

- **Path aliases**: always `@/…` (tsconfig `baseUrl=.`, `paths: { "@/*": ["src/*"] }`); never relative imports across top-level dirs
- **Store atoms**: `$`-prefixed nanostores (e.g. `$store`, `$mainProcessStatus`)
- **Result type**: `src/lib/result.ts` — prefer returning `Result<T, E>` over throwing across boundaries
- **Types**: strict TS, `noUncheckedIndexedAccess`, `noImplicitAny`, `isolatedModules`
- **Imports**: sorted by `eslint-plugin-simple-import-sort`; `react/jsx-curly-brace-presence` forbids unnecessary braces; `react/jsx-no-bind` allows `.bind` but not arrows in JSX attributes (check the rule — `allowBind: true`)
- **Circular deps**: `dpdm` runs on `main/index.ts`, `renderer/index.ts`, `preload/index.ts` with `--exit-code circular:1` — circular imports will fail lint

## Build / packaging notes

- `electron-builder.config.ts` disables dangerous Electron fuses (`runAsNode: false`, `enableNodeCliInspectArguments: false`, ASAR integrity, etc.) — don't re-enable without a strong reason
- Windows builds need VC++ redist; `scripts/download-vcredist.mjs` pulls it and `scripts/vcredist.nsh` bundles it into the NSIS installer
- Code signing: see `CODESIGN.md`. Local dev should set `CSC_IDENTITY_AUTO_DISCOVERY=false` in `.env` (see `.env.sample`) to stop electron-builder from grabbing a keychain cert

## Testing

- Vitest with jsdom. Tests colocated as `*.test.ts(x)`. Coverage via `@vitest/coverage-v8`.
- `vitest.config.ts` aliases `electron` → `src/server/electron-shim.ts` so main-process modules import cleanly without an Electron runtime.
- There is no separate integration test suite — unit tests exercise managers directly through the shim.
