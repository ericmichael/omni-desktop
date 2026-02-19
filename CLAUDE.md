# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Electron desktop app ("Omni Code Launcher") that manages Omni Code runtime installation (via `uv` + pip) and Docker-based sandbox lifecycle, with embedded webviews for Omni UI, code-server, and noVNC.

## Commands

```bash
npm run dev            # electron-vite dev --watch (hot reload)
npm run build          # electron-vite build
npm run start          # build + preview
npm run lint           # all checks in parallel (eslint, prettier, tsc, knip, dpdm)
npm run fix            # eslint --fix + prettier --write
npm test               # vitest (watch mode, rebuilds node-pty first)
npm run test:no-watch  # vitest single run
npm run download linux # download uv binary to assets/bin/ (required before dev)
npm run rebuild        # rebuild node-pty for Electron (runs automatically on postinstall)
```

## Architecture

**Three Electron processes:**

- **Main** (`src/main/`): Node.js — process management, IPC handlers, OS operations
- **Preload** (`src/preload/`): thin bridge via `@electron-toolkit/preload`
- **Renderer** (`src/renderer/`): React 18 + Vite SWC — all UI

**Shared code:**

- `src/shared/types.ts` — all IPC event type contracts, shared between main and renderer
- `src/lib/` — process-agnostic utilities (command runner, pty helpers, logger, Result type)

### IPC Communication (Fully Typed)

All IPC events are defined in `src/shared/types.ts` using `Namespaced<Prefix, T>`. Two directions:

- **Renderer → Main** (`IpcEvents`): store CRUD, process control, utilities
- **Main → Renderer** (`IpcRendererEvents`): status updates, log output, store changes

Uses `@electron-toolkit/typed-ipc` for type-safe `.handle()`/`.invoke()`/`.send()`/`.on()`.

### Main Process Manager Pattern

Each subsystem is a class (`OmniInstallManager`, `SandboxManager`, `ConsoleManager`) instantiated via factory functions returning `[manager, cleanupFn]`. Cleanup functions run on app quit via `Promise.allSettled`.

### State Management

- **nanostores** atoms as module-level singletons, prefixed with `$` (e.g., `$omniInstallProcessStatus`)
- React reads via `useStore($atom)` from `@nanostores/react`
- Persisted settings use `electron-store` backed through IPC — main emits `store:changed`, renderer syncs its local atom
- Status polling at 1000ms intervals as a reliability fallback alongside push events

### Path Alias

`@/` resolves to `src/` — used everywhere instead of relative imports.

## Code Style Rules (Enforced by ESLint)

- **No relative imports** — always use `@/` alias
- **No inline arrow functions in JSX** — use `useCallback` (`react/jsx-no-bind` is error)
- **`react-hooks/exhaustive-deps`** is error, not warn
- **Type imports required** — use `import type` (consistent-type-imports)
- **Imports auto-sorted** by `simple-import-sort`
- **No `lodash-es`** — use `es-toolkit` instead
- **No `isEqual`** from any source — use `@observ33r/object-equals`
- **No `@ts-ignore` or `@ts-nocheck`** — only `@ts-expect-error` with description (min 10 chars)
- **Renderer cannot import from `@/main/`** and vice versa (ESLint boundary enforcement)
- Prettier: single quotes, 120 char width, trailing commas (es5), semicolons

## Build & Packaging

- `electron-vite` wraps Vite for all three processes; `node-pty` is externalized
- `electron-builder` targets: Windows NSIS, Linux AppImage
- `uv` binary bundled from `assets/bin/` into `resources/bin/` as extra resource
- TypeScript: `strict: true`, `noUncheckedIndexedAccess: true`, `isolatedModules: true`
- Node 22+ required
