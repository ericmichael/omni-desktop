# Repository Guidelines

## Project Structure & Module Organization
- `src/main/`: Electron **main** process (app lifecycle, installation logic).
- `src/renderer/`: React UI for the launcher.
- `src/preload/`: Preload scripts bridging renderer ↔ main.
- `src/shared/`: Shared types/utilities used across processes.
- `src/lib/`: Reusable utilities with co-located unit tests (`*.test.ts`).
- `assets/`: Bundled resources (icons, downloaded `uv` binary under `assets/bin/`).
- Build output: `out/` and `dist/` (generated; cleaned via `npm run clean`).

## Build, Test, and Development Commands
- `npm i`: install dependencies (Node **22+**).
- `npm run download <linux|win|mac>`: fetch the `uv` binary into `assets/bin/` (required for dev/build).
- `npm run dev`: run Electron in development with hot reload.
- `npm run build`: build via `electron-vite`.
- `npm run package`: local packaging with `electron-builder` (no publish).
- `npm test`: run unit tests (rebuilds `node-pty` first).
- `npm run lint`: run all checks (ESLint, Prettier, TypeScript, knip, dpdm).
- `npm run fix`: auto-fix lint + format.

## Coding Style & Naming Conventions
- TypeScript/React. Use 2-space indentation.
- Prefer `type` imports (`import type { ... }`).
- Unused variables must be prefixed with `_`.
- Keep imports sorted (enforced by `simple-import-sort`).
- Follow ESLint restrictions (e.g., avoid `crypto.randomUUID`; prefer project helpers/hooks).

## Testing Guidelines
- Framework: **Vitest** (`vitest.config.ts`, `jsdom` environment).
- Name tests `*.test.ts` and keep them near the code (see `src/lib/`).
- Run locally: `npm test` or `npm run test:no-watch`.

## Commit & Pull Request Guidelines
- Commit messages use Conventional Commit style (e.g., `chore: ...`; see `npm version --message "chore: bump version to v%s"`).
- PRs should include: clear description, rationale, and any UI screenshots for renderer changes.
- Link related issues and note platform-specific behavior (Windows/macOS/Linux) when relevant.

## Security & Configuration Tips
- `uv` is an executable: verify download integrity and (macOS) remove quarantine if needed:
  - `xattr -d 'com.apple.quarantine' assets/bin/uv`
