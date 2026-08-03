# AgentHost and Execution Environments: Decision-Complete Plan

## Status

Approved direction for replacing the per-tab `omni serve` topology. This is a
clean architectural break. Omni has not been distributed and has no external
users, so implementation compatibility with the legacy topology is explicitly
out of scope.

The implementation remains staged into reviewable commits to control
engineering risk, but the finished product contains only the new architecture.

### Implementation checkpoint — 2026-08-02

Completed through the framework/runtime vertical slice:

- AgentHost-owned Workspace, ExecutionEnvironment, EnvironmentLease, and
  atomic ThreadRuntimeBinding registries.
- Mandatory execution metadata for typed RPC operations and server functions,
  resolved once at the dispatcher into a RequestContext.
- Explicit `start_run` selection (`none`, `inherit`, or generation-checked
  environment), including nested-environment authorization.
- Files, Git, terminals, background jobs, lifecycle operations, and workspace
  information routed through environment leases.
- AgentHost identity plus optional default Workspace/Environment bindings in
  protocol initialization.
- Removal of process-wide/default HostWorkspace routing and AgentService's
  path-derived workspace fallback/resolver. Targetless Runs actively clear
  inherited workspace context and fail closed for workspace/process tools.
- Launcher and standalone Web/Ink RPC clients migrated from session-scoped
  Files/Git requests to environment-scoped requests.
- SDK sandbox sessions and `run_as` identity owned by immutable environment
  leases. Agent construction now derives a Run-scoped adapter spec, including
  concurrent Runs on different environments and generation-safe replacement;
  product startup and profile switching no longer mutate the shared AgentSpec.
- Terminal shell/cwd/user defaults owned by environment leases. The AgentHost
  keeps one terminal registry for socket authorization and lifecycle, while
  each terminal selects its backend and defaults from its captured environment
  instead of a mutable process-wide profile manager.
- Worker source isolation derives paths from the current Run's Workspace and
  EnvironmentLease. Worker specifications inherit declarative project context,
  never a sandbox session copied from an orchestrator AgentSpec.
- Skill roots derive from the current Run, and environment-owned skill files
  are read through the leased Workspace adapter. Devbox paths such as
  `/workspace` are never probed on the AgentHost filesystem.
- Agent-facing sandbox observation resolves the environment lifecycle
  controller from the Run lease. Filesystem, source, project, AgentSpec,
  sandbox-session, and discard-snapshot process globals have been deleted;
  utility-agent helpers no longer fall back to serve-global placement.
- Launcher main-process ownership now has a compatibility/security-keyed
  `AgentHostManager`. Interactive tabs with unrelated Workspaces and profiles
  attach to one live host, receive environment-tailored status plus fan-out
  output events, and detach independently; the host is stopped only after its
  final consumer leaves. Delegated compute, resident principals, host-bridge
  machines, and credential-bearing launches remain deliberately isolated.
- `AutomaticEnvironment(profile_id)` now resolves through an AgentHost-owned
  provisioner. Request preparation resolves the durable Workspace without side
  effects so authorization happens first; the authorized Run then materializes
  and captures an immutable environment lease. Concurrent selections for the
  same Workspace/profile single-flight one environment, while separate
  Workspaces remain isolated and stopped environments reprovision cleanly.
- The product runtime now has a multi-environment provisioning adapter that
  consumes explicit Workspace/profile resolvers, creates host or sandbox
  Workspace adapters, and publishes sandbox runtime, terminal defaults,
  capabilities, services, and lifecycle state as one owned environment.
  Environment stop releases its sandbox session and services before publishing
  the stopped state.
- Typed AgentHost control-plane RPCs register owner-scoped Workspaces and
  profile definitions, materialize and stop environments, bind Threads, and
  list resources. Host-path registration is admin-only and uses a distinct
  launcher control credential that is never exposed in readiness or renderer
  state.
