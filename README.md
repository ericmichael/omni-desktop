# Omni Code Launcher

A desktop application for managing [Omni Code](https://github.com/ericmichael/omni-code) installations and sandboxes on Windows, macOS (Apple Silicon) and Linux.

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

Download the latest release from [GitHub Releases](https://github.com/ericmichael/omni-desktop/releases).

### Usage

1. Open the launcher and click **Install** to set up the Omni Code runtime
2. Select a **workspace directory** for your project
3. Optionally select an **env file** and toggle code-server / desktop / Dockerfile.work
4. Click **Start Sandbox** to launch

## Development

### Prerequisites

- **Node 22+** and npm
- **Rust** (for building the `omni-sandbox` binary) — install via [rustup](https://rustup.rs):
  ```sh
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
- **Docker** (for sandbox functionality)
- **bubblewrap** (Linux only, for process sandboxing):
  ```sh
  sudo apt-get install bubblewrap   # Debian/Ubuntu
  sudo pacman -S bubblewrap         # Arch
  ```

### Quick Start

```sh
git clone https://github.com/ericmichael/omni-desktop.git
cd omni-desktop
npm i
npm run dev
```

`npm install` automatically:
1. Rebuilds native modules (`node-pty`)
2. Downloads the `uv` binary for your platform
3. Builds `omni-sandbox` from `sandbox-cli/` (requires Rust)

If Rust is not installed, the sandbox build is skipped with a warning. Install Rust and run `npm run build:sandbox` to build it later.

On macOS, you may need to remove the quarantine flag from downloaded binaries:

```sh
xattr -d 'com.apple.quarantine' assets/bin/uv
```

### Build

```sh
npm run build       # Build production bundles
npm run package     # Package into installers (dist/)
```

### Useful Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Run in development with hot reload |
| `npm run build:sandbox` | Rebuild the sandbox binary |
| `npm run lint` | Run all checks (ESLint, Prettier, TypeScript, knip, dpdm) |
| `npm run fix` | Auto-fix lint + format |
| `npm test` | Run unit tests |

### Code Signing

Local builds may require you to manually allow them to run on Windows and macOS.

On macOS, remove the quarantine flag if the app is rejected:

```sh
xattr -d 'com.apple.quarantine' /Applications/Omni\ Code.app
```

## License

Apache-2.0
