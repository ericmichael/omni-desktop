# Laptop-as-Sandbox: Corrected Implementation Plan

Supersedes `docs/computer-as-sandbox-plan.md`, which is built on the wrong
layer (it relocates `omni serve` onto the laptop). This is the decision-complete
spec, grounded in the actual lifecycle code (citations inline). The agent stays
in the cloud; the laptop becomes a **sandbox backend**.

## The model (verified)

Agent and sandbox are orthogonal. In the SDK (`agents.sandbox`):

- `SandboxAgent` (the loop, model calls, capabilities) + session storage live in
  `omni serve`.
- `BaseSandboxClient` → `BaseSandboxSession` is the only thing that touches the
  execution environment. The agent calls a small surface:
  `_exec_internal`, `read`/`write`, `persist_workspace`/`hydrate_workspace`,
  `pty_exec_start`/`pty_write_stdin`/`pty_terminate_all`, `_resolve_exposed_port`,
  lifecycle `_ensure_backend_started`/`_shutdown_backend`
  (`agents/sandbox/session/base_sandbox_session.py`).

Providers register by `client.type` in `omniagents/core/sandbox/factory.py`
(`_CLIENT_BUILDERS`). `e2b`/`modal`/`daytona`/`aci` are all **remote** — the
agent stays put and only exec/fs cross the wire. `aci.py` is the exact template:
`AciSandboxSession` reduces everything to an exec channel
(`_exec_internal`=exec, `read`=cat, `write`=base64 heredoc, `persist`=tar) and
drives a remote container; `omni serve` never moves.

### How ACI runs today (the template, verified)

1. Launcher writes `<config>/sandbox/aci.yml` with `client.type: aci` + image +
   `services` + `exposed_ports` (`src/main/aci-profile.ts`).