- The launcher uses a persistent typed main-process control channel to bind
  each tab to its own Workspace/environment. Profile switches materialize and
  bind a replacement before retiring the prior environment. Rebuilds withdraw
  and stop the ready environment first so automatic materialization cannot
  reuse it, then bind a fresh replacement. Closing one tab stops only its
  environment. Failed profile materialization or binding rolls back without
  orphaning the host or a newly created environment.
- Consumer readiness is derived solely from that consumer's recorded runtime
  binding. A live shared host never supplies fallback Workspace, environment,
  container, service, or endpoint metadata to an unbound or rebuilding
  consumer. Ticket URL lookup, container ownership, reconnect, and offline
  notification paths all pass through the same consumer-scoped status boundary.
- The embedded React client now receives one typed runtime connection
  (`baseUrl` plus optional authentication) rather than the legacy UI-oriented
  `uiUrl`/token pair. The unused Webview-era split component has been removed.
- Permanent Electron E2E proves two unrelated host-profile Workspaces share one
  AgentHost while retaining distinct Workspace/environment identities and Files
  contents.
- Permanent Electron E2E also proves two Devbox Workspaces share one AgentHost
  while retaining distinct environment and container identities. Alpha Files
  can edit its mounted source, Alpha Git observes that change, Alpha Terminal
  executes at `/workspace`, and Beta Files remains isolated and unchanged.
- Main-process Terminal RPC now completes the mandatory GUI protocol handshake
  before session or terminal operations. This defect was found by the Devbox
  product proof after Files and Git had already routed successfully.
- All launcher-owned JSON-RPC WebSocket clients now share one typed
  initialize/initialized handshake boundary. This covers AgentHost control,
  Terminal, lifecycle one-shot calls, and resident watchers; a source-level
  completeness test fails when a new main/server JSON-RPC client bypasses the
  boundary. Resident watchers also retain the runtime bearer credential rather
  than dialing an authenticated host anonymously.
- Permanent Electron E2E now proves one pooled host survives a real UI profile
  switch, a destructive environment rebuild, and an independent session close.
  Alpha receives new environment/container identities at each required
  boundary, while Beta retains its exact host, Workspace, environment, and
  container identity and remains usable after Alpha closes.
- The same permanent lifecycle story now runs through browser/server mode's
  authenticated WebSocket transport. Its per-tenant ProcessManager exhibits
  the same pooled-host ownership, environment replacement, status isolation,
  and independent close behavior as Electron; visual proof is retained for the
  server surface as well.
- The final process-global sandbox lifecycle slot has been removed. Product
  startup constructs environment-owned lifecycle state and registers it only
  behind that environment's controller; shutdown retains the same explicit
  state reference. `omni-code` context and worker consumers now derive source
  mounts exclusively from the routed Workspace and EnvironmentLease. The
  obsolete `serve_state` module and product-side singleton tests are deleted.
- AgentHost shutdown is now an environment-manager operation. It drains
  provisioning already in flight, rejects new environments once shutdown
  begins, and closes every ready environment even if one peer fails. Idle
  watcher cancellation is part of common environment teardown, so product
  serve no longer reaches into the startup sandbox session specially.
- In-place `sandbox.switch` has been deleted end to end. The framework no
  longer exposes a live-environment mutation operation or switch/rollback
  orchestration, and startup uses the same scoped lifecycle controller as
  provisioned environments. The launcher's dead direct RPC method is removed;
  profile selection retains the existing materialize-and-rebind path.
- Serve protocol v2 starts a targetless AgentHost with no startup Workspace,
  profile, session, container, or execution environment. Every launcher
  consumer, including the first, registers its Workspace/profile and
  materializes and binds an environment through the same control-plane path.
  Snapshot identity is Workspace data (`snapshot_ref`), not AgentHost process
  identity. Pause, unpause, activity, and snapshot discard now name the
  selected consumer environment explicitly, so pooled consumers cannot mutate
  a peer's lifecycle state. Consumer stop remains pending until environment
  teardown completes, and AgentHost cleanup drains those stops before closing
  the shared control channel.

