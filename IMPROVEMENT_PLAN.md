# Omni Code Launcher — Production Readiness Improvement Plan

Generated from a full audit of the codebase. Issues are organized by priority and phase.
Phases must be executed in order; within a phase, fixes are independent unless noted.

---

## Status dashboard (as of 2026-04-14)

**✅ = done · 🟡 = partial · ⏳ = pending**

| Phase | Fix | Status | Landed in |
|-------|-----|--------|-----------|
| 1 | 1.1 Page.properties roundtrip | ✅ | `8bc6349` |
| 2 | 2.1 Config path validation | ✅ | `43ffc29` |
| 2 | 2.2 SSRF proxy auth | ✅ | `955cd14` |
| 2 | 2.3 WS authentication | ✅ | `fb32f41` |
| 3 | 3.1 processManager in server mode | ✅ | `43ffc29` |
| 3 | 3.2 Token accumulation | ✅ | `34535ea` |
| 4 | 4.1 Eliminate `as any` | ✅ | `b978f72` |
| 4 | 4.2 `respond(false)` on errors | ✅ | `34535ea` |
| 4 | 4.3 chokidar in WorkspaceSyncManager | ✅ | `8e79e18` |
| 4 | 4.4 rpcIdCounter → instance field | ✅ | `61f0810` |
| 4 | 4.5 Auto-dispatch column WIP limit | ✅ | `34535ea` |
| 5 | 5.1 WsHandler tests | ✅ | `d784b88` |
| 5 | 5.2 ProjectManager tests (initial) | ✅ | `e6fda0d` |
| 5 | 5.3 AgentProcess tests | ✅ | `a295a04` |
| 6 | 6.1 sendStartRun dedup | ✅ | `6ab8c07` |
| 6 | 6.2 Shared handler extraction | ✅ | `42aaae3` |
| 6 | 6.3 Sprint A — PageManager extraction | ✅ | `44fe1d4` |
| 6 | 6.3 Sprint A.1 — Migrations extraction (bonus) | ✅ | `0a6ed05` |
| 6 | 6.3 Sprint B — MilestoneManager extraction | ✅ | (this commit) |
| 6 | 6.3 Sprint C — SupervisorOrchestrator split | ⏳ | — |

### Deep testing wave (follow-up to Phase 5)

After Phase 5 landed, a full testing pass was run assuming the code was buggy. Every
major orchestration surface is now covered, and the test suite grew from 720 → 812 tests.
**Seven bugs were discovered and fixed along the way:**

| # | Bug | Found in wave | Fixed in |
|---|-----|---------------|----------|
| 1 | `TicketRun.startedAt` collapsed onto `endedAt` because every `onTokenUsage` callback bumped `ticket.updatedAt` — UI always showed ~0ms run durations. Fixed by tracking `runStartedAt` per ticket in a private Map. | T1 | `3ca8817` |
| 2 | Auto-dispatch moved a ticket into column 2 **before** calling `startSupervisor`. If `startSupervisor` rejected (hook failure, concurrency lost mid-tick, preflight failure), the ticket was stranded in column 2 and `getNextTicket` would never re-pick it. Fixed by reverting the column move on failure. | T4 | `0218c01` |
| 3 | `moveTicketToColumn` only cancelled pending retry timers on terminal moves. Shelving a ticket back to backlog or advancing it into a gated column stopped the supervisor but left the retry timer armed — a shelved ticket could revive itself. Fixed with `cancelRetry` on both branches. | T3 | `cb92d95` |
| 4 | `ITicketMachine` interface was missing `sendMessage` entirely and had a narrower `createSession` signature than the real `TicketMachine` class — the streaming-branch call site was only type-checked against the concrete class, and tests couldn't mock it. Fixed by widening the interface. | T6 | `ba30db6` |
| 5 | `scheduleRetry`'s `failureClass === 'completed'` branches were unreachable dead code (`decideRunEndAction` never returns `retry` with a completed failure class — completions take the `continue` path directly). Removed dead branches + the unused `CONTINUATION_RETRY_DELAY_MS` constant. | T2 | `197364a` |
| 6 | v13→v14 schema migration stripped empty `properties: {}` keys from pages into a local `keptPages` array but only persisted the cleaned version when `recovered.length > 0 \|\| keptPages.length !== pagesRaw.length`. If every page had an empty `properties: {}` and none moved to inbox, neither condition held and the cleaned version was silently discarded. Fixed with a `strippedAny` flag. | T10 | `0a6ed05` |
| 7 | `resetStaleTicketStates` wipes `error` phase → `idle` on boot. Documented as intentional (in-memory retry counters are gone) but now pinned by a test so future changes update both the comment and the test in lockstep. | T7 | `b98e2e5` (test only) |

### Test waves executed

