# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Omni Code Launcher — an Electron + React desktop app for managing Omni Code installations and sandboxes. Also supports a browser/server mode via WebSocket transport.

## Commands

```bash
npm i                      # Install deps + rebuild native modules (node-pty)
npm run download linux     # Download uv binary (linux|win|mac)
npm run dev                # Electron dev server with hot reload
npm run build              # Build production bundles to out/
npm run package            # Package into dist/ (creates installers)
npm run lint               # ESLint + Prettier + TSC + knip + dpdm
npm run fix                # Auto-fix lint + formatting
npm test                   # Vitest (jsdom environment)
npm run test:ui            # Vitest with UI and coverage

# Browser/server mode (no Electron)
npm run dev:server         # Dev: builds browser + server, runs server
npm run build:server       # Prod: builds both
npm run start:server       # Run server from out/server/index.mjs
```

## Architecture

### Process Model (Electron)

- **Main process** (`src/main/index.ts`): Window creation, IPC handler registration, manager lifecycle
- **Preload** (`src/preload/index.ts`): Exposes Electron API via context bridge
- **Renderer** (`src/renderer/main.tsx`): React SPA

### Transport Abstraction

IPC uses a `TransportEmitter`/`TransportListener` interface (`src/shared/transport.ts`) with two implementations:
- `ElectronTransportEmitter/Listener` (`src/renderer/transport/electron-transport.ts`) — wraps @electron-toolkit/typed-ipc
- `WsTransportEmitter/Listener` (`src/renderer/transport/ws-transport.ts`) — WebSocket for browser mode

`src/renderer/services/ipc.ts` auto-selects the correct transport based on environment. All IPC channel types are defined in `src/shared/types.ts`.

### Manager Pattern (Main Process)

Each major feature has a manager class in `src/main/`:
- `ConsoleManager` — PTY terminal management
- `SandboxManager` — Docker container orchestration
- `ChatManager` — Chat service process
- `OmniInstallManager` — Runtime installation (Python + venv via uv)
- `FleetManager` — Project/task management

Managers expose `getStatus()` returning timestamped status and register IPC handlers.

### State Management

- **Nanostores** atoms (`$store`, `$fleetTasks`, etc.) — lightweight reactive state
- **Persisted store**: electron-store in Electron, file-based in server mode
- **Sync**: Main process broadcasts `store:changed`; renderer syncs its atom

### Renderer Structure

- `src/renderer/features/` — Feature modules (Chat, Fleet, Omni, Console, SettingsModal, etc.) each with collocated `state.ts`, components, and utilities
- `src/renderer/ds/` — Design system components (Button, Switch, Dialog, etc.)
- `src/renderer/services/` — Core services (ipc, store, status polling, config)
- `src/renderer/common/` — Shared UI components (Webview, layouts)
- Layout modes: `chat`, `fleet`, `work`, `code`, `desktop` — routed in `MainContent.tsx`

### Fleet System

Projects → Tickets → Phases → Tasks data model. State stored in electron-store. Includes a kanban board (dnd-kit), AI task loop (`fleet-loop.ts`), and YAML plan file sync.

## Code Conventions

- **Path aliases**: Use `@/` imports (e.g., `import '@/main/util'`), never relative imports
- **Type imports**: Separate with `import type { Foo }`
- **Store atoms**: `$`-prefixed (e.g., `$store`, `$initialized`)
- **Error handling**: Custom `Result<T, E>` type in `src/lib/result.ts`; `OkStatus | ErrorStatus` for process states
- **Boundary enforcement**: ESLint prevents `@/main` imports in renderer and vice versa
- **Formatting**: Prettier with 120 char width, single quotes, trailing commas (es5), 2-space indent
- **TypeScript**: Strict mode, `noImplicitAny`, ESNext target

## Build System

- `electron-vite` for Electron builds (main + preload + renderer)
- `vite.browser.config.ts` for browser-only SPA build (shims Electron APIs)
- `vite.server.config.ts` for Fastify server build (Node 22 target)
- `electron-builder` for packaging (DMG/NSIS/AppImage)
- `node-pty` is a native module — externalized from bundles

## Testing

- Vitest with jsdom, tests in `src/lib/*.test.ts`
- Run a single test: `npx vitest run src/lib/result.test.ts`