Next: run the final routing and legacy-surface audit, then complete the broad
product/launcher proof matrix.

## Executive decision

A conversation, agent run, workspace, execution environment, and operating
system process are independent resources.

- Creating a thread does not create a sandbox or server process.
- A thread may have no workspace and no execution environment.
- A workspace is durable project state.
- An execution environment is a live place where tools operate on a workspace.
- An AgentHost is a long-lived control-plane process that owns many threads and
  many execution environments.
- Sandbox and permission policy determine how operations are restricted; they
  do not define conversation or process lifecycle.
- JSON-RPC remains the transport, but execution scope becomes mandatory
  protocol metadata resolved at a central dispatcher boundary.
- The launcher pools AgentHosts by a deliberate compatibility/security key,
  never by tab or thread identity.
- The current `omni serve` per-session composition and all process-global
  execution routing are deleted after cutover.

## Why this change is necessary

The present topology uses an OS process as an implicit execution-environment
identifier:

```text
Code tab -> AgentProcess -> omni serve -> AgentService -> one live sandbox
```

This is legacy composition left over from the previous model where the agent
server ran inside a sandbox container. The model loop now runs independently
from sandbox lifecycle, but the per-tab process boundary still owns manifest,
workspace, sandbox session, profile switching, terminal, services, snapshot,
and credentials as one bundle.

The framework already supports multiple conversation sessions in one
`AgentService`. What it does not currently support safely is multiple explicit
execution environments because runtime state is process-global or installed
through optional callbacks.

This is also why sandbox routing is repeatedly missed when the RPC surface is
expanded. Authorization has a central dispatcher checkpoint and completeness
tests; execution placement does not. New Files, Git, terminal, job, or server
function handlers can accidentally use the host because the framework does not
require them to declare or resolve an execution target.

## Non-goals

- Preserving the old per-tab `omni serve` runtime as a fallback.
- Supporting old and new protocol versions in the same product.
- Preserving the combined conversation/session/snapshot identifier.
- Migrating existing development-only local state automatically.
- Replacing JSON-RPC with another transport.
- Moving the model loop into a sandbox.
- Requiring a separate execution-server process for local host execution.
- Combining all product runtimes into one universal process regardless of
  dependency or credential boundaries.

## Domain model

### AgentDefinition

An `AgentDefinition` owns declarative agent behavior:

- Instructions.
- Model defaults and model policy.
- Tool declarations.
- Product extensions and registered server operations.
- Required and optional execution capabilities.

An AgentDefinition does not own a sandbox session or mutable execution
environment. Any SDK `SandboxAgent` use is an internal per-run implementation
choice made after environment resolution.

### Thread

A `Thread` owns durable conversation state:

- Transcript and history.
- User/model settings.
- Approval state.
- Agent definition selection.
- One atomic `ThreadRuntimeBinding`.

A Thread does not own an AgentHost process or sandbox lifecycle.

### Run

A `Run` is one execution of an AgentDefinition against a Thread. It captures:

- `run_id`.
- `thread_id`.
- `agent_definition_id`.
- The resolved runtime selection.
- An immutable `EnvironmentLease`, when an environment is used.
- Permission profile and approval policy.
- The compiled tool plan.
- Cancellation and completion state.

An active Run never follows a mutable global "current sandbox." It continues
against its captured lease or terminates with a typed environment-change error.

### Workspace

A `Workspace` is durable project identity and state:

```text
workspace_id
sources
snapshot reference
repository metadata
persistence policy
created/updated timestamps
```

A Workspace can exist without a live execution environment. Stopping or
replacing an environment must not destroy the Workspace identity.

### ExecutionEnvironment

An `ExecutionEnvironment` is a live tool runtime:

```text
environment_id
workspace_id
generation
kind: host | devbox | remote
profile/configuration
state
filesystem backend
process executor
PTY backend
HTTP client
service endpoints
capabilities
lifecycle lock
```

Environment state is one of:

```text
provisioning -> ready -> replacing -> ready
                      -> stopping -> stopped
                      -> failed
```

