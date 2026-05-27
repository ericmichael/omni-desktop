# Plan: Move Launcher Terminal Into the SandboxSession

## North star

Every launcher terminal — whether it lands on a host shell (unix_local) or
inside a docker/e2b/modal/runloop sandbox — flows through one path:
`xterm → launcher main proxy → omni serve WS → omniagents.rpc.TerminalManager
→ SandboxSession PTY primitives → backend`. The launcher main no longer owns
a host node-pty path; the omniagents `TerminalManager` no longer hardcodes
`pty.openpty()`. The SDK gains two real new primitives (`pty_stream_output`,
`pty_resize`); everything else composes around them.

## Decisions made

**SDK ownership.** The SDK (`agents.sandbox`) is installed read-only via mise
— we do not patch it. omniagents already has the established subclass pattern
(`omniagents/core/sandbox/docker_extended.py` subclasses
`DockerSandboxSession` and overrides `_create_container`/`create`). The new
primitives ship as session-method extensions on omniagents-owned subclasses:

- `omniagents/core/sandbox/unix_local_extended.py` — new file;
  `ExtendedUnixLocalSandboxClient(UnixLocalSandboxClient)`,
  `ExtendedUnixLocalSandboxSession(UnixLocalSandboxSession)`. Mirrors the
  `docker_extended.py` structure.
- `omniagents/core/sandbox/docker_extended.py` —
  `ExtendedDockerSandboxSession` gains the new methods.
- Other backends (e2b, modal, runloop, daytona, blaxel, vercel, cloudflare)
  get a no-op `WorkspaceFeatureUnavailable` raise on
  `pty_stream_output`/`pty_resize` from a shared mixin (`PtyStreamMixin`) so
  the terminal route fails loudly on attach rather than silently. They are
  out of scope for this PR.

Upstreaming to `agents.sandbox` is a follow-up the launcher should not wait
for. We do not monkey-patch the SDK classes — same reason `docker_extended.py`
doesn't: properties + late-bound attribute access break monkey patches.

**Where each new primitive lives.**

- `SandboxSession.pty_stream_output(process_id) -> AsyncIterator[bytes]` —
  defined on the omniagents `ExtendedUnixLocalSandboxSession` and
  `ExtendedDockerSandboxSession`, both subclasses of the SDK's
  `SandboxSession` wrapper which already proxies through `_inner`. We do
  **not** wrap through the SDK's `SandboxSession`. Instead `TerminalManager`'s
  `SessionPtyBackend` reaches the inner extended session via `session._inner`
  and gates on `isinstance(session._inner, _PtyStreamingSession)` (a
  protocol/ABC defined in omniagents).
