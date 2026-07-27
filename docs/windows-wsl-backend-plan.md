# Windows: WSL backend + native frontend

## Problem

The launcher needs Docker for AI sandboxes. On Windows the natural place for
Docker is WSL2, but running the whole Electron app inside WSL gives a degraded
UI (WSLg rendering bugs, blurry fractional scaling, broken tray/dialogs).
Running the whole app on native Windows means Docker-over-named-pipe plus
`/mnt/c` bind-mount performance and path-translation pain inside every sandbox.

The fix is a split install: the **frontend runs as a native Windows Electron
app**, the **backend runs as a daemon inside WSL** where Docker, the sandboxes,
node-pty, and the agent processes are all Linux-native.

## What already exists (do not rebuild)

Nearly all of the architecture is already shipped for cloud mode:

- **The daemon already exists.** The server build (`src/server/index.ts`,
  Fastify + WS, built by `vite.server.config.ts` into `out/server/index.mjs`)
  runs every manager behind Electron shims. Terminals work remotely
  (`ConsoleManager` proxies PTYs over WS; the PTY lives server-side).
  `WsHandler.persistentSessions` already keeps managers + sandboxes alive
  across renderer reconnects.
- **The remote-Electron shell already exists.** Cloud-linked mode
  (`src/renderer/services/ipc.ts:92-106`) renders natively in Electron while
  routing app transport over `WsTransportEmitter` to a remote launcher, with a
  separate `localEmitter` for genuinely-local channels (dialogs, shell, window,
  updater, link management).
- **Auth machinery already exists.** `/api/ws-token` mints HMAC tokens signed
  with `OMNI_RUNTIME_TOKEN_SECRET` (`src/server/runtime-token.ts` —
  `signRuntimeToken` / `verifyRuntimeToken` are plain-crypto shared code,
  importable from Electron main).

What this plan adds is: a second link kind that skips Entra, a WSL daemon
lifecycle manager in Electron main, payload packaging, path translation for
pickers, and onboarding UI.

## Decisions (settled — do not reopen during implementation)

1. **Reuse the cloud-link transport path.** No new transport. The WSL backend
   is a second variant of "Electron linked to a remote launcher over WS".
2. **`cloudMode` becomes a discriminated union, renamed in lockstep.** Store
   key `cloudMode: CloudMode | null` → `remoteBackend: RemoteBackend | null`
   where `RemoteBackend = CloudBackend | WslBackend` (`kind: 'cloud' | 'wsl'`).
   All read/write sites change in the same PR; no legacy alias, no migration
   shim (existing `cloudMode` values are dropped — cloud users relink once).
3. **Electron main owns the daemon lifecycle (v1).** The daemon is a child
   process of the Windows app (`wsl.exe -d <distro> -- ...`), started at app
   boot, killed at app quit. This matches current local-Electron semantics
   (closing the app stops agents). A persistent systemd-unit mode is a
   designed-for follow-up, not v1.