Every coding-capable environment operates on exactly one Workspace. One
Workspace may be materialized by multiple environments over time or
simultaneously. Multiple Threads may deliberately share the same Workspace and
environment.

### EnvironmentLease

An `EnvironmentLease` is an immutable operation-scoped view containing:

```text
environment_id
workspace_id
generation
filesystem
process executor
PTY backend
HTTP client
service endpoints
capabilities
```

Replacing an environment increments its generation. Existing operations either
finish on the captured generation, are explicitly cancelled, or fail with
`environment_changed`. They never jump to a replacement environment or host.

### ThreadRuntimeBinding

Workspace and environment are separate domain objects, but a Thread does not
store two unrelated optional defaults. It stores one validated, atomically
updated binding:

```python
ThreadRuntimeBinding(
    workspace_id: WorkspaceId | None,
    environment_selection:
        NoEnvironment
        | AutomaticEnvironment(profile_id)
        | ExistingEnvironment(environment_id),
)
```

Valid states:

- `workspace=None`, `environment=none`: model/MCP/client-only Thread.
- `workspace=W1`, `environment=none`: project-associated Thread with no live
  tool runtime.
- `workspace=W1`, `environment=automatic(devbox)`: lazily create or resume a
  Devbox operating on W1.
- `workspace=W1`, `environment=E1`: valid only when
  `E1.workspace_id == W1`.

An explicit environment belonging to another Workspace is rejected. Binding
both resources for a new coding Thread is one atomic operation; there is no
intermediate state where the Thread points at mismatched resources.

### AgentHost

An `AgentHost` is the long-lived control plane containing:

```text
AgentDefinitionRegistry
ThreadManager
RunCoordinator
WorkspaceRegistry
ExecutionEnvironmentManager
OperationRouter
```

The initial AgentHost reuse key is:

```text
product/runtime package and version
+ authenticated principal
+ provider credential scope
+ trusted extension/dependency set
```

This retains process isolation where it has a real dependency or security
purpose. Profile, workspace, environment, and Thread identity are not part of
the process key.

## Process topology

### Launcher and AgentHost

The launcher owns an `AgentHostManager` that supervises one AgentHost for each
active compatibility key. Opening additional compatible tabs reuses the same
host and creates or resumes Threads through RPC.

An AgentHost crash affects the Threads within that compatibility domain, but it
does not define or own their durable identity. On restart, the host reloads the
new-schema Thread and Workspace records and lazily re-establishes environments.

### Local host environment

An explicit `HostEnvironment` uses in-process filesystem, process, PTY, and
HTTP backends. Local execution requires no additional server process.

Host is never the fallback meaning of missing or failed environment resolution.

### Devbox environment

The AgentHost owns or connects to the SDK sandbox session through an
`ExecutionEnvironment` object. The model loop, history, approvals, and RPC
control plane remain in the AgentHost.

Initially, a shared AgentHost may own multiple SDK sandbox session handles
directly. A separate broker is not required to remove per-tab serve processes.

### Remote environment

The existing `sandbox-host` concept evolves into a narrow execution service
responsible for:

- Filesystem operations.
- Process execution.
- PTYs.
- Target-side HTTP.
- Service discovery/forwarding.
- Sandbox enforcement.

It does not host conversations, model loops, or AgentDefinitions. A separate
broker process is introduced only when required for remote transport, crash
containment, untrusted code, credential isolation, or environment pooling.

### CLI decision

The launcher-facing per-session `omni serve` command is deleted and replaced by
`omni agent-host`, which starts the multi-thread, multi-environment runtime.

If standalone HTTP deployment is later required, it is implemented as a
deployment wrapper around the same AgentHost library rather than another
session architecture.

## Placement, sandboxing, and tool availability

Placement and restriction are independent:

```text
ExecutionEnvironment = where tools operate
PermissionProfile    = what those operations may do
```

The RunCoordinator combines:

- AgentDefinition tool requirements.
- Selected environment capabilities.
- Permission profile.
- Approval policy.