- `SandboxSession.pty_resize(process_id, cols, rows)` — same placement.
- `pty_exec_start` `cols`/`rows` kwargs — added by extending the inner
  session's `pty_exec_start` override on the subclasses. Initial size is
  applied via TIOCSWINSZ (unix_local) or `exec_resize` (docker) right after
  the SDK's call returns, **before** the first byte of output is read. This
  is acceptable because both SDK implementations open the pty with default
  80x24 and the first 250ms of yield_time is empty (shell hasn't drawn yet).

**Streaming protocol (sandbox → omni serve → launcher → xterm).**

- Chunk size: **4096 bytes** (matches SDK's `_PTY_READ_CHUNK_BYTES`; matches
  current `TerminalManager._reader_loop`).
- On-the-wire: keep the existing `/ws/terminal` JSON frame format —
  `{"type":"output","terminal_id":"...","data":"<base64>"}`. base64 stays
  because the existing FastAPI route uses `send_json` and because the
  launcher's renderer state.ts already accepts string output. Don't switch
  to binary frames in this PR; the perf win is real but not load-bearing for
  the architecture move.
- Backpressure: `TerminalManager`'s `Queue[Optional[bytes]]` is **unbounded
  today and stays unbounded**. The interactive shell case can't realistically
  backpressure xterm. For pathological producers (`cat /dev/urandom`), we'll
  add a soft cap of 4 MB total queued bytes per terminal in
  `SessionPtyBackend`'s pump — when exceeded, drop the oldest chunks and
  write a sentinel `[output truncated]\r\n` once. Same predicate the existing
  `truncate_text_by_tokens` already applies upstream.

**Resize debounce.** xterm's `onResize` already fires only when integer
rows/cols change (not per-pixel — `fitAddon` debounces by snapping to char
cells). No extra debounce in the renderer or launcher proxy. Inside
`TerminalManager.resize` we add a 16 ms coalescing guard: if two resize calls
land in the same event loop tick, the second supersedes the first —
implemented as a per-terminal `_pending_resize` task. This matters because
xterm's resize during a drag can fire 5-10 times per second.

**Terminal cwd resolution.** Multi-source projects mount each source at
`/workspace/<mountName>`. The profile's `terminal.cwd` defaults to the
manifest `root` (`/workspace` for devbox, `${workspace_dir}` for host). The
launcher passes an optional `cwd` per terminal create call (today's
`ensureTerminalForTab(tabId, cwd)` payload). Resolution order inside
`omni serve`'s `terminal.create` server function:

1. Explicit `cwd` from the create call (validated to start with the manifest
   root; rejected otherwise with a clear error).
2. Profile's `terminal.cwd` if present.
3. Manifest root.

When the renderer is opening a terminal for a specific source column (column
carries a mountName), it passes `/workspace/<mountName>`. Single-source
projects pass the manifest root and land at `/workspace/<mountName>` by happy
accident — fine.

**Where `terminal.*` registers on omni serve.** As **server functions** on
the `AgentService` via the spec's `register_server_functions` hook. We do
**not** add a new mount point or a new transport. Rationale:

1. The existing web UI already calls `terminal.create` via `serverCall`
   (`omniagents/backends/web/ui/src/components/TerminalPanel.tsx:227`) — the
   same path the launcher will use. One protocol, one auth model.
2. `omniagents/backends/server/app.py:246` already invokes
   `spec.register_server_functions(service)` during `build_app`. `omni serve`
   registers a function there that installs the manager.
3. The existing `/ws/terminal` route in `app.py:352-446` already authorizes
   via `terminal_manager.authorize(...)` and handles input/output/resize/
   close. We don't touch this route. The launcher reuses it.

Concrete wiring in `omni-code/omni_code/serve_cli.py::_serve`: after
`build_app(...)` returns, look up the registered `AgentService` on
`app.state.agent_service` (already exposed at line 243), assign
`service.terminal_manager = TerminalManager(backend=SessionPtyBackend(session,
profile.terminal))`, and register four server functions (`terminal.create`,
`terminal.attach`, `terminal.resize`, `terminal.close`). `terminal.input` is
**not** an RPC method — input flows over the `/ws/terminal` socket as in the
current protocol.

**How the launcher's `ConsoleManager` finds the right agent process.**
`tabId` already keys both the `ProcessManager.processes` map and
(historically) the `ConsoleManager.entries` map. The new `ConsoleManager`
takes a `ProcessManager` reference and does `processManager.getStatus(tabId)`
to retrieve `AgentProcessData.wsUrl`. If the process isn't
`running`/`connecting`, `terminal:create` rejects with a typed
`Result.err({ kind: 'process_not_ready' })`. Standalone "global" terminals
are removed (see the next decision), so there is no case where a terminal
exists without a process.

**Auth + persistence across renderer remounts.**

- The agent WS already has an `auth_token` (omni serve picks one per launch,
  passes it via `?token=` on the WS URL in the readiness payload).
  `omni serve --auth-token` isn't currently set by the launcher
  (`launcher/src/main/agent-process.ts` doesn't add it), and the launcher
  reads `ws_url` already-token-baked. The terminal `/ws/terminal` route
  validates the same token plus per-terminal `terminal_id` + `terminal_token`
  returned by `terminal.create`. This is sufficient — call it out in tests.
- Persistence: the proxy in the launcher main caches
  `{ tabId → Map<terminalId, { token, sessionId, wsConn }> }`. When the
  renderer remounts, `terminal:list` returns the cached entries; renderer
  reuses them. The actual PTY lives in `omni serve`; its lifecycle is bound
  to the session id (`omni serve --session-id <uuid>`). On reconnect
  (launcher restart), the launcher dials `terminal.attach({ session_id,
  terminal_id, token })` — a new server function that returns `{ ws_path }`
  without creating a new PTY. **Decision:** `terminal.attach` replaces
  today's behavior where `terminal.create` always allocates. The renderer
  hands the main process its persisted `{ terminalId, token }` if any; main
  calls `terminal.attach` first and falls back to `terminal.create` on
  `TerminalNotFoundError`. The persisted-on-disk store lives in the
  launcher's existing IPC state file alongside the tab record (no new disk
  format — embed `terminalIds: Array<{ id, token }>` on the existing per-tab
  persisted state).

**Global "terminal column" use case (`scope: 'always'`).** **Removed.**
Justification: (1) the architecture goal is "one code path through
`omni serve`", and the global column violates it. (2) The user can always
open a terminal app inside any tab that has an attached session. The
launcher's app launcher loses one entry; UX impact is small and the user
explicitly wants the best architecture, not the cheapest.

## Sequenced steps

Each step has files touched, new files created, public-API changes, test
coverage, and what breaks if it lands alone. Steps 1–3 land independently
(omniagents and omni-code can ship without launcher changes — they only add
capability). Steps 4–5 must land **together** because the launcher
renderer's `terminal:*` IPC and the launcher main's `ConsoleManager` cross
repository boundaries — see "what breaks if landed alone" notes.

---

### Step 1 — SDK primitives (`pty_stream_output`, `pty_resize`, `cols`/`rows` on `pty_exec_start`)

**Repo:** omniagents

**Files touched / created:**

- New:
  `/home/emm/Omni/Workspace/omniagents/omniagents/core/sandbox/unix_local_extended.py`
  — `ExtendedUnixLocalSandboxClient(UnixLocalSandboxClient)`,
  `ExtendedUnixLocalSandboxSession(UnixLocalSandboxSession)`. Mirrors the
  `docker_extended.py` structure.
- New:
  `/home/emm/Omni/Workspace/omniagents/omniagents/core/sandbox/pty_stream.py`
  — defines `PtyStreamingSession` (Protocol with `pty_stream_output`,
  `pty_resize`, `pty_exec_start_sized`) and a helper
  `coerce_pty_streaming(session) -> Optional[PtyStreamingSession]` that
  returns the inner session if it satisfies the protocol, else `None`.
- Edit:
  `/home/emm/Omni/Workspace/omniagents/omniagents/core/sandbox/docker_extended.py`
  — add `pty_stream_output`, `pty_resize`, sized `pty_exec_start` (see
  below).
- Edit:
  `/home/emm/Omni/Workspace/omniagents/omniagents/core/sandbox/factory.py` —
  `_build_unix_local_client` returns the extended client.

**Implementation detail — `unix_local`:**

- `pty_resize(process_id, cols, rows)`: look up
  `entry = self._pty_processes[process_id]`;
  `primary_fd = entry.primary_fd`;
  `fcntl.ioctl(primary_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows,
  cols, 0, 0))`. Wrapped in `run_in_executor`.
- `pty_stream_output(process_id) -> AsyncIterator[bytes]`: takes a fresh
  consumer that taps `entry.output_chunks` / `entry.output_notify`. The
  existing `_collect_pty_output` polls; we instead
  `while True: await entry.output_notify.wait(); entry.output_notify.clear();
  drain entry.output_chunks; yield each chunk;` until
  `entry.output_closed.is_set()`. We add a per-consumer `asyncio.Queue`
  registered on the entry (`entry.stream_consumers: list[Queue]`) so the
  existing `_pump_pty_primary_fd` fans out to consumers in addition to
  `entry.output_chunks`. The existing `_collect_pty_output` path stays
  intact for the agent's PTY tool, which calls `pty_write_stdin` and reads
  in batches.
- Sized `pty_exec_start`: extend the parent's signature with
  `cols=None, rows=None`. If set and `tty=True`, call
  `_set_winsize(secondary_fd, cols, rows)` before `create_subprocess_exec`.

**Implementation detail — `docker`:**

- `pty_resize(process_id, cols, rows)`: `entry =
  self._pty_processes[process_id]; await loop.run_in_executor(
  _DOCKER_EXECUTOR, lambda: api.exec_resize(entry.exec_id, height=rows,
  width=cols))`. `exec_resize` is in `docker/api/exec_api.py:99` — verified
  present.
- `pty_stream_output`: docker pumps via `_pump_pty_socket` in a daemon
  thread that already calls `_append_pty_output_chunks`. Extend the entry
  with `stream_consumers: list[Queue]` and have `_append_pty_output_chunks`
  push to consumers too. The streaming iterator drains its queue until the
  entry's `output_closed` is set or the iterator is cancelled.
- Sized `pty_exec_start`: pass through `cols`/`rows`, and immediately after
  `exec_create` returns, call `api.exec_resize(exec_id, height=rows,
  width=cols)` (no SDK kwarg for initial size).

**Public API:**

- `ExtendedUnixLocalSandboxSession.pty_stream_output(process_id: int) ->
  AsyncIterator[bytes]`
- `ExtendedUnixLocalSandboxSession.pty_resize(process_id: int, *, cols: int,
  rows: int) -> None`
- Same signatures on `ExtendedDockerSandboxSession`
- `pty_exec_start(*, cols: int | None = None, rows: int | None = None,
  **other)` on both

**Tests:**

- New: `tests/unit/core/sandbox/test_unix_local_pty_streaming.py` — spawn
  `bash -c 'printf hello && sleep 5 && echo bye'`, assert
  `pty_stream_output` yields chunks containing `b"hello"` within 1s. Resize
  a PTY and confirm `tput cols` reflects the new size via
  `pty_write_stdin`.
- New: `tests/integration/sandbox/test_docker_pty_streaming.py` — gated on
  docker-extra. Same flow against a container, plus assert `exec_resize` is
  called via docker SDK introspection. Marked `@pytest.mark.docker`.

**What breaks if landed alone:** Nothing — pure additions. Factory swap to
extended unix_local is non-observable behavior (subclass overrides only the
new methods).

---

### Step 2 — `SessionPtyBackend` + `TerminalManager` refactor

**Repo:** omniagents

**Files touched / created:**

- Edit: `/home/emm/Omni/Workspace/omniagents/omniagents/rpc/terminal.py` —
  introduce `PtyBackend` Protocol, factor existing impl into
  `HostPtyBackend`, add `SessionPtyBackend`, change
  `TerminalManager.__init__(self, backend: PtyBackend)`.
- New:
  `/home/emm/Omni/Workspace/omniagents/omniagents/rpc/terminal_backends.py`
  — `PtyBackend`, `HostPtyBackend`, `SessionPtyBackend`.

**`PtyBackend` Protocol:**

```python
class PtyBackend(Protocol):
    async def start(self, *, shell: str, cwd: str | None, cols: int, rows: int,
                    user: str | None) -> "PtyHandle": ...
    async def write(self, handle: PtyHandle, data: bytes) -> None: ...
    async def resize(self, handle: PtyHandle, cols: int, rows: int) -> None: ...
    def stream(self, handle: PtyHandle) -> AsyncIterator[bytes]: ...
    async def close(self, handle: PtyHandle) -> None: ...
    async def exit_code(self, handle: PtyHandle) -> int | None: ...
```

`PtyHandle` is an opaque type per backend. `TerminalDescriptor` carries it
instead of `master_fd`/`process`.

**`HostPtyBackend`:** lifts `pty.openpty()`, `_set_winsize`, `os.write`,
`os.read`-loop verbatim from current `terminal.py`. Preserves the existing
standalone-server behavior for `omniagents serve`-without-session and for
tests.

**`SessionPtyBackend(session, *, profile_terminal)`:**

- `start`: calls `session._inner.pty_exec_start(shell, shell=True, tty=True,
  user=user, cols=cols, rows=rows, yield_time_s=0.0)`. Captures
  `process_id`. Returns a handle `{ session_process_id: int, cols, rows,
  _stream_task, _output_queue }`.
- `write`: `await session._inner.pty_write_stdin(
  session_id=handle.session_process_id, chars=data.decode("utf-8",
  "surrogateescape"), yield_time_s=0.0)`. **Note:** SDK's `pty_write_stdin`
  returns up to 250 ms of accumulated output as a side effect; we discard it
  here because the streaming path already delivers it. (The agent's PTY
  tool is the only caller that *wants* that read-after-write batch.)
- `resize`: `await session._inner.pty_resize(handle.session_process_id,
  cols=cols, rows=rows)`.
- `stream`: `async for chunk in
  session._inner.pty_stream_output(handle.session_process_id): yield chunk`.
- `close`: there's no per-pty terminate in the SDK; we send Ctrl-C
  (`pty_write_stdin chars="\x03"`) and then ctrl-D (`"\x04"`) over the input
  channel, then rely on `_finalize_pty_update` to clear the entry when the
  process exits. If still running after 2s, call
  `session._inner.pty_terminate_all()` only when this is the **only**
  outstanding terminal (we track it; `cleanup_session` collapses to
  `pty_terminate_all` when the session shuts down). For per-terminal forced
  terminate during normal operation, a follow-up SDK method is needed — log
  a warning, leave the process running, return.

**`TerminalManager` changes:**

- `__init__(self, backend: PtyBackend, *, default_shell: str | None = None,
  default_cwd: str | None = None)`. Public surface (`create_terminal`,
  `authorize`, `write_input`, `resize`, `read_output`, `close_terminal`,
  `cleanup_session`, `encode_output`, `decode_input`) unchanged — they
  delegate to the backend.
- `_reader_loop` removed; replaced by an `async for chunk in
  backend.stream(handle)` task feeding the existing `output_queue`. Same
  `Optional[bytes]`-None sentinel for exit.
- Resize coalescing (the 16 ms guard described above) lives in
  `TerminalManager.resize`, not the backend.

**Tests:**

- Existing `tests/integration/test_server_terminal.py` continues to pass —
  its `StubTerminalManager` doesn't depend on the backend split.
- Existing `tests/unit/rpc/test_terminal_manager.py` — update to construct
  `TerminalManager(backend=HostPtyBackend())`. Migrate the
  `monkeypatch.setattr(TerminalManager, "_reader_loop", ...)` test to
  monkey-patch `HostPtyBackend.stream`.
- New: `tests/unit/rpc/test_session_pty_backend.py` — `FakeStreamingSession`
  exposing `pty_exec_start`, `pty_write_stdin`, `pty_resize`,
  `pty_stream_output`. Assert start → write → stream → resize → close
  round-trip; assert close-during-stream cancels cleanly; assert
  backpressure cap drops oldest at 4 MB.

**What breaks if landed alone:** Nothing —
`TerminalManager(backend=HostPtyBackend())` is the only constructor the
existing standalone server uses, and that's what `build_app` does today
(well — `build_app` doesn't construct it; only test stubs do). The current
public API is preserved.

---

### Step 3 — omni-code profile `terminal:` block + `terminal.*` server-function registration

**Repo:** omni-code

**Files touched / created:**

- Edit: `/home/emm/Omni/Workspace/omni-code/omni_code/sandbox_profile.py` —
  add `TerminalSpec` dataclass and `terminal: TerminalSpec` field on
  `ResolvedProfile`; add `_parse_terminal()`; call it from
  `resolve_profile()`.
- Edit:
  `/home/emm/Omni/Workspace/omni-code/omni_code/sandbox_profile_default.yml`
  — append `terminal: { command: "${SHELL:-/bin/bash} -i" }` (the
  substitution is shell-level, not profile-level; profile passes the string
  through and the unix_local backend's environment supplies `SHELL`).
- Edit: `/home/emm/Omni/Workspace/launcher/assets/profiles/devbox.yml` —
  append `terminal: { command: "bash -i", user: "1000:1000", cwd:
  "/workspace" }`.
- Edit: `/home/emm/Omni/Workspace/omni-code/omni_code/serve_cli.py` — after
  `build_app(...)`:
  1. Get `service = app.state.agent_service`.
  2. Import omniagents `TerminalManager`, `SessionPtyBackend`.
  3. Construct `service.terminal_manager =
     TerminalManager(backend=SessionPtyBackend(session, profile.terminal))`.
  4. Register four server functions on `service`:
     - `terminal.create({ cols, rows, cwd? })` → `{ session_id,
       terminal_id, terminal_token, path: "/ws/terminal", cwd }` — calls
       `service.terminal_manager.create_terminal(rpc_session_id,
       shell=profile.terminal.command, cwd=<resolved>, cols=cols,
       rows=rows)`. `rpc_session_id` is the JSON-RPC's `session_id` (passed
       via `server_call` 3rd arg).
     - `terminal.attach({ terminal_id, terminal_token })` → `{ path:
       "/ws/terminal" }` — validates the `(session_id, terminal_id, token)`
       tuple via `service.terminal_manager.authorize`-without-consuming.
       **New method on TerminalManager:** `peek(session_id, terminal_id,
       token) -> bool` that runs the same validation as `authorize` but
       doesn't flip `consumer_attached`. Existing `authorize` stays as the
       single point that does the attach-once gate.
     - `terminal.resize({ terminal_id, terminal_token, cols, rows })` →
       out-of-band resize over RPC for clients that don't want to keep the
       `/ws/terminal` socket open during a UI-only resize (e.g. minimized
       terminal panel). Optional but cheap.
     - `terminal.close({ terminal_id, terminal_token })` → `{}` — calls
       `close_terminal`.

  Registration uses the existing `register_server_function` pattern
  (`omniagents/core/agents/service.py:944`). Names with dots are valid keys
  in the `_server_functions` dict (lookup is by dict key, not getattr).

**`TerminalSpec` (frozen dataclass):**

```python
@dataclass(frozen=True)
class TerminalSpec:
    command: str = "bash -i"
    user: Optional[str] = None     # falls back to top-level run_as
    cwd: Optional[str] = None      # falls back to manifest.root
```

**`_parse_terminal`:** new function. If `profile.raw.get("terminal")` is
`None`, return `TerminalSpec()` (defaults). Otherwise validate it's a
mapping; pull `command` (string, default `"bash -i"`), `user` (string|None),
`cwd` (string|None). Validation lives next to `_parse_services`.

**Validation update in `_validate`:** if `terminal.user` is unset but
`profile.raw.get("run_as")` is set, materialize `terminal.user = run_as` at
parse time (so omni serve has one source of truth).

**Tests:**

- Edit: `omni-code/tests/unit/test_sandbox_profile.py` — new cases for
  terminal-default, terminal-explicit, terminal-user-from-run_as.
- New: `omni-code/tests/integration/test_serve_terminal.py` — spin up
  `omni serve` against the bundled host profile, call `terminal.create` via
  the agent WS, attach `/ws/terminal`, send `echo hi`, assert `hi` arrives
  within 2s.

**What breaks if landed alone:** Nothing renderer-facing — the launcher
still uses host node-pty. The new server functions exist but aren't called.

---

### Step 4 — Launcher `ConsoleManager` rewrite (proxy)

**Repo:** launcher

**Must land together with Step 5** because the renderer's IPC arity changes
(`terminal:create` returns a richer object) and the registry flip needs the
new flow ready.

**Files touched / created:**

- Replace: `/home/emm/Omni/Workspace/launcher/src/main/console-manager.ts` —
  full rewrite. Drops node-pty entirely. Drops `getShell`, `getHomeDir`,
  `getBinPath`, `getActivateCmd` deps.
- New: `/home/emm/Omni/Workspace/launcher/src/main/terminal-proxy.ts` —
  per-tab proxy that owns the `omni serve` WS connection used for terminals
  (it's a separate ws than the one the renderer uses for JSON-RPC, dialed
  from main process via `ws`). Holds the `{ terminalId, token, sessionId }`
  cache and the byte pump from `omni serve`'s `/ws/terminal` back to the
  renderer's `terminal:output` event.
- Edit: `/home/emm/Omni/Workspace/launcher/src/main/index.ts` — pass
  `processManager` into `createConsoleManager`.
- Edit:
  `/home/emm/Omni/Workspace/launcher/src/main/console-manager.test.ts` —
  full rewrite. Stub agent WS via a local httpServer + ws, assert the proxy
  speaks the right JSON.
- Delete: `/home/emm/Omni/Workspace/launcher/src/lib/pty-utils.ts` (if it's
  only used by console-manager — verify with grep before deletion; if used
  elsewhere keep it).

**New `ConsoleManager` shape (sketch):**

```typescript
type ProxiedTerminal = {
  id: string;             // renderer-facing id (== terminal_id from omni serve)
  tabId: string;
  token: string;          // per-terminal token from terminal.create
  serveSessionId: string; // the omni serve rpc session id
  ws: WebSocket | null;   // /ws/terminal connection
  status: 'connecting' | 'open' | 'closed';
};

export class ConsoleManager {
  constructor(private deps: {
    processManager: ProcessManager;
    sendToWindow: <T extends keyof IpcRendererEvents>(c: T, ...a: IpcRendererEvents[T]) => void;
  }) {}

  async createConsole(tabId: string, cwd?: string): Promise<Result<string, ConsoleError>> { ... }
  async attachConsole(tabId: string, terminalId: string, token: string): Promise<Result<void, ConsoleError>> { ... }
  write(id: string, data: string): void { ... }
  resize(id: string, cols: number, rows: number): void { ... }
  dispose(id: string): Promise<void> { ... }
  disposeAllForTab(tabId: string): Promise<void> { ... }
  listIdsForTab(tabId: string): string[] { ... }
}
```

**`createConsole` flow:**

1. `processManager.getStatus(tabId)` → must be `running` or `connecting`
   with a `wsUrl`. Otherwise `Result.err({ kind: 'process_not_ready' })`.
2. Open a fresh `JsonRpcClient`-style request over a short-lived WS to
   `wsUrl` (or reuse a per-tab connection; see below). Call
   `terminal.create` with `{ cols, rows, cwd }`. Get back `{ session_id,
   terminal_id, terminal_token, path }`.
3. Dial `${wsUrlBase}${path}?session_id=...&terminal_id=...&terminal_token=
   ...&token=<auth>` (auth token extracted from `wsUrl`'s query if
   present).
4. Wire `ws.onmessage` → parse JSON → if `type === 'output'`,
   `sendToWindow('terminal:output', tabId, terminal_id, atob(data))`; if
   `type === 'exit'`, `sendToWindow('terminal:exited', tabId, terminal_id,
   code)`.
5. Cache the entry. Return `Result.ok(terminal_id)`.

**Connection topology decision:** **one terminal RPC WS per tab, shared by
all terminals in that tab**, dialed lazily and held open for the tab's
lifetime. The `/ws/terminal` socket is per-terminal (the existing protocol
mandates this — `terminal_id` is in the URL). The RPC WS is reused for
create/resize/close. This matches the existing protocol decision in
`omniagents/backends/server/app.py`.

**`Result<T, E>` usage:** all public methods return `Result`; IPC handler
unwraps to `{ ok, value, error }` shape before sending to the renderer. The
renderer's `state.ts` will be updated to handle the error shape.

**Auth flow:** main process extracts the `?token=` from
`processStatus.data.wsUrl` once and reuses it for both the RPC WS and the
`/ws/terminal` WS. There's no separate fetch.

**Persistence across launcher restart:** on `ConsoleManager` construction we
read the launcher's existing persisted tab state (already has a
`terminalIds: Array<{ id, token }>` field — added in this step to the
per-tab persisted record). For each cached terminal, call `terminal.attach`
on the agent (Step 3's new RPC) and re-dial `/ws/terminal`. On
`TerminalNotFoundError`, drop the cache entry. The persistent map writes
back whenever entries change.

**IPC changes in `src/shared/types.ts`:**

- `terminal.create` signature changes: `create: (tabId: string, opts?: {
  cwd?: string; cols?: number; rows?: number }) => Result<string, { kind:
  ConsoleErrorKind; message: string }>`.
- Add `'terminal:status': [string, string, 'connecting' | 'open' |
  'closed']` to renderer events for the renderer to show a spinner while
  the WS handshake completes.
- No other channel changes.

**What breaks if landed alone:** Renderer's `terminal:create` calls fail
because main no longer has a host PTY to give back. **Must ship with
Step 5.**

---

### Step 5 — Renderer wiring + registry flip

**Repo:** launcher

**Files touched:**

- Edit:
  `/home/emm/Omni/Workspace/launcher/src/renderer/features/Console/state.ts`
  — `createTerminal` calls the new IPC shape, handles `Result` errors (show
  toast on `process_not_ready`), wires the new `terminal:status` event into
  terminal state (`isConnecting` flag).
- Edit:
  `/home/emm/Omni/Workspace/launcher/src/renderer/features/Console/ConsoleRunning.tsx`
  — render a "Connecting to sandbox…" placeholder when `isConnecting`.
  Display a clearer empty-state when there is no attached process: "Open a
  code session to launch a terminal."
- Edit: `/home/emm/Omni/Workspace/launcher/src/shared/app-registry.ts` —
  flip `terminal` from `scope: 'always'` to `scope: 'sandbox'`. Remove the
  global-terminal column entry from any place that hard-codes `'terminal'`
  outside the dock. (Grep `'builtin-terminal'` references; check
  `WorkspaceDeck`/launcher menus.)
- Edit:
  `/home/emm/Omni/Workspace/launcher/src/renderer/features/Console/ConsoleXterm.tsx`
  — `terminal:resize` IPC signature is unchanged (still `(id, cols, rows)
  => void`).

**Tests:**

- New: `src/main/console-manager.test.ts` — full rewrite. Spin up a local WS
  server fake that responds to JSON-RPC
  `terminal.create`/`terminal.attach`/`terminal.resize`/`terminal.close` and
  a `/ws/terminal` echoes input back as output. Assert: create → write →
  output round-trip; attach across reconstruction; dispose closes the WS.
- New: `src/renderer/features/Console/state.test.ts` — verify the `Result`
  unwrap and toast on error.

**What breaks if landed alone:** Same as Step 4. Ship the two together.

---

### Step 6 — Cleanup and docs

**Repos:** all three

**Files touched / created:**

- Delete: `/home/emm/Omni/Workspace/launcher/src/lib/pty-utils.ts` (if no
  other users; verify with grep).
- Delete: `node-pty` from `launcher/package.json` (and rebuild scripts that
  reference it).
- Edit: `/home/emm/Omni/Workspace/launcher/CLAUDE.md` — add a "Terminals
  live in omni serve" section pointing readers at `terminal-proxy.ts` and
  the omni serve `terminal.*` server functions.
- Edit:
  `/home/emm/Omni/Workspace/omniagents/omniagents/rpc/protocol.md` —
  document `pty_stream_output`/`pty_resize` and the new
  `terminal.attach`/`terminal.resize`/`terminal.close` server functions.
- Edit: `/home/emm/Omni/Workspace/omni-code/README.md` (or the existing
  profile doc) — document the `terminal:` profile block.

## Risks and how we handle them

**Latency budget for keystrokes.** The host node-pty path is ~50 µs per
keystroke (kernel-only). The new path is: xterm onData → contextBridge IPC
(~0.3 ms) → main proxy → loopback WS to omni serve (~1 ms, same host) →
uvicorn → AgentService → SessionPtyBackend → `pty_write_stdin` → SDK calls
`os.write(primary_fd, ...)` (~0.05 ms) — **then waits 100 ms before
returning** (`await asyncio.sleep(0.1)` in the SDK at `unix_local.py:381`
and `docker.py:946`). That 100 ms is non-negotiable in the current SDK
shape. We work around it by **not awaiting** `pty_write_stdin` in
`SessionPtyBackend.write` — we fire-and-forget the coroutine
(`asyncio.create_task(...)`) and rely on `pty_stream_output` to deliver the
resulting output. Documented in `SessionPtyBackend.write`. Result:
keystroke-to-output latency dominated by the WS round-trip (~2 ms on
loopback), well inside the 16 ms one-frame budget. Remote (platform-mode)
terminals add network RTT; same path, no architectural difference.

**SDK upgrade exposure.** Subclassing `UnixLocalSandboxSession` and
`DockerSandboxSession` couples us to internal attributes (`_pty_processes`,
`entry.primary_fd`, `entry.output_chunks`, `entry.output_notify`,
`entry.output_closed`, `entry.exec_id`, `entry.raw_sock`). These are
private. Mitigation: every access goes through a single thin shim
(`omniagents/core/sandbox/pty_internals.py`) — when the SDK ships a public
streaming API, we replace the shim and nothing else moves. CI: pin the SDK
version in omniagents' constraints file; bump it deliberately. The same
SDK-version risk already exists in `docker_extended.py`.

**`pty_resize` on docker really does call `exec_resize`.** Verified —
`docker/api/exec_api.py:99` exposes it. No sidecar or engine-API
hand-rolling needed.

**Per-terminal token leakage on a shared WS.** The launcher's tab-shared
RPC WS carries multiple terminal tokens in flight (one per terminal). The
token never crosses tab boundaries because each tab has its own RPC WS
connection (separate `omni serve` process — each code tab has its own).
The `/ws/terminal` socket only sees one token per connection (in the URL).
The existing per-terminal token model in `omniagents/rpc/terminal.py`
(`secrets.token_urlsafe(24)`, validated in `authorize` and `peek`) is
sufficient. We do **not** rotate tokens on reconnect — the SDK session id
is the secret-equivalent for resume; if it's revealed, the agent's full WS
is also compromised, so terminal-only re-auth would buy nothing.

**Renderer remount during dispose.** Today's race: `destroyTerminal` calls
`terminal:dispose` then `xterm.dispose()`. With the new path, `dispose`
does an async WS close round-trip to omni serve. If the renderer remounts
mid-dispose, hydration could see the terminal in `omni serve`'s active map
and re-attach a corpse. Fix: `ConsoleManager.dispose` immediately marks the
entry as `disposing` locally and rejects subsequent `attach` calls for that
id from the same tab. The actual server-side close completes async.
Tracked in `console-manager.test.ts`.

**E2B/modal/runloop backends raise on attach.** The launcher currently has
`scope: 'sandbox'` for code/desktop; flipping terminal to `scope:
'sandbox'` means users with an e2b profile attempting to open a terminal
get a clear `WorkspaceFeatureUnavailable` from the omni serve side. We
surface this as the proxy's `Result.err({ kind: 'backend_no_pty_stream' })`
and show a renderer toast: "This sandbox backend does not yet support
terminals." That's acceptable for the initial launch; e2b/modal/runloop PTY
streaming is out of scope.

## Out of scope

- Platform-mode terminals (PlatformClient code path). The platform sandbox
  today is a separate WS proxy in
  `omniagents/backends/server/app.py:212-228`; terminals through it work
  via the same `/ws/terminal` proxy. Verifying it end-to-end and adding
  integration tests is a follow-up.
- e2b/modal/runloop/daytona/blaxel/vercel/cloudflare PTY streaming
  primitives. Each one needs a backend-specific `pty_stream_output` and
  `pty_resize`. The mixin raises `WorkspaceFeatureUnavailable` for now.
- Upstreaming `pty_stream_output`/`pty_resize` to `agents.sandbox`.
- Switching the `/ws/terminal` wire format from JSON-base64 to binary
  frames. Mentioned as a real perf win; deferred until we have terminals
  shipping smooth at the current shape.
- Per-terminal forced terminate inside an active session (no SDK primitive
  exists for this — only `pty_terminate_all`). Today's host backend kills
  by pid; the new session backend can't. Documented; not a regression
  because the launcher's user-facing dispose flow does close-by-EOF
  (Ctrl-D), which the shell honors.
- Dotfile materialization into the sandbox terminal (`.bashrc`, `.profile`,
  etc.). The profile's `command` is currently `bash -i` which sources
  whatever the image ships. A follow-up profile feature can stage dotfiles
  via manifest entries.
- Removing the renderer's "global terminal column" UI bits beyond the
  registry flip — search for dead UI is left to step 5 as it lands.

## Critical files for implementation

- `/home/emm/Omni/Workspace/omniagents/omniagents/rpc/terminal.py`
- `/home/emm/Omni/Workspace/omniagents/omniagents/core/sandbox/docker_extended.py`
- `/home/emm/Omni/Workspace/omni-code/omni_code/serve_cli.py`
- `/home/emm/Omni/Workspace/omni-code/omni_code/sandbox_profile.py`
- `/home/emm/Omni/Workspace/launcher/src/main/console-manager.ts`