| Wave | Coverage added | Tests |
|------|----------------|-------|
| T1 | `handleMachineRunEnd` — run record persistence, stopped/continue/retry branches, continuation delay, max-turns, mid-run terminal column bail, not-streaming guard | 11 |
| T2 | Retry backoff ladder (0→4), MAX_RETRY_BACKOFF_MS clamping, `handleRetryFired` terminal/no-slots, dead-code pin for `completed` branch | 6 |
| T3 | `moveTicketToColumn` — terminal cancels retry + cleanup, backlog/gated cancel retry (bug #3), reopen clears resolution, no-op guards, auto-resolve on terminal (added during merge) | 8 |
| T4 | `autoDispatchTick` — revert on start failure (bug #2), already-active skip | 2 |
| T5 | `validateDispatchPreflight` every branch + `ensureSupervisorInfra` idempotency (streaming/ready/stale paths) | 14 |
| T6 | `sendSupervisorMessage` (idle/error/ready/awaiting_input → startRun, streaming → sendMessage, rejection swallowed, no-machine path), `resetSupervisorSession` | 11 |
| T7 | `restorePersistedTasks` + startup cleanup (orphan task removal, terminal-column worktree cleanup, phase reset) | 8 |
| T11/T9 | `getNextTicket` priority/blocked-by, milestone CRUD with orphan clear, project CRUD cascade against tmpdir `$HOME` | 14 |
| T10 | All v3→v16 migration steps individually + full ladder + v-current idempotency + repair callback | 25 |
| T8 | `getFilesChanged` against a real tmpdir git repo — untracked/modified/added/deleted/binary/zero-commit paths | 8 |

**Also landed during the testing wave:**
- `vitest.config.ts` aliases `electron` → `src/server/electron-shim.ts` so main-process modules run under plain Node tests.
- Extracted `runMigrations` from the 440-line `ProjectManager.migrateToSupervisor` static method into pure `src/lib/project-migrations.ts` with dependency injection for fs side effects — gives ~440 lines of file-size relief and makes each migration step testable in isolation. This wasn't in the original 6.3 plan but was the right seam to extract first.
- Merged upstream's v15→v16 schema migration + `archivedAt` + auto-resolve-on-terminal behavior through the pure migrations module.

---

## Phase 1 — Critical Data Correctness (Week 1, Days 1–2)

**Ship blocker. Fix before anything else. These are active test failures that represent data corruption in production.**

### Fix 1.1 — `Page.properties` roundtrip (3 failing tests) ✅ DONE (`8bc6349`)

**Status:** 3 tests failing in `src/lib/project-files.test.ts`

**Root cause:** `Page` has no `properties` field in the type or schema. `serializePageFile`/`parsePageFile` don't know about it, so properties (milestoneId, status, size, outcome, notDoing, laterAt) are silently dropped on write→read, corrupting user data.

**Files to change:**
- `src/shared/types.ts`
- `src/lib/project-files.ts`

**`src/shared/types.ts`** — add before the `Page` type:
```ts
export type PageProperties = {
  status?: string;
  size?: string;
  projectId?: ProjectId;
  milestoneId?: MilestoneId;
  outcome?: string;
  notDoing?: string;
  laterAt?: number;
};
```
Add `properties?: PageProperties` to the `Page` type.

**`src/lib/project-files.ts`:**
1. Add a `PagePropertiesSchema` Zod object above `PageMetaSchema` with all the same optional fields.
2. Add `properties: PagePropertiesSchema` to `PageMetaSchema`.
3. In `parsePageFile`, assign `page.properties = m.properties ?? undefined` (omit key entirely if empty object).
4. In `serializePageFile`, spread `page.properties` into the frontmatter meta under a `properties` key when defined.

**Tests to write/fix:** All 3 failing tests should now pass. Add `'omits properties key entirely when none set'` to confirm no phantom keys are written.

**Verification:** `npx vitest run src/lib/project-files.test.ts` — all tests pass.

**Size:** S

---

## Phase 2 — Critical Security, Server Mode (Week 1, Days 3–5)

**Three independent attack vectors in server/browser mode. Can be worked in parallel.**

### Fix 2.1 — Arbitrary file read/write via `config:*` handlers ✅ DONE (`43ffc29`)

**Root cause:** `config:read-json-file`, `config:write-json-file`, `config:read-text-file`, `config:write-text-file` in `server/managers.ts` (and `main/index.ts`) accept any `filePath` from the client with no path validation. In server mode, any connected WebSocket client can read `/etc/passwd`, overwrite SSH keys, or write files anywhere the server process can reach.

Note: the `artifact:` protocol handler in `main/index.ts` already has correct path traversal protection — apply the same pattern here.

**Files to change:**
- `src/main/util.ts` (add helper)
- `src/server/managers.ts` (4 handlers)
- `src/main/index.ts` (4 handlers, defense-in-depth)

**`src/main/util.ts`** — add:
```ts
export function validateConfigPath(filePath: string, configDir: string): void {
  const resolvedFile = path.resolve(filePath);
  const resolvedConfig = path.resolve(configDir);
  if (!resolvedFile.startsWith(resolvedConfig + path.sep) &&
      resolvedFile !== resolvedConfig) {
    throw new Error(`Access denied: path is outside config directory`);
  }
  if (filePath.includes('\0')) {
    throw new Error('Invalid path: null byte');
  }
}
```

**`src/server/managers.ts` and `src/main/index.ts`** — add `validateConfigPath(filePath, OMNI_CONFIG_DIR)` as the first line of each `config:read-json-file`, `config:write-json-file`, `config:read-text-file`, `config:write-text-file` handler. The throw propagates through `WsHandler.handleMessage`'s existing try/catch and returns an error response to the client.

**Tests to write:** `src/lib/util-config-path.test.ts`
- Path inside config dir → passes
- Path using `../` traversal → throws
- Sibling directory path → throws
- Null byte in path → throws
- Exact config dir itself → passes

**Size:** S

---

### Fix 2.2 — SSRF via unauthenticated `POST /proxy/_register` ✅ DONE (`955cd14`)

**Root cause:** `POST /proxy/_register` in `proxy-rewriter.ts` accepts any `{ name, upstream }` from any HTTP client with no authentication. Any client that can reach the Fastify port can register `upstream=http://169.254.169.254/` (cloud metadata), `upstream=http://localhost:5432/` (internal Postgres), etc., then retrieve it through `/proxy/{name}/`.

**Files to change:**
- `src/server/proxy-rewriter.ts`

**Change:** Restrict `_register` to loopback-only connections. Add an `onRequest` hook:

```ts
fastify.post('/proxy/_register', {
  onRequest: (req, reply, done) => {
    const addr = req.socket.remoteAddress ?? '';
    const isLoopback =
      addr === '127.0.0.1' ||
      addr === '::1' ||
      addr === '::ffff:127.0.0.1';
    if (!isLoopback && !process.env['OMNI_ALLOW_EXTERNAL_REGISTER']) {
      reply.code(403).send({ error: 'Forbidden: only loopback clients may register upstreams' });
      return;
    }
    done();
  },
  handler: async (request, reply) => {
    // existing handler body unchanged
  },
});
```

The `OMNI_ALLOW_EXTERNAL_REGISTER` env var is an escape hatch for deployments that genuinely need remote registration (should document that callers must be trusted).

**Tests to write:** Add to a new `src/server/proxy-rewriter.test.ts`:
- Request from `127.0.0.1` → 200
- Request from external IP → 403
- With `OMNI_ALLOW_EXTERNAL_REGISTER=1` from external IP → 200

**Size:** S

---

### Fix 2.3 — No WebSocket authentication ✅ DONE (`fb32f41`)

**Root cause:** `WsHandler` accepts any WebSocket connection with no token, no origin check, no rate limiting. In server mode, anyone reaching the Fastify port gets full access to all IPC handlers: `store:set` (overwrite all app state), `agent-process:start` (spawn processes), `config:write-text-file` (file I/O).

**Files to change:**
- `src/server/index.ts` (token generation + WS route guard)
- `src/renderer/transport/ws-transport.ts` (token acquisition + URL construction)

**`src/server/index.ts`:**

```ts
// At startup, generate or read a WS token
const wsToken = process.env['OMNI_WS_TOKEN'] ?? crypto.randomUUID();
// Log once so CLI operators and automation can use it
console.log('[auth] WS token:', wsToken);

// Add a loopback-only endpoint so the browser renderer can fetch the token
fastify.get('/api/ws-token', (request, reply) => {
  const addr = request.socket.remoteAddress ?? '';
  const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!isLoopback) {
    reply.code(403).send({ error: 'Forbidden' });
    return;
  }
  reply.send({ token: wsToken });
});

// In the WebSocket route handler, before calling wsHandler.addClient:
const token = new URL(request.url, 'ws://x').searchParams.get('token');
if (token !== wsToken) {
  socket.close(4401, 'Unauthorized');
  return;
}
```

**`src/renderer/transport/ws-transport.ts`:**

On startup, fetch `GET /api/ws-token` (loopback, so this is safe). Append the token to the WebSocket URL: `ws://localhost:PORT/ws?token=${token}`. Store the token in a module-level variable; do not expose it to the renderer beyond the transport module.

**Tests to write:** Add to `src/server/ws-handler.test.ts` (see Fix 5.1):
- Connection without token → close with 4401
- Connection with wrong token → close with 4401
- Connection with correct token → proceeds normally

**Size:** M (requires renderer-side change + token distribution coordination)

---

## Phase 3 — High: Silent Functional Gaps (Week 2, Days 1–2)

### Fix 3.1 — `processManager` missing in server-mode `createProjectManager` ✅ DONE (`43ffc29`)

**Root cause:** In `server/managers.ts`, `createProjectManager` is called before `createProcessManager`, so `processManager` is never passed. In server mode, `ProjectManager.processManager` is always `undefined`, which means `statusFallback` is never wired. Code tabs linked to a supervisor ticket cannot reuse the supervisor's running sandbox — status is always `uninitialized`. The bug is completely silent (no error thrown).

**Files to change:**
- `src/server/managers.ts`

**Change:** Reorder calls so `createProcessManager` runs first, then pass `processManager` into `createProjectManager`:

```ts
// Move this ABOVE createProjectManager
const [processManager, cleanupProcessManager] = createProcessManager({
  ipc: ipc as any,
  sendToWindow: sendToAll,
  fetchFn: globalThis.fetch,
  getStoreData: () => ({ ... }),
});

const [, cleanupProject] = createProjectManager({
  ipc: ipc as any,
  sendToWindow: sendToAll,
  store: store as any,
  processManager,  // add this
});
```

**Tests:** Covered by Phase 5 ProjectManager tests — add assertion that `processManager.statusFallback` is set when `processManager` is provided.

**Size:** S

---

### Fix 3.2 — Token usage accumulates incorrectly (`Math.max` → addition) ✅ DONE (`34535ea`)

**Root cause:** `project-manager.ts` lines 552–555 use `Math.max` to update token counts. The intent is to accumulate tokens across continuation turns, but `Math.max` only keeps the peak value from a single streaming update. Multi-run tickets show the highest single-update count, not the running total.

**Files to change:**
- `src/main/project-manager.ts`

**Change:**
```ts
// Before (wrong — keeps peak, not total):
const updated = {
  inputTokens: Math.max(prev.inputTokens, usage.inputTokens),
  outputTokens: Math.max(prev.outputTokens, usage.outputTokens),
  totalTokens: Math.max(prev.totalTokens, usage.totalTokens),
};

// After (correct — accumulates across turns):
const updated = {
  inputTokens: prev.inputTokens + usage.inputTokens,
  outputTokens: prev.outputTokens + usage.outputTokens,
  totalTokens: prev.totalTokens + usage.totalTokens,
};
```

The surrounding guard `if (updated.totalTokens !== prev.totalTokens)` continues to work correctly — any non-zero usage will change the total.

**Tests:** In Phase 5 ProjectManager tests — send two `onTokenUsage` callbacks with known values and assert the accumulated total equals the sum, not the max.

**Size:** XS

---

## Phase 4 — Medium: Type Safety & Minor Correctness (Week 2, Days 3–5)

These are independent and can be done in any order.

### Fix 4.1 — Eliminate 7 `as any` casts in `server/managers.ts` ✅ DONE (`b978f72`)

**Root cause:** `ServerIpcAdapter` doesn't satisfy the `IpcListener<IpcEvents>` interface from `@electron-toolkit/typed-ipc`, so all 7 manager factory calls use `as any` to bypass the type system. Broken handler signatures in server mode are invisible to the TypeScript compiler.

**Files to change:**
- `src/shared/ipc-listener.ts` (new file)
- `src/server/ipc-adapter.ts`
- `src/main/process-manager.ts`, `src/main/console-manager.ts`, `src/main/project-manager.ts`, `src/main/extension-manager.ts`, `src/main/omni-install-manager.ts` (factory signatures)

**New `src/shared/ipc-listener.ts`:**
```ts
/**
 * Minimal IPC listener interface satisfied by both Electron's IpcListener
 * and the server-mode ServerIpcAdapter.
 */
export interface IIpcListener {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, handler: (event: null, ...args: any[]) => any): void;
}
```

Make `ServerIpcAdapter` implement `IIpcListener` (it already has the right method shape).

Change each manager factory's `ipc` parameter type from `IpcListener<IpcEvents>` to `IIpcListener`. TypeScript structural typing means `IpcListener<IpcEvents>` satisfies `IIpcListener` — Electron mode works unchanged, zero runtime impact.

**Size:** M

---

### Fix 4.2 — `respond(true, { error: ... })` inconsistency in tool dispatch ✅ DONE (`34535ea`)

**Root cause:** `handleClientToolCall` in `project-manager.ts` has ~20 error branches that call `respond(true, { error: 'message' })`. The first argument signals success to the agent. The agent receives `ok=true` and must inspect the result object to detect failure — an unreliable contract.

**Files to change:**
- `src/main/project-manager.ts`

**Change:** Replace all `respond(true, { error: ... })` with `respond(false, { error: { message: '...' } })` — matching the structure of the one already-correct `respond(false, ...)` call in the file.

Example:
```ts
// Before
respond(true, { error: `Unknown column: "${columnLabel}". Valid columns: ${valid}` });

// After
respond(false, { error: { message: `Unknown column: "${columnLabel}". Valid columns: ${valid}` } });
```

**Tests:** In Phase 5 ProjectManager tests — assert that `respond` is called with `false` as first argument when tool names are invalid, tickets are not found, etc.

**Size:** S (mechanical find-and-replace, ~20 sites, careful review needed)

---

### Fix 4.3 — Replace `fs.watch` with chokidar in `WorkspaceSyncManager` ✅ DONE (`8e79e18`)

**Root cause:** `WorkspaceSyncManager` uses Node's `fs.watch({ recursive: true })` to watch the workspace directory. On Linux, inotify does not support recursive watching — `recursive: true` is silently ignored (it's a macOS/Windows-only option). File changes in subdirectories are missed, breaking incremental sync. chokidar is already a dependency and already used in `src/lib/page-watcher.ts`.

**Files to change:**
- `src/main/workspace-sync-manager.ts`

**Change:** Replace:
```ts
import { watch, type FSWatcher } from 'node:fs';
// ...
const watcher = watch(session.workspaceDir, { recursive: true }, (_event, filename) => {
  // handle change
});
```

With:
```ts
import chokidar from 'chokidar';
// ...
const watcher = chokidar.watch(session.workspaceDir, {
  ignoreInitial: true,
  persistent: true,
  ignored: /(^|[/\\])\../,  // hidden files/dirs
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
}).on('all', (_event, filePath) => {
  // handle change — filePath is the full absolute path
});
```

Update `session.watcher` type from `FSWatcher` (node:fs) to `chokidar.FSWatcher`. Cleanup: `await session.watcher.close()` (chokidar's `close()` returns a Promise).

**Size:** S

---

### Fix 4.4 — Module-level `rpcIdCounter` → instance field ✅ DONE (`61f0810`)

**Root cause:** `let rpcIdCounter = 0` in `ticket-machine.ts` is module-global state, shared across all `TicketMachine` instances. Under test parallelism, RPC IDs are non-deterministic. Under a long-running server, integer growth is unbounded (not a practical issue but semantically wrong).

**Files to change:**
- `src/main/ticket-machine.ts`

**Change:** Delete the module-level `let rpcIdCounter = 0` and `const nextRpcId`. Add `private rpcIdCounter = 0` as an instance field. Replace all `nextRpcId()` call sites with `String(++this.rpcIdCounter)`.

**Tests:** Add to `src/lib/ticket-machine.test.ts`:
```ts
it('RPC ID sequences are independent across instances', () => {
  const m1 = new TicketMachine('t1', callbacks);
  const m2 = new TicketMachine('t2', callbacks);
  // both should start from '1'
  expect(m1['rpcIdCounter']).toBe(0);
  expect(m2['rpcIdCounter']).toBe(0);
});
```

**Size:** XS

---

### Fix 4.5 — Auto-dispatch doesn't enforce per-column `maxConcurrent` ✅ DONE (`34535ea`)

**Root cause:** `autoDispatchTick` checks `MAX_CONCURRENT_SUPERVISORS` globally but does not call `canStartSupervisor(projectId, columnId)`. The `canStartSupervisor` method already handles both global and per-column limits. Auto-dispatch can therefore exceed a column's configured WIP limit.

**Files to change:**
- `src/main/project-manager.ts`

**Change:** In `autoDispatchTick`, replace the inline global count check with:
```ts
if (!this.canStartSupervisor(project.id, nextTicket.columnId)) {
  continue;
}
```

**Tests:** In Phase 5 ProjectManager tests — set up a column with `maxConcurrent: 1`, start one supervisor, trigger `autoDispatchTick`, assert second supervisor is NOT dispatched.

**Size:** XS

---

## Phase 5 — Integration Tests (Weeks 3–4)

**These tests must be written before Phase 6. They are the regression safety net for architectural refactoring.**

The dep-injection interfaces in `src/lib/project-manager-deps.ts` (`ITicketMachine`, `ISandbox`, `ISandboxFactory`, `IMachineFactory`, `IWorkflowLoader`) were designed exactly for this. The scaffolding cost is moderate; the payoff is that every subsequent refactor has a safety net.

---

### Fix 5.1 — `WsHandler` unit tests ✅ DONE (`d784b88`)

**File:** `src/server/ws-handler.test.ts` (new file, ~200 lines)

Use `WebSocketServer` from `ws` directly (same pattern as `src/lib/ticket-machine.test.ts`). `WsHandler` has no Electron dependencies — runs in plain Node.

**Test scenarios:**

```
describe('WsHandler')
  describe('handler routing')
    it registers and calls a global handler
    it per-session handler shadows global handler for same channel
    it returns error response for unknown channel

  describe('session persistence')
    it creates a new session on first connect
    it reattaches existing session when same sessionId reconnects
    it per-session handler registered on WS-A still responds after reconnect as WS-B
    it sendToWindow sends to WS-B after reconnect, not closed WS-A

  describe('event interceptors')
    it fires interceptor with structuredClone of args (mutations don't affect original)
    it fires all registered interceptors in order

  describe('result wrappers')
    it applies result wrapper to invoke response
    it wrapper receives structuredClone of result

  describe('error handling')
    it handler throws → error response sent to client
    it malformed JSON message is silently ignored

  describe('cleanupAllSessions')
    it calls all session cleanup callbacks
    it clears session maps after cleanup

  describe('authentication (after Fix 2.3)')
    it connection without token receives 4401 close
    it connection with wrong token receives 4401 close
    it connection with correct token proceeds
```

**Size:** M

---

### Fix 5.2 — `ProjectManager` orchestration tests ✅ DONE (`e6fda0d`, massively expanded by T1–T11 testing wave to 105 tests covering every major orchestration surface)

**File:** `src/lib/project-manager.test.ts` (new file, ~500 lines)

Build minimal stubs implementing the dep-injection interfaces:

```ts
// src/lib/project-manager.test.ts

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ITicketMachine, ISandbox, IMachineFactory, ISandboxFactory, MachineCallbacks } from './project-manager-deps';
import type { StoreData, TicketId } from '@/shared/types';
import type { TicketPhase } from '@/shared/ticket-phase';

// Minimal in-memory store stub
const makeStore = (initial: Partial<StoreData>) => {
  const data = { ...defaultStoreData, ...initial };
  return {
    get: (k: keyof StoreData) => data[k] as any,
    set: (k: keyof StoreData, v: any) => { data[k] = v; },
    get store() { return data; },
  };
};

// Stub ITicketMachine
const makeMachineStub = (ticketId: TicketId, callbacks: MachineCallbacks): ITicketMachine => {
  let phase: TicketPhase = 'idle';
  return {
    getPhase: () => phase,
    isActive: () => ['provisioning','connecting','running','continuing','retrying','awaiting_input'].includes(phase),
    isStreaming: () => ['running','continuing'].includes(phase),
    getSessionId: () => 'stub-session',
    transition: (to) => { phase = to; callbacks.onPhaseChange(ticketId, to); },
    forcePhase: (to) => { phase = to; },
    setWsUrl: vi.fn(),
    createSession: vi.fn().mockResolvedValue('stub-session'),
    startRun: vi.fn().mockResolvedValue({ sessionId: 'stub-session' }),
    stop: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    recordActivity: vi.fn(),
    cancelRetryTimer: vi.fn(),
    scheduleRetryTimer: vi.fn((ms, cb) => { setTimeout(cb, ms); }),
    continuationTurn: 0,
    retryAttempt: 0,
    lastActivityAt: Date.now(),
  };
};
```

**Test scenarios:**

```
describe('ProjectManager')
  describe('token usage')
    it accumulates tokens across onTokenUsage calls (sum, not max)
    it skips update when totalTokens unchanged

  describe('retry loop')
    it schedules retry after run_end with error reason
    it calls startSupervisor again after retry delay
    it applies exponential backoff on successive failures
    it stops retrying after MAX_RETRY_ATTEMPTS and sets error phase

  describe('stall detection')
    it detects a stalled machine and stops it
    it does not stall a machine that is recording activity
    it only stalls active phases (not idle/error/done)

  describe('auto-dispatch')
    it dispatches a ready ticket when a supervisor slot is available
    it respects per-column maxConcurrent limit (Fix 4.5)
    it respects global MAX_CONCURRENT_SUPERVISORS

  describe('client tool dispatch')
    it calls respond(false, ...) on unknown tool name (Fix 4.2)
    it calls respond(false, ...) when ticket not found
    it get_ticket returns correct ticket shape
    it move_ticket moves ticket to the correct column
    it escalate records an escalation comment

  describe('processManager integration')
    it sets processManager.statusFallback when processManager provided (Fix 3.1)
    it statusFallback returns supervisor sandbox status for ticket-linked tab

  describe('token accumulation (Fix 3.2)')
    it two onTokenUsage events with different values → sum, not max
```

**Note:** Use `vi.useFakeTimers()` for all retry/stall timer tests.

**Size:** L

---

### Fix 5.3 — `AgentProcess` unit tests ✅ DONE (`a295a04`)

**File:** `src/lib/agent-process.test.ts` (new file, ~250 lines)

Mock `child_process.spawn` via `vi.mock('node:child_process')`. No Docker or real subprocesses required.

**Test scenarios:**

```
describe('AgentProcess')
  describe('start() idempotency')
    it is a no-op if already in starting state
    it is a no-op if already in running state

  describe('arg building')
    it sandbox mode builds correct --workspace, --output json, --ui-host flags
    it podman mode sets OMNI_CONTAINER_RUNTIME=podman env var
    it local mode includes --ro-bind for omni venv and --rw-bind for omniagents home
    it none mode uses direct omni CLI invocation with --mode server

  describe('stdout JSON parsing')
    it valid sandbox payload (sandbox_url + ui_url) → connecting status with data
    it valid direct payload ({ url, port }) → connecting status with data
    it malformed JSON line is silently ignored
    it partial line is buffered until newline received
    it only parses first JSON payload (jsonEmitted guard)

  describe('exit handling')
    it exit code 0 while running → exited status
    it exit code 0 while stopping → exited status (not error)
    it non-zero exit → error status with message
    it stderr containing 'address already in use' → port conflict error message

  describe('stop()')
    it sets stopping status and kills child process
    it calls stopActiveContainer for sandbox/podman modes
    it SIGTERM → wait → SIGKILL escalation if process doesn't exit
```

**Size:** M

---

## Phase 6 — Architectural Refactoring (Week 5+, Deferrable)

**Do not start until Phase 5 tests are green. They are the regression safety net.**

### Fix 6.1 — Eliminate `sendStartRunOnce`/`sendStartRun` duplication ✅ DONE (`6ab8c07`)

**Root cause:** `project-manager.ts` (lines 97–180) contains its own WebSocket + JSON-RPC + retry implementation that predates `TicketMachine`. There are now two parallel retry systems with different parameters: `TicketMachine.startRun()` (used for fleet tickets) and `sendStartRun()` (used for task-mode runs). They can drift independently.

**Files to change:**
- `src/main/project-manager.ts`

**Approach:**
1. Audit every `sendStartRun` call site in `ProjectManager`. Each should be replaceable with `machine.startRun(prompt)` — `TicketMachine` already owns the WS URL after `setWsUrl()` is called.
2. Verify retry behavior equivalence: `sendStartRun` uses `maxRetries=10, retryDelayMs=2000`. If `TicketMachine.startRun` behavior differs, adjust it first.
3. Remove `sendStartRunOnce`, `sendStartRun`, and the duplicate `SAFE_TOOL_OVERRIDES` constant (it also exists in `ticket-machine.ts`).

**Size:** M

---

### Fix 6.2 — Extract shared handler registration ✅ DONE (`42aaae3`)

**Root cause:** `config:*` and `util:*` handlers are copy-pasted verbatim between `main/index.ts` (~30 handlers) and `server/managers.ts` (~30 handlers). Fixes to either (e.g., path validation from Fix 2.1) must be applied twice, and drift is inevitable.

**Files to change:**
- `src/shared/ipc-handlers.ts` (new file — extracted registration functions)
- `src/main/index.ts` (replace inline registrations with calls)
- `src/server/managers.ts` (replace inline registrations with calls)

**Approach:** Extract functions with the `IIpcListener` interface from Fix 4.1:

```ts
// src/shared/ipc-handlers.ts
export function registerConfigHandlers(ipc: IIpcListener, configDir: string): void {
  ipc.handle('config:get-omni-config-dir', () => configDir);
  ipc.handle('config:read-json-file', async (_, filePath) => {
    validateConfigPath(filePath, configDir);  // Fix 2.1 lives here — applied once
    // ...
  });
  // etc.
}

export function registerUtilHandlers(ipc: IIpcListener, opts: { isElectron: boolean }): void {
  // shared util handlers, with stubs for desktop-only handlers in non-Electron mode
}
```

**Size:** M

---

### Fix 6.3 — Decompose `ProjectManager` (multi-sprint) 🟡 IN PROGRESS

**Sprint A — PageManager extraction** ✅ DONE (`44fe1d4`). Plus a bonus extraction
of the 440-line migration static method into pure `src/lib/project-migrations.ts`
(`0a6ed05`). `project-manager.ts` went from 4466 → 3880 lines.

**Sprint B — MilestoneManager extraction** ✅ DONE. Moved milestone CRUD,
`completedAt` stamping, orphan-ticket clearing, `resolveTicketBranch` fallback,
and project-cascade deletion into `src/main/milestone-manager.ts` (~120 lines)
using the same narrow-store-adapter pattern as `InboxManager` / `PageManager`.
`ProjectManager` keeps the public `addMilestone`/`updateMilestone`/`removeMilestone`/
`getMilestonesByProject`/`resolveTicketBranch` methods as thin delegators so every
existing callsite (IPC handlers, `handleClientToolCall`, supervisor branch resolution)
stays identical. The T9 milestone-CRUD tests still pass unchanged.

**Sprint C — SupervisorOrchestrator split** ⏳ PENDING. The ~2500 lines of ticket
lifecycle, retry queue, stall detection, auto-dispatch, client tool dispatch,
worktree management, and files-changed diffing. This is the XL refactor the whole
test wave was building safety nets for. Suggested execution plan when ready:

- **C1:** Move pure helpers out (`buildContinuationPrompt`, `getSessionHistory`,
  worktree helpers, migrations — migrations already done). Delta: ~600 lines.
- **C2:** Create `SupervisorOrchestrator` class in-file first, then move to
  `src/main/supervisor-orchestrator.ts`. Transfer: `machines` map, `tasks` map,
  `ticketLocks`, timers, `ensureSupervisorInfra`, `startSupervisor`,
  `stopSupervisor`, `sendSupervisorMessage`, `resetSupervisorSession`,
  `cleanupTicketWorkspace`, `handleMachineRunEnd`, `startMachineRun`,
  `sendUserRunMessage`, retry queue, stall detection, auto-dispatch,
  `handleClientToolCall`, `validateDispatchPreflight`, concurrency helpers,
  `getFilesChanged`, artifact helpers, `resolveTicketWorkspace`, `ensureSession`.
- **C3:** Thin `ProjectManager` to a coordinator that owns project CRUD +
  `getProjectDirPath` + pipeline helpers, and delegates via references to
  `PageManager`, `InboxManager`, `MilestoneManager` (if done), `SupervisorOrchestrator`.
- **C4:** Split `registerProjectHandlers` into per-module IPC registration functions.

Prerequisite: all 812 current tests green (they are). Any Sprint C step that breaks
a test must be rolled back or fixed in the same commit — no red states allowed during
the orchestrator move.

**Original root-cause note** (retained for reference): `ProjectManager` was 4,559 lines
and mixed ticket lifecycle orchestration, git operations, page CRUD, milestone
management, inbox wiring, file watching, sandbox factory, and worktree management.
The dep-injection interfaces in `src/lib/project-manager-deps.ts` were a step toward
testability but the class itself was never split. As of 2026-04-14, Sprint A + the
migrations extraction have reduced `project-manager.ts` to 3880 lines and pulled
~800 lines of logic into testable modules (`src/main/page-manager.ts`,
`src/lib/project-migrations.ts`).

**Size:** XL overall — Sprint A was M and shipped; Sprint C remains the largest
piece and carries the most regression risk. The T1–T11 testing wave (812 tests)
built the safety net it needs.

---

## Effort Estimates

| Fix | Phase | Size | Status | Notes |
|-----|-------|------|--------|-------|
| 1.1 Page.properties roundtrip | 1 | S | ✅ | Type + schema + serialize/parse |
| 2.1 Config path validation | 2 | S | ✅ | Helper + 8 use sites (4 handlers × 2 files) |
| 2.2 SSRF proxy auth | 2 | S | ✅ | Loopback IP check on `_register` |
| 2.3 WS authentication | 2 | M | ✅ | Token gen + route guard + renderer change |
| 3.1 processManager in server mode | 3 | S | ✅ | Reorder + pass one arg |
| 3.2 Token accumulation | 3 | XS | ✅ | 3-line change |
| 4.1 Eliminate `as any` | 4 | M | ✅ | New interface + thread through factories |
| 4.2 `respond(false)` on errors | 4 | S | ✅ | Mechanical, ~20 sites |
| 4.3 chokidar in WorkspaceSyncManager | 4 | S | ✅ | Swap import + API |
| 4.4 rpcIdCounter → instance field | 4 | XS | ✅ | Move to instance |
| 4.5 Auto-dispatch column WIP limit | 4 | XS | ✅ | One `canStartSupervisor` call |
| 5.1 WsHandler tests | 5 | M | ✅ | ~200 lines |
| 5.2 ProjectManager tests | 5 | L | ✅ | Initial ~500 lines; then T1–T11 wave to 105 tests |
| 5.3 AgentProcess tests | 5 | M | ✅ | ~250 lines |
| 6.1 sendStartRun dedup | 6 | M | ✅ | Audit + remove |
| 6.2 Shared handler extraction | 6 | M | ✅ | Mechanical extraction |
| 6.3 Sprint A PageManager | 6 | M | ✅ | 348 lines moved out |
| 6.3 Migrations extraction (bonus) | 6 | M | ✅ | 440 lines moved to pure lib |
| 6.3 Sprint B MilestoneManager | 6 | S | ✅ | ~120 lines extracted via narrow store adapter |
| 6.3 Sprint C SupervisorOrchestrator split | 6 | XL | ⏳ | Remaining ~2500 lines; safety net in place |
| T1–T11 deep testing wave (follow-up) | 5+ | L | ✅ | +92 tests, 7 bugs fixed |

---

## Recommended Execution Sequence

```
Week 1, Days 1–2:
  Fix 1.1   Page.properties (unblock CI, fastest fix)
  Fix 3.2   Token accumulation (3 lines)
  Fix 4.4   rpcIdCounter instance field (trivial)
  Fix 4.5   Auto-dispatch column WIP limit (trivial)
  Fix 4.2   respond(false) on errors (mechanical)

Week 1, Days 3–5:
  Fix 2.1   Config path validation  ─┐ security sprint,
  Fix 2.2   SSRF proxy auth          ├ can be parallelized
  Fix 3.1   processManager wiring   ─┘

Week 2:
  Fix 2.3   WS authentication (renderer change required — coordinate)
  Fix 4.1   Eliminate as any (interfaces stabilized by 2.3 work)
  Fix 4.3   chokidar in WorkspaceSyncManager

Weeks 3–4:
  Fix 5.1   WsHandler tests
  Fix 5.2   ProjectManager tests    ← needs Fix 3.1 + 3.2 done first
  Fix 5.3   AgentProcess tests

Week 5+:
  Fix 6.1   sendStartRun dedup
  Fix 6.2   Shared handler extraction
  Fix 6.3   ProjectManager decomposition  ← multi-sprint, needs 5.x green
```

---

## Dependencies Between Fixes

```
Fix 1.1  ──── independent
Fix 2.1  ──── independent (foundational for Fix 6.2)
Fix 2.2  ──── independent
Fix 2.3  ──── independent (Fix 4.1 easier after 2.3 interface work)
Fix 3.1  ──── independent (processManager must be created before PM in managers.ts)
Fix 3.2  ──── independent
Fix 4.1  ──── best after Fix 2.3 (interfaces stabilized)
Fix 4.2  ──── independent
Fix 4.3  ──── independent
Fix 4.4  ──── independent
Fix 4.5  ──── independent
Fix 5.1  ──── best after Fix 2.3 (auth shape is known)
Fix 5.2  ──── needs Fix 3.1 + Fix 3.2 done first (tests should start green)
Fix 5.3  ──── independent
Fix 6.1  ──── needs Fix 5.2 (safety net)
Fix 6.2  ──── needs Fix 4.1 (IIpcListener interface), Fix 2.1 (validation helper)
Fix 6.3  ──── needs Fix 5.2 + Fix 5.3 green (safety net for regressions)
```