It compiles the per-run tool plan accordingly:

- Model, web, MCP, connector, and client tools may run without an environment.
- Workspace tools require filesystem capability.
- Shell tools require process capability.
- Terminal tools require PTY capability.
- Environment lifecycle tools require explicit lifecycle authority.
- Missing required capabilities produce a typed error or omit the tool
  according to the tool's declared policy.
- Sandbox initialization failure never downgrades a requested sandbox run to
  host execution.

`SandboxAgent` may remain as an internal SDK adapter for SDK-native sandbox
capabilities. Mutable sandbox sessions are not stored on a shared AgentSpec.

## RPC and server-function model

JSON-RPC remains the transport. Each typed RPC and registered server function
must declare:

```python
resource_scope:
    connection
    principal
    agent_host
    agent
    thread
    run
    workspace
    environment
    extension

execution_requirements:  # composable flags, not a single enum value
    run_plan
    workspace_read
    workspace_write
    process
    network
    pty
    environment_lifecycle
    extension_declared
```

An empty requirement set means that the operation needs no execution
environment. Resource scope and execution requirements are intentionally
orthogonal: for example, `git.push` is workspace-scoped and requires
workspace-write, process, and network capabilities, while an environment
lifecycle operation is environment-scoped and requires lifecycle authority.
An extension call is not implicitly trusted; its registered descriptor supplies
the requirements that the outer transport cannot know statically.

Optional descriptor fields include mutation behavior, idempotency, capability
requirements, lazy-provision permission, and audit classification.

The dispatcher performs these steps for every operation:

1. Authenticate the connection.
2. Authorize the named resource.
3. Resolve AgentDefinition, Thread, Run, Workspace, and environment references.
4. Validate `ThreadRuntimeBinding` invariants.
5. Acquire an immutable EnvironmentLease when required.
6. Validate the operation's capabilities and current environment state.
7. Inject a typed RequestContext.
8. Invoke the handler.

Handlers receive:

```python
RequestContext(
    principal=...,
    agent_definition=...,
    thread=...,
    run=...,
    workspace=...,
    environment_lease=...,
)
```

Handlers may not:

- Read `serve_state`.
- Call a process-global `get_sandbox_session()`.
- Construct `HostWorkspace` as a fallback.
- Infer substrate from a path such as `/workspace`.
- Select between host and sandbox backends independently.

### Addressing rules

Control-plane operations require no environment:

```text
agent.*
thread.*
run.interrupt
model.*
auth.*
```

Environment lifecycle operations name an environment explicitly:

```text
environment.create
environment.get
environment.list
environment.replace
environment.stop
thread.bindRuntime
```

Out-of-run operations name an environment explicitly because they may execute
without an active Run:

```text
fs.list       { environment_id, path }
fs.read       { environment_id, path }
fs.write      { environment_id, path, ... }
git.status    { environment_id, repository }
terminal.open { environment_id, cwd }
job.list      { environment_id }
```

Run creation uses an explicit selection union:

```text
run.start {
  thread_id,
  agent_definition_id,
  environment_selection:
    { mode: "inherit" }
    | { mode: "none" }
    | { mode: "explicit", environment_id: "..." }
}
```

Built-in Files, Git, terminal, workspace, and environment operations become
typed RPCs. Dynamic extension functions may continue using the server-function
transport, but registration requires the same operation descriptor and every
invocation passes through the same router.

A completeness test rejects every unclassified RPC or server function. This is
the execution equivalent of the existing authorization completeness guard.

### Typed errors

The protocol defines at least:

```text
environment_required
environment_not_found
environment_unavailable
environment_changed
capability_unavailable
workspace_not_found
workspace_environment_mismatch
```

These errors replace implicit fallbacks and generic filesystem permission
failures caused by accidentally accessing host paths.

## Persistence and identity

The new system uses independently generated IDs:

```text
agent_definition_id
thread_id
run_id
workspace_id
environment_id
agent_host_id
```

No ID is reused as another resource's identity.