2. `resolveMode('aci')` → `serve` (it's not `'platform'`/`computeClients`), so
   `ProcessManager` spawns **`omni serve --profile aci.yml`** in the **cloud
   container** (`agent-process.ts` `startServeSession`). Confirmed by ACI working
   in production.
3. `omni serve` (`serve_cli.py`): `_build_sandbox` → `build_sandbox_client(profile.raw)`
   builds `AciSandboxClient`; `_create_or_resume_session` → `client.create()`
   provisions the remote container; `session.start()` applies manifest;
   `_start_services` + `_resolve_service_urls` start/expose services.
4. Readiness payload: `ws_url = ws://{host}:{port}/ws` is **omni-serve's own
   port** (`serve_cli.py:1179`); `services` = `ctx.service_urls`
   (`serve_cli.py:822`). The renderer connects to **cloud omni-serve** via the
   normal `/proxy/code-<id>-*` rewrite — _not_ to the ACI container.

**Laptop is identical except `client.type: host_bridge` and the sandbox backend
is the user's laptop.** Renderer→cloud-omni-serve is unchanged. No agent tunnel.

## Why the old approach is wrong (verified)

`RemoteElectronComputeClient` + `compute-reverse-handlers` spawn `omni serve`
**on the laptop**, dragging `PgSessionStorage`, model keys, runtime token, and
materialized config onto a machine that can't resolve the VNet-private Postgres
(`failed to resolve host omni-pg-…`; PG is `delegatedSubnetResourceId` +
private DNS, `infra/main.bicep:557-561`). That DNS failure is the architecture
rejecting the design.

## Architecture

```
┌── cloud container ─────────────────────────────────────────────┐
│ launcher (server mode, Fastify+WS, machine-registry WS) ◀───────┼─ outbound ─ laptop Electron
│   • ProcessManager: local:<id> → serve spawn (host_bridge profile)│           • exec agent =
│   • /proxy/local/<machineId>/<sessionId>/<port>/*  (relay) ───────┼──┐          real unix_local
│ omni serve (child, SAME container)                              │  │          SandboxSession
│   • SandboxAgent + PgSessionStorage + model keys (cloud)        │  │          over a WS
│   • HostBridgeSandboxClient → HostBridgeSandboxSession ─────────┼──┤          • laptop FS/procs
│       _exec/read/write/pty/resolve_port  ─ proxies to laptop    │  │
└──────────────────────────────────────────────────────────────────┘  │
   exec/fs/pty:  omni serve ──(loopback WS to launcher)──▶ relay ──(reverse machine-registry WS)──▶ laptop exec agent
```

`omni serve` runs in the **same container** as the launcher (proven: ACI works),
so it reaches the launcher on loopback. The launcher already holds the laptop's
outbound WS. The only NAT-crossing hop already exists.

## Transport: reuse `/proxy/local` (verified reusable)

The exec channel and exposed-port preview both ride the relay already built
(`src/server/local-tunnel-proxy.ts` + `src/main/tunnel-handler.ts`):

- `omni serve`'s `HostBridgeSandboxSession` dials
  `ws://127.0.0.1:<launcherPort>/proxy/local/<machineId>/<sessionId>/<execPort>/...`.
- The relay's `handleWs` opens a `compute:tunnel-ws-open` to the laptop, whose
  `tunnel-handler` connects to `127.0.0.1:<execPort>` (the laptop exec agent).
- **Extension required:** the current relay resolves one base URL per
  `(machineId, sessionId)` (`sessionBaseUrls`, `local-tunnel-proxy.ts:43`). It
  must carry a **port** segment so the exec channel and each exposed service
  (code-server 8080, vnc 6080, dev servers) route to distinct laptop ports.

So the `/proxy/local` work already done is **not wasted** — it moves from "agent
UI transport" (wrong) to "exec channel + exposed-port relay" (right), plus a
per-port routing extension.

## New / changed components

### 1. omniagents — `host_bridge` provider (new `core/sandbox/host_bridge.py`)

`HostBridgeSandboxSession(BaseSandboxSession)` is a **remote proxy to a real
`unix_local` session running on the laptop**. It does NOT materialize locally:

- `_ensure_backend_started` / `start` → tell the laptop exec agent to
  `create()`+`start()` an `ExtendedUnixLocalSandboxClient` session with the
  (serialized) manifest + options. **Manifest application happens on the laptop**
  — this is mandatory because seed entries are `PermissiveLocalDir(src=Path(path))`
  read from the _session host's_ filesystem (`serve_cli.py:301-305`), and those
  paths exist on the laptop, not the cloud.
- `_exec_internal`, `read`, `write`, `pty_*`, `_resolve_exposed_port` → forward
  to the laptop session, return results.
- `persist_workspace`/`hydrate_workspace` → effectively noop (see Snapshots).
- `_shutdown_backend`/`stop` → close the channel; laptop workspace persists.
- `HostBridgeSandboxClient(BaseSandboxClient)`: `create`/`resume`/`delete` +
  `deserialize_session_state`. `create` builds a serializable
  `HostBridgeSandboxSessionState` (endpoint, machineId, sessionId, manifest,
  exposed_ports). `resume` re-dials (laptop workspace durable; nothing to
  re-provision). Register `"host_bridge"` in `factory._CLIENT_BUILDERS`.

### 2. laptop exec agent (launcher) — `omni sandbox-host` (recommended)

A laptop-side process that hosts a real `ExtendedUnixLocalSandboxClient` session
(the laptop already ships the omni venv) and exposes
`exec`/`read`/`write`/`pty_*`/`resolve_exposed_port` + `create`/`start`/`stop`
over a WS on `127.0.0.1:<execPort>`. Reusing the SDK's `unix_local` session
gives correct path policy, runtime helpers, tar semantics, and pty handling for
free, rather than re-implementing an exec loop in TS. Electron main launches it
per session and registers `<execPort>` with the relay.

### 3. launcher (cloud) — relay port extension

Extend `local-tunnel-proxy.ts` so `/proxy/local/:machineId/:sessionId/:port/*`
routes to `127.0.0.1:<port>` on the laptop (today it's a single base per
session). `tunnel-handler.ts` opens the inner WS/HTTP to that port.

### 4. launcher (cloud) — ProcessManager

`local:<machineId>` becomes a **normal serve-mode spawn** with a per-session
`host_bridge` profile:

- `resolveMode('local:<id>')` → `serve` (was `compute`).
- Delete `resolveComputeClient`/`computeClients`/`RemoteElectronComputeClient`.
- Before spawn, write `<config>/sandbox/host-bridge-<sessionId>.yml` with
  `client: { type: host_bridge, endpoint: ws://127.0.0.1:<launcherPort>/proxy/local/<machineId>/<sessionId>/<execPort> }`,
  `manifest.root` = the laptop workspace dir, `services`/`exposed_ports` as
  desired. Pass `--profile` that file. Pass `--workspace <laptop path>`.
  **Do not pass cloud-fs `--source` local seeds** — the laptop dir already holds
  the files (symmetry with `host`/`unix_local`, which seed nothing).

### 5. omni-code — one-line snapshot change

`_build_snapshot` already returns noop for `unix_local` ("the workspace IS a host
directory; persist/hydrate would just tar the host dir… pure overhead",
`serve_cli.py:376-380`). Add `host_bridge` to that noop branch — the laptop
workspace is durable, so no tar and **no upload to the cloud** (this is the
privacy guarantee, and it falls out for free). This is the only omni-code change.

## Services / exposed ports (verified)

`_start_services` runs each service via the session (→ on the laptop for
host_bridge); `_resolve_service_urls` calls `session.resolve_exposed_port(port)`
→ `http://{endpoint.host}:{endpoint.port}` (`serve_cli.py:701-712`). For
host_bridge, `_resolve_exposed_port` returns the laptop-local host:port; the
launcher's proxy-rewriter already rewrites the `services` map
(`proxy-rewriter.rewriteStatusUrls`) — route them through
`/proxy/local/<machineId>/<sessionId>/<port>/…`. The `getProxyPrefix` 4-segment
fix generalizes to the port segment.

## Terminals / PTY (verified)

`serve_cli.py:786` `set_sandbox_session(session)` makes the cloud omni-serve's
`sandbox.*` / `terminal.*` server functions drive the session. So
`terminal.create`/pty flow through `HostBridgeSandboxSession.pty_*` → the laptop
automatically. No separate terminal wiring.

## Snapshots / promote-to-cloud

host_bridge uses a **noop snapshot** (above): the laptop's real folder is the
durable store, nothing is tarred or uploaded. Resume = re-dial; the workspace is
still on disk. "Promote to cloud" becomes: `persist_workspace` once (tar the
laptop dir over the channel) → upload → start a fresh `aci` session restoring it.
This is an explicit, opt-in migration — the only time laptop bytes leave the
laptop.

## Settings / env / privacy (verified win)

The agent runs in the cloud, so model keys, MCP, codex tokens, env, and
`PgSessionStorage` stay in the cloud — the old plan's Q2 env-materialization and
its token-leak risk **disappear entirely**. The laptop only execs against the
user's own files. No cloud secrets reach the laptop; no laptop files reach the
cloud (except opt-in promote).

## Remove (wrong layer)

`remote-electron-compute-client.ts`, the `omni serve`-spawning paths in
`compute-reverse-handlers.ts`, `withLocalSessionId` + `computeLocations` +
compute-client machinery in `process-manager.ts`, and the `agent-process.ts` /
`platform-client.ts` readiness-skip / scheme / `confirmsReadiness` patches.

## Keep / repurpose

`MachineRegistry` + PG `machines` table, machine identity + registration,
Settings → Machines UI, and the `/proxy/local` relay (now: exec channel +
exposed-port preview, with the per-port extension). The `'platform'`→`'compute'`
rename and ConnectCloudCard fixes are independent and stand.

## Resolved (no remaining ambiguity)

- Transport, manifest-on-laptop, snapshot-noop, services-tunneling, pty routing,
  resume, ws_url, source/seeding — all settled above with citations.

## Build-time decisions (small, deferred)

1. Exec-agent framing: one multiplexed WS per session (recommended; matches pty).
2. Whether `omni sandbox-host` is a new CLI subcommand vs an internal entrypoint
   the launcher invokes (recommend subcommand for testability).

## Phases

1. **omniagents `host_bridge` provider** + a stub laptop exec server; unit-test
   exec/read/write/pty/resolve_port + manifest-applied-on-laptop over a loopback
   channel. omni-code 1-line snapshot change.
2. **`omni sandbox-host`** (real unix_local-backed exec agent) + **relay per-port
   extension** + **ProcessManager `local:` → serve+host_bridge profile**.
   End-to-end: pick `local:`, agent in cloud, `ls`/edit/bash on the laptop,
   renderer connects to cloud omni-serve as for ACI.
3. **Exposed-port preview** via `/proxy/local/.../<port>`.
4. **Promote-to-cloud** as a one-shot sandbox-state migration.
5. **Remove** the wrong-layer code; harden + observability.