4. **Auth = shared secret, not network trust.** Main generates a random secret
   per boot, passes it to the daemon as `OMNI_RUNTIME_TOKEN_SECRET`, and mints
   its own WS tokens with `signRuntimeToken`. No `/api/ws-token` fetch, no
   `OMNI_TRUSTED_CIDRS`, and immunity to the WSL2 NAT gotcha (Windows→WSL
   traffic arrives from the vNIC gateway IP, not loopback, so the loopback
   allowlist can't be relied on; mirrored mode differs per machine).
5. **Payload ships inside the Windows installer** (`extraResources`), built by
   a Linux CI job: `out/server` + `out/browser` + prebuilt linux-x64
   `node_modules` for the five server externals + a pinned Node linux-x64
   runtime tarball. Fully offline provisioning, daemon version always in
   lockstep with the renderer.
6. **Onboarding happens in-app, not in NSIS.** The installer is unchanged
   except for the payload. First-run detection of WSL and the "run backend in
   WSL?" choice live in the renderer where they're testable and re-runnable.
7. **New projects default to the WSL-native filesystem** (`~/...` inside the
   distro). Windows paths picked via native dialogs are translated
   (`C:\foo` → `/mnt/c/foo`) and usable, with a perf note in the UI —
   `/mnt/c` bind mounts into Docker are slow.
8. **Data migration from an existing Windows-local install is out of scope.**
   Switching to WSL mode starts a fresh backend data root inside the distro.
   Documented in the settings card copy.

## Architecture after the change

```
Windows                                        WSL2 distro
┌────────────────────────────┐                ┌─────────────────────────────┐
│ Electron shell             │                │ omni daemon                 │
│  renderer (native UI)      │   WS + HTTP    │  out/server/index.mjs       │
│  emitter ──────────────────┼───────────────▶│  Fastify :<port>            │
│  localEmitter → local main │ localhost:port │  managers / projects DB     │
│                            │                │  node-pty terminals         │
│ main:                      │                │  Docker sandboxes           │
│  WslBackendManager         │                │                             │
│   spawn/health/provision ──┼── wsl.exe ────▶│  (child of wsl.exe)         │
│   mints WS tokens (HMAC)   │  shared secret │  verifies same secret       │
│  dialogs/shell/window/     │                │                             │
│  updater stay local        │                └─────────────────────────────┘
└────────────────────────────┘
```

## Phase 1 — Generalize the link: `remoteBackend` union

Types (`src/shared/types.ts`):

```ts
export type CloudBackend = {
  kind: 'cloud';
  url: string;
  tenantId: string;
  clientId: string;
  account: CloudAccount;
};

export type WslBackend = {
  kind: 'wsl';
  /** WSL distro name as reported by `wsl.exe -l -q`. */
  distro: string;
  /** Last port the daemon was reachable on (informational; re-picked each boot). */
  port: number;
};

export type RemoteBackend = CloudBackend | WslBackend;
```

Lockstep rename of every `cloudMode` touchpoint:

- `StoreData.cloudMode` → `StoreData.remoteBackend` (`src/shared/types.ts:369`).
- Preload bootstrap (`src/preload/index.ts`, `src/main/main-process-manager.ts:120-136`):
  arg becomes `--omni-remote-backend=...`. **Also add `platform: process.platform`
  to `__omniBootstrap`** — the renderer currently has no OS detection and the
  WSL card must be Windows-only. For the `wsl` kind, main resolves the live URL
  (`http://127.0.0.1:<port>`) _before_ window creation and injects a resolved
  `{ kind: 'wsl', url }` bootstrap shape so `serverOrigin()` keeps working
  unchanged.
- `src/renderer/services/ipc.ts`: `isCloudLinked` → `remoteKind: 'cloud' | 'wsl' | null`
  (keep an `isCloudLinked = remoteKind === 'cloud'` export only if the
  cloud-only call sites below don't collapse naturally). Transport
  construction branches on kind for `getWsToken`:
  - `cloud` → existing `cloud:get-ws-token` main invoke.
  - `wsl` → new `wsl:get-ws-token` main invoke; main signs
    `signRuntimeToken(secret, { tenantId: DEFAULT_TENANT, sessionId })`
    locally — no HTTP fetch at all.
- Gate cloud-only behavior on `kind === 'cloud'`: machine registration
  (`src/renderer/services/machines.ts`), compute reverse-RPC / host-bridge
  (`src/renderer/services/compute.ts`), tunnel bridge
  (`src/renderer/services/tunnel-bridge.ts`). None of these apply to a WSL
  backend — the sandbox host _is_ the backend.
- Main IPC: `cloud:link`/`cloud:unlink`/`cloud:status` keep their names but
  read/write the union; add `wsl:*` channels (Phase 2). `cloud:unlink` becomes
  the shared "disconnect + relaunch" path for both kinds
  (`restartAfterCloudModeChange` at `src/main/index.ts:915` is reused as-is).

Check `src/shared/types.ts` channel lists for existing ids before adding any
new channel names.

## Phase 2 — `WslBackendManager` (new, `src/main/wsl-backend.ts`)

Factory returning `[instance, cleanup]` like every other manager, registered
from `src/main/index.ts`, Windows-only, active only when
`store.remoteBackend?.kind === 'wsl'`. Exposes timestamped `getStatus()`
surfaced through `main-process:get-status` like other managers.

Responsibilities, in boot order:

1. **Detect WSL.** `wsl.exe --status` and `wsl.exe -l -q`. ⚠️ `wsl.exe`
   emits UTF-16LE with NUL bytes — decode with `utf16le`, strip `\r` and
   NULs, before parsing distro names. Unit-test the parser against captured
   real output.
2. **Provision the payload.** Payload = single `omni-wsl-payload.tar.gz` from
   `process.resourcesPath`. Stream it into the distro via
   `wsl.exe -d <distro> -- sh -c 'mkdir -p ~/.omni/launcher && tar xzf - -C ~/.omni/launcher'`
   writing the tarball to the child's stdin (one transfer; avoids thousands of
   small-file writes over `\\wsl$` 9P). Payload contents:
   - `server/` (`out/server`), `browser/` (`out/browser`)
   - `node_modules/` — linux-x64 builds of the five server externals
     (`node-pty`, `ws`, `@fastify/websocket`, `bufferutil`, `utf-8-validate`),
     produced by a Linux CI step against the pinned Node version (node-pty has
     no prebuilds; do not compile inside the user's distro)
   - `node/` — pinned Node LTS linux-x64 runtime (unpacked official tarball)
   - `VERSION` — the launcher version string
     Provisioning runs only when `VERSION` inside the distro ≠ `launcherVersion`
     (this is also the entire update story — see Phase 6).
3. **Reap stale daemons.** Pidfile at `~/.omni/launcher/daemon.pid` inside the
   distro; on boot, `wsl.exe -d <distro> -- sh -c 'kill $(cat ...) 2>/dev/null'`
   before spawning. A daemon from a crashed previous app holds an unknown
   secret and a port — always replace it.
4. **Spawn.** Pick a free port (bind-probe on the Windows side — WSL2
   localhost forwarding maps them 1:1), generate a 32-byte random secret, then:
   ```
   wsl.exe -d <distro> -- env \
     OMNI_RUNTIME_TOKEN_SECRET=<secret> PORT=<port> HOST=127.0.0.1 \
     ~/.omni/launcher/node/bin/node ~/.omni/launcher/server/index.mjs
   ```
   Keep it as a tracked child process; killing `wsl.exe` terminates the Linux
   process. Kill on `app.quit`.
5. **Health-check.** Add `GET /api/health` → `{ ok: true, version }` to
   `src/server/index.ts` (verified: does not exist today). Poll until healthy
   before creating the BrowserWindow; restart with capped backoff on exit;
   after N failures set status `error` with the captured stderr tail so the
   settings card can show it.
6. **Environment checks.** `docker info` inside the distro. Failure is
   non-fatal: daemon still boots, status carries
   `docker: 'ok' | 'missing' | 'daemon-down'` and the UI shows guidance
   (enable Docker Desktop WSL integration for this distro, or install
   docker-ce). Same pattern for `bwrap` if host-mode sandboxes matter later —
   v1 only checks Docker.
7. **Token minting.** Handle `wsl:get-ws-token` by signing with the per-boot
   secret. TTL default (12h) is fine; `WsTransportEmitter` refetches on
   reconnect.

New IPC channels (all resolved in local main, invoked via `localEmitter`):
`wsl:detect` (distro list + wsl/docker status), `wsl:link` (distro →
provisions, persists `remoteBackend`, relaunches), `wsl:get-ws-token`,
`wsl:status`.

Window sequencing in `src/main/index.ts`: when `remoteBackend.kind === 'wsl'`,
run provision→spawn→health _before_ `MainProcessManager` creates the window,
so the bootstrap URL is live. Show a splash/`loading` state if provisioning is
slow (first boot unpacks the runtime; expect ~10–20s).

## Phase 3 — Settings + onboarding UI

- Rename/extend `ConnectCloudCard` → `RemoteBackendCard`
  (`src/renderer/features/SettingsModal/`): three states — local (default),
  cloud-linked (existing flow untouched), WSL-linked. The WSL section renders
  only when `bootstrap.platform === 'win32' && isElectron`: distro dropdown
  (from `wsl:detect`), Connect/Disconnect via `localEmitter`, live daemon +
  Docker status from `wsl:status`, and the fresh-data-root note (Decision 8).
- Onboarding (`src/renderer/features/Onboarding/`): on first run on Windows,
  if `wsl:detect` finds a healthy WSL2 + no `remoteBackend`, offer
  "Run the Omni backend in WSL (recommended)" vs "Run everything on Windows".
  Skippable; re-entrant from Settings later.
- `MachineIdentityChip` stays cloud-only.

## Phase 4 — Path translation at the picker boundary

Native dialogs (`dialog:*` in local main) return Windows paths; the daemon
needs Linux paths. Fix at the single write chokepoint, not in consumers:

- New pure helper `src/lib/wsl-path.ts`: `winToWslPath('C:\\Users\\x') →
'/mnt/c/Users/x'` (drive-letter lowercase, backslash flip, UNC `\\wsl$\<distro>\...`
  → native path passthrough). Colocated unit tests.
- In local main's dialog handlers, when `remoteBackend.kind === 'wsl'`,
  translate before returning to the renderer. The renderer and daemon only
  ever see Linux paths — no consumer-side fallbacks.
- Default directories (new-project pickers, workspace roots) come from the
  daemon in WSL mode and therefore are already WSL-native; picker-translated
  `/mnt/c/...` paths remain allowed.

## Phase 5 — Build + packaging

- **Linux CI job** (`payload` step): pin Node version in one place (reuse for
  runtime tarball + native-module ABI), `npm ci` the five externals, assemble
  `omni-wsl-payload.tar.gz`, upload as a build artifact.
- **Windows package step**: `electron-builder.config.ts` adds the payload via
  `extraResources` (Windows target only), same pattern as the vcredist
  download (`scripts/download-vcredist.mjs`) — a `scripts/download-wsl-payload.mjs`
  that pulls the artifact (or builds it locally under WSL for dev).
  NSIS config otherwise unchanged.
- Size cost: ~40–60 MB compressed (Node runtime dominates). Accepted for
  offline determinism (Decision 5).

## Phase 6 — Updates

No new mechanism. electron-updater updates the Windows app; on next boot the
`VERSION` stamp mismatches and `WslBackendManager` re-provisions before
spawning. Renderer and daemon can never skew for more than the provisioning
step. Daemon data (`~/.config/Omni Code/config.json`, projects SQLite) lives
outside the payload dir and survives re-provisioning.

## Testing

Unit (colocated, vitest — runs on Linux/mac dev machines without WSL):

- `wsl-path.test.ts` — translation matrix incl. UNC, spaces, trailing slashes.
- `wsl-backend.test.ts` — UTF-16LE `wsl.exe -l -q` output parsing (fixtures
  from real captures), VERSION-stamp provisioning decision, backoff/restart
  state machine (spawn injected as a fake).
- Token round-trip: main-side minting verified with `verifyRuntimeToken`
  (both sides already share `src/server/runtime-token.ts`).
- `ws-handler` token-auth tests already exist; extend only if the claims
  shape changes (it doesn't — `DEFAULT_TENANT` single-tenant path).

Manual e2e matrix (Windows 11 VM, before release): fresh install + onboarding;
NAT and mirrored WSL networking; Docker Desktop integration on/off;
app-quit → daemon gone; kill daemon → auto-restart; updater upgrade →
re-provision; VPN active (known localhost-forwarding breaker — verify the
error surfaces usefully rather than hanging).

Lint note: main importing `@/server/runtime-token` is fine (it only pulls
`@/lib/uuid` + node crypto) but run `dpdm` early — it gates circular imports.

## Risks / known sharp edges

- **WSL2 localhost forwarding can break under VPNs** (NAT mode). v1 answer:
  detect health-check failure and show a targeted error ("WSL networking
  unreachable — check VPN / try mirrored networking"). Fallback transport to
  the distro's eth0 IP is a follow-up if reports warrant it.
- **Windows sleep/resume** drops the WS; `WsTransportEmitter` already
  reconnects and `persistentSessions` preserves state. Verify in the manual
  matrix, don't rebuild.
- **First-boot latency** (payload unpack): mitigated by splash status; do not
  provision lazily mid-session.
- **`wsl.exe` output encoding** (UTF-16LE) — the classic silent parser bug;
  covered by fixture tests.
- **Two data worlds** (Windows-local vs WSL): explicit non-goal to merge in
  v1 (Decision 8); the settings card says so.

## Follow-ups (explicitly not v1)

- **Persistent daemon**: systemd user unit inside the distro (WSL supports
  systemd) + persisted secret in `safeStorage`, so agents keep running with
  the UI closed. The v1 boundary (`WslBackendManager` owns spawn/health) is
  the only file that changes.
- **Generic "connect to my own server"**: the `wsl` token flow minus
  `wsl.exe` — lets mac/Linux users link the desktop shell to a homelab
  server-mode instance. Most of Phase 1 already pays for this.
- **Distro provisioning**: `wsl --install`-driven setup for machines with no
  WSL at all (installer currently assumes an existing distro).