There is no automatic migration of development-only legacy state. The new
runtime uses a bumped schema and a new storage namespace. Old state is left
untouched on disk but ignored by the application. If any personal history or
snapshot matters, it can be recovered through a one-off export/import tool
without introducing legacy semantics into the runtime.

## Implementation waves

### Wave 0: decision artifacts and executable guardrails

Deliverables:

- This architecture decision becomes the implementation authority.
- Inventory every typed RPC and registered server function.
- Classify every operation's resource and execution requirements.
- Define new protocol resource types and typed errors.
- Add characterization coverage for the current routing failures.
- Add a reusable two-environment isolation harness.

Required tests:

- Two environments both expose `/workspace` and cannot cross-read.
- Files and Git operate correctly outside an active agent Run.
- A Thread with no environment can run model/MCP/client tools.
- Host execution occurs only with an explicit HostEnvironment.
- Devbox Files reads the Devbox filesystem.
- An active operation cannot jump targets during environment replacement.
- An unclassified RPC or server function fails CI.

The current Devbox Files patch may land as a small isolated bug fix because the
redesign spans multiple waves. It must not be expanded into a permanent
compatibility layer.

### Wave 1: environment and workspace foundation

Implement:

- `ExecutionEnvironment`.
- `EnvironmentLease`.
- `ExecutionEnvironmentManager`.
- `Workspace` and `WorkspaceRegistry`.
- `ThreadRuntimeBinding` and atomic validation.
- Environment lifecycle states and generations.
- Explicit `HostEnvironment`.
- Devbox environment adapter.
- Remote environment adapter interface.

Make `ExecutionEnvironmentManager` and `WorkspaceRegistry` mandatory
AgentService construction dependencies.

Remove:

- Optional `workspace_factory` wiring.
- Default HostWorkspace creation.
- Process-wide default workspace behavior.

The application may temporarily register only one environment while this wave
lands, but all access must use the final interfaces. This is implementation
sequencing, not a supported compatibility mode.

### Wave 2: operation router and protocol contracts

Implement:

- Resource/execution metadata in the typed protocol catalog.
- Equivalent mandatory metadata for server functions.
- Typed RequestContext.
- Central resource and environment resolution.
- EnvironmentLease acquisition.
- Capability validation.
- Typed error serialization.
- Protocol completeness tests.

Migrate one complete vertical slice:

```text
Thread
-> ThreadRuntimeBinding
-> Devbox environment
-> fs.list/fs.read
-> git.status
-> agent shell/apply-patch
```

Exit gate: the Files UI, Git state, and agent tools for one Devbox Thread all
observe the same filesystem through the new router, including outside an active
Run.

### Wave 3: parallel subsystem migration

After the router contract is frozen, run three parallel implementation lanes.

#### Lane A: workspace operations

- Filesystem RPCs.
- Git RPCs.
- Workspace information.
- Source writability policy.
- Filesystem watches.
- Upload/download transfers.
- Snapshot access.

#### Lane B: runtime I/O

- Terminal creation and attachment.
- Terminal input/output/resize/close.
- Bash and background jobs.
- Process execution.
- Service endpoints.
- Environment-scoped job and terminal cleanup.

#### Lane C: agent runtime

- Run creation.
- Per-run tool-plan capability filtering.
- Workspace binding.
- `SandboxAgent` adaptation where genuinely required.
- MCP servers and HTTP clients owned by environments.
- Environment-native skills, plugins, and paths.

The primary integration lane owns lease semantics, cancellation, environment
replacement, shared interfaces, and cross-subsystem tests.

Exit gate: no execution-sensitive handler directly accesses `serve_state`, a
global sandbox session, or an implicit HostWorkspace.

### Wave 4: multi-thread, multi-environment AgentHost

Move every remaining global into the resource that owns it:

