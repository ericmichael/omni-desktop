# Omni Code Launcher

A desktop application for managing [Omni Code](https://github.com/emm/omni-code) installations and sandboxes on Windows, macOS (Apple Silicon) and Linux.

The launcher handles installing the Omni Code runtime, managing Python environments, and launching Docker-based sandboxes with optional code-server and noVNC desktop access.

## Features

- **One-click install** of the Omni Code runtime (Python + venv managed automatically via `uv`)
- **Sandbox management** — launch Docker containers with workspace mounting, env file support, and configurable services
- **Embedded webviews** — access the Omni UI, code-server, and noVNC desktop directly in the launcher with tab/split layouts
- **Dev console** — built-in terminal with automatic venv activation
- **Auto-updates** — the launcher checks for updates on startup

## Requirements

- **Docker** must be installed and running on the host for sandbox functionality
- Node **22+** for development

## Getting Started

### Download

<!-- TODO: Update links when releases are published -->
Download the latest release from [GitHub Releases](https://github.com/emm/omni-code-launcher/releases).

### Usage

1. Open the launcher and click **Install** to set up the Omni Code runtime
2. Select a **workspace directory** for your project
3. Optionally select an **env file** and toggle code-server / desktop / Dockerfile.work
4. Click **Start Sandbox** to launch

## Development

### Dev Environment

This project uses Node 22 and npm.

```sh
npm i
npm run download linux  # or: win, mac
npm run dev
```

### Getting `uv` for local dev

The `uv` binary is required to build or run the launcher in development mode.

```sh
npm run download PLATFORM  # linux | win | mac
```

This downloads `uv` into `assets/bin/`. On macOS, you may need to remove the quarantine flag:

```sh
xattr -d 'com.apple.quarantine' assets/bin/uv
```

### Build

```sh
npm i
npm run build
npm run package
```

### Useful commands

- `npm run dev` — run in development with hot reload
- `npm run lint` — run all checks (ESLint, Prettier, TypeScript, knip, dpdm)
- `npm run fix` — auto-fix lint + format
- `npm test` — run unit tests

### Code Signing

Local builds may require you to manually allow them to run on Windows and macOS.

On macOS, remove the quarantine flag if the app is rejected:

```sh
xattr -d 'com.apple.quarantine' /Applications/Omni\ Code.app
```

## License

Apache-2.0