| Existing state              | New owner                                               |
| --------------------------- | ------------------------------------------------------- |
| Manifest/product definition | AgentDefinition                                         |
| Sources and snapshot        | Workspace                                               |
| Sandbox session and profile | ExecutionEnvironment                                    |
| Sandbox switch lock         | ExecutionEnvironment                                    |
| Terminal manager            | Environment-scoped terminal registry                    |
| Job manager                 | Environment-scoped job registry                         |
| Active run state            | RunCoordinator                                          |
| Conversation history        | ThreadManager                                           |
| Credentials                 | AgentHost principal scope or explicit environment scope |

Implement and prove:

- Many Threads in one AgentHost.
- Many environments in one AgentHost.
- Multiple Threads deliberately sharing one environment.
- Multiple environments materializing one Workspace.
- Per-Run environment override.
- Atomic Thread runtime rebinding.
- Targetless Threads.
- Environment replacement without shared-spec mutation.

Replace the `product_serve.py` composition path with AgentHost construction.
Delete mutable sandbox session storage from shared AgentSpecs.

### Wave 5: launcher cutover

Replace per-tab process lifecycle with:

```text
AgentHostManager
AgentHostConnection
ThreadController
WorkspaceController
EnvironmentController
```

New tab flow:

1. Resolve an AgentHost by compatibility key.
2. Create or resume a Thread.
3. Create or select a Workspace when the user opens a coding project.
4. Select `none`, `automatic(profile)`, or an existing environment.
5. Atomically bind the Thread runtime.
6. Start Runs without spawning another server.

Files, Changes, Terminal, Services, and profile controls receive the current
runtime binding explicitly. Changing profiles replaces or rebinds an
environment; it does not restart the Thread or AgentHost.

The launcher and backend protocol cut over together. There is no fallback to
the old per-tab topology.

Primary launcher code expected to be replaced or substantially rewritten:

- `src/main/agent-process.ts`
- `src/main/process-manager.ts`
- `src/renderer/features/Code/use-code-auto-launch.ts`
- The current compute abstraction that returns an agent endpoint and sandbox
  as one resource.

### Wave 6: legacy deletion

Delete:

- Process-global `serve_state` runtime routing.
- The per-session `omni serve` harness.
- Combined conversation/snapshot identity.
- Launcher per-tab AgentProcess ownership.
- Optional workspace-routing hooks.
- Implicit host fallbacks.
- Sandbox switching through shared AgentSpec mutation.
- Built-in execution operations implemented as untyped server functions.
- CLI arguments that only exist to compose one process per session.
- Tests asserting singleton behavior.

Add architecture checks that forbid handler-level imports or calls to legacy
runtime-global APIs.

Update product documentation around `omni agent-host`, Threads, Workspaces, and
Execution Environments.

## Parallel-agent sequencing

With four available slots, including the primary agent:

| Wave | Primary agent                | Parallel agent 1     | Parallel agent 2         | Parallel agent 3      |
| ---- | ---------------------------- | -------------------- | ------------------------ | --------------------- |
| 0    | ADR/contracts/integration    | RPC inventory        | global-state inventory   | isolation-test design |
| 1    | interfaces/integration       | environment adapters | workspace registry       | foundation tests      |
| 2    | operation-router integration | typed RPC metadata   | server-function metadata | vertical-slice tests  |
| 3    | lifecycle/integration        | Files and Git        | terminals and jobs       | runs and tools        |
| 4    | AgentHost integration        | global-state removal | sandbox lifecycle        | concurrency tests     |
| 5    | launcher integration         | AgentHostManager     | UI runtime bindings      | launcher E2E          |
| 6    | final integration            | backend deletion     | launcher deletion        | docs and final tests  |

Shared interfaces are frozen before Wave 3. Parallel agents do not independently
change resource identity, RequestContext, EnvironmentLease, or operation
descriptor contracts after that point; such changes remain centralized with
the primary agent.

## Landing sequence

Use these reviewable landing units:

1. Existing Devbox Files hotfix, isolated from architecture work.
2. Architecture types, operation inventory, and characterization tests.
3. Workspace and environment registries with atomic ThreadRuntimeBinding.
4. Mandatory operation metadata and RequestContext routing.
5. Devbox Files/Git/agent vertical slice.
6. Remaining Files/Git/watch/transfer migration.
7. Terminal/job/process/service migration.
8. Run/tool/SandboxAgent/MCP migration.
9. Lifecycle, generation, and environment replacement migration.
10. Multi-thread/multi-environment AgentHost.
11. Launcher AgentHostManager and tab lifecycle cutover.
12. Files/Changes/Terminal UI binding cutover and visual proof.
13. Legacy backend and launcher deletion.
14. Final architectural audit, broad tests, and documentation.

Intermediate commits may temporarily leave unused new abstractions or unused
legacy paths in the tree, but no released or final branch state supports two
runtime modes.

## Validation gates

### Framework gates

- An unclassified RPC or server function fails CI.
- No environment never constructs a HostWorkspace.
- Host execution requires an explicit HostEnvironment.
- Missing sandbox initialization fails closed.
- Environment generations are validated for every lease.
- Tool exposure follows environment capability availability.
- ThreadRuntimeBinding rejects Workspace/environment mismatches.

### Isolation gates

- Two environments with identical internal `/workspace` paths cannot
  cross-read or cross-write.
- Two Threads can intentionally share one environment.
- Separate environments have separate terminals, jobs, watches, transfers,
  services, and Git state.
- Replacing one environment does not affect another.
- Agent tools and out-of-run RPCs resolve the same environment.

### Lifecycle gates

- Creating a targetless Thread starts no sandbox or extra server.
- Devbox provisioning is lazy when `AutomaticEnvironment` is selected.
- Closing a Thread does not stop an environment still used by another Thread.
- Stopping an environment invalidates or drains its leases deterministically.
- AgentHost restart reloads new-schema Threads and Workspaces.
- Failed environment startup never falls back to host.
- Stopping or replacing an environment preserves Workspace identity.

### Launcher E2E gates

- Opening multiple compatible tabs creates one AgentHost process.
- Devbox Files shows Devbox contents.
- Changes shows the selected environment's Git state.
- Terminal opens in the selected environment and correct cwd.
- Profile switching preserves Thread and Workspace identity.
- A model-only Thread works without Files or shell tools.
- Two Devbox tabs remain isolated.
- Two Threads sharing an environment see the same intended changes.
- Playwright visual proof is produced for every changed user-facing story.

### Performance and operational gates

- AgentHost process count depends on compatibility keys, not tab count.
- Creating a Thread does not allocate an environment unless its binding
  requests one.
- Idle environments can be stopped independently of Threads.
- One environment failure does not corrupt another environment's registries.
- AgentHost shutdown reports active Runs and environments before termination.

## Root architectural invariants

The following invariants are permanent:

1. `thread_id`, `run_id`, `workspace_id`, and `environment_id` are never
   interchangeable.
2. A path has meaning only within an identified environment filesystem.
3. Host execution is explicit and never a fallback.
4. Every execution-sensitive operation is centrally classified and routed.
5. Every active operation uses an immutable environment generation.
6. A Workspace outlives any individual environment that materializes it.
7. A Thread may exist and run without execution-environment tools.
8. Process placement is a deployment and isolation decision, not conversation
   identity.
9. Built-in and extension operations use the same routing enforcement.
10. No process-global variable determines the current execution target.

## Definition of done

The redesign is complete when:

- Creating a Thread creates neither a sandbox nor a new AgentHost.
- Opening ten compatible tabs still uses one AgentHost.
- Files, Git, Terminal, Services, agent tools, MCP resources, and environment-
  native skills agree on environment identity.
- Targetless, explicit-host, Devbox, and remote Threads all use the same domain
  and RPC model.
- Environment replacement cannot redirect in-flight work.
- Workspaces persist independently of environment lifetime.
- All execution routing is enforced by the framework rather than product
  composition callbacks.
- The launcher exclusively uses the new AgentHost topology.
- The old `omni serve` per-session path and process-global execution state have
  been deleted.
