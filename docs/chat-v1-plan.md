# chat-v1 — The Participant-Facing Messaging Protocol

> Status: **IMPLEMENTED** 2026-08-11 (all four slices). Companion to
> `docs/resident-agents-plan.md` and `docs/residents-in-projects-db-plan.md`;
> changes nothing about how agents wake or speak. Deviations from the plan
> below, decided during implementation:
>
> - **The contract lives in `src/shared/types.ts` (§chat-v1), not a separate
>   `src/shared/chat-v1.ts`** — the method map must compose into
>   `IpcEvents`/`IpcRendererEvents`, and a second shared module importing
>   types back out of `types.ts` would have made a module cycle (dpdm gate).
>   `protocol/chat-v1/openrpc.json` remains the published artifact; the
>   parity test lives in `src/server/chat-ws.test.ts`.
> - **`Message.from` is the grammar STRING plus optional `fromName`, not a
>   `ParticipantRef` object.** The stored row shape already was the right
>   wire shape; `participantKind()` (in `src/lib/resident-agent.ts`)
>   classifies it in one line in any language. This kept the wire, the DB,
>   and the renderer on ONE message type — the ParticipantRef object
>   survives only as `hello.self`. Likewise `replyTo` kept its name (it was
>   always root-normalized); no `rootId` rename.
> - **Internal binding channels are the wire names verbatim**
>   (`chat.list_messages`, not `chat:list-messages`) — parity with the
>   OpenRPC document is then string equality, checked by the test.
> - **Only `chat.message_added` + `chat.channel_changed` ride the internal
>   binding**; presence/attention stay on `resident:status`/`resident:attention`
>   internally (they already existed), roster stays on the store snapshot.
>   The /ws/chat endpoint maps all five from the manager's chat-event stream.
> - **Bridge auth is a raw key** (`OMNI_CHAT_BRIDGE_KEYS`, comma-separated)
>   accepted directly in /ws/chat's `?token=` — no scope claim was added to
>   the ws-token format.
> - **`resident:get-status` survives** beside `chat.get_presence` (the
>   renderer's existing presence path); the six messaging channels
>   (`resident:post`/`create-channel`/`update-channel`/`delete-channel`/
>   `set-channel-members`/`wake`) were deleted as planned.
> - Digest/event dedup in the manager moved from text matching to
>   `messageId` (every message-carrying event now stamps its id — DM events
>   included), which the plan didn't call for but the fromName change made
>   necessary and is strictly more precise.
> - Paging is a new `listResidentMessagesPage` repo method
>   (packages/projects-db: sync SQLite + async wrapper + Pg with RLS).

## Summary

Define a small, versioned, participant-facing protocol — **chat-v1** — for the
resident-agent messaging domain (channels, DMs, threads, roster, presence),
served by the launcher. Today the only way to _be a member of the chat_ is the
launcher's internal typed-ipc surface plus full `store:changed` snapshot
mirroring; any external client (a Flutter app, a Slack/Teams/Discord/WhatsApp
bridge) would have to speak an undocumented envelope, deserialize the entire
internal `StoreData`, and re-derive unread/threading/presence logic. chat-v1
makes "read, post, subscribe, observe presence" an explicit contract with two
bindings: the existing internal transport (the built-in UI migrates onto it)
and a public JSON-RPC WebSocket endpoint (external clients and bridges).

The resident system already has exactly two contracts, and only one is
explicit:

| Contract              | Shape                                                                              | Status                                                  |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Agent ↔ bus**       | wakeup pings in (`enqueue_message`), speech client tools out (`post_channel`/`dm`) | exists, substrate-neutral, **unchanged by this plan**   |
| **Participant ↔ bus** | read / post / subscribe / presence                                                 | internal-only today — **this plan makes it a protocol** |

## Why not gui-v1

The omniagents GUI protocol is deliberately scoped to _one agent host_:
sessions, runs, threads/items, approvals. Channels span agents; all
multi-agent semantics (membership, WAKE_NOW classification, digest cursors,
DM round budgets, thread normalization) live in `ResidentAgentManager`, above
every serve process — the only place that can see the roster. Pushing
channels into gui-v1 would give every serve process bus state and couple the
agent runtime to one chat implementation. gui-v1 keeps its one resident job:
`attach_agent_session` (below) hands a rich client a gui-v1 connection to
watch an agent's live session, exactly as the Session tab does today.

## Non-goals

- **No change to the agent-facing contract.** Pings, speech tools, budgets,
  cursors, park/unpark are untouched. Clients cannot dispatch events or
  classify WAKE_NOW — `post_message` is the only write, and the manager
  decides who wakes. The pacing budgets stay un-gameable from every surface,
  bridges included.
- **No gui-v1 changes**, no new omniagents work.
- **Bridges themselves are not built here.** chat-v1 makes them possible
  (the `as_external` posting path + bridge scope); a Slack bridge is a
  follow-up repo/process that is _just another chat-v1 client_.
- ~~**Per-human DM channels are deferred.**~~ **Shipped as a same-week
  follow-up** (Eric's call: team-visible). Personal human↔agent threads use
  a `~` pair separator when a participant id is namespaced
  (`dm:human:alice~res_1` — legacy `dm:<a>:<b>` ids survive verbatim), are
  TEAM-VISIBLE but single-writer (only the named participant posts; the
  manager enforces it, mirroring the agent↔agent observability rule), and
  coexist with the collective `dm:user:<agent>` thread, which stays every
  human's shared surface. Agents address named people with
  `dm(to: <handle>)` — the directory is the log itself
  (`knownHumansFromLog`: whoever has spoken in the cached tail is
  addressable), the wakeup DM line teaches the exact reply address in
  context, and agent→human sends fire no wakeup (humans get badges).
  Directed-unread is viewer-aware (`isDirectedAtUser(viewerId)`).
- **The channel substrate is not abstracted.** External networks are
  _bridged_ onto the canonical log (the Matrix model), never adopted as the
  substrate — the delivery engine is built over the local log's monotonic ids
  and single ordering, and that stays true.

## Architecture: one contract, two bindings

```
                      ┌────────────────────────────┐
   built-in renderer  │        chat-v1 contract    │   Flutter app
   (Electron ipc /    │  methods + notifications   │   Slack bridge
    server ws) ──────▶│   over ChatService facade  │◀── Teams bridge
                      │  in ResidentAgentManager   │   (JSON-RPC /ws/chat)
                      └────────────────────────────┘
```

1. **`ChatService` facade** (`src/main/chat-service.ts`): a thin, typed
   read/write surface over `ResidentAgentManager` — the single place both
   bindings call. No new state; it delegates to the manager's cache, repo,
   and `post()`/`getStatus()`/channel CRUD. Presence/attention/message events
   fan out through it.
2. **Internal binding**: the contract's methods registered as `chat:*`
   channels through the existing `IIpcListener` path (both entry points),
   exactly like `resident:*` today. The renderer's Residents feature migrates
   onto these + the new notifications, and chat data stops riding
   `store:changed` (slice 3).
3. **Public binding**: a JSON-RPC 2.0 WebSocket endpoint **`/ws/chat`** on
   the Fastify server (server mode), same framing family as gui-v1 so client
   authors reuse patterns. Method names/params/results are identical to the
   internal binding — the endpoint is a dumb adapter: parse frame → call
   facade → serialize result; subscribe connection → forward notifications.

## Participant model (the one internal change)

The current model hard-codes a single human: `USER_PARTICIPANT = 'user'`, and
`post()` durably stores `fromName: 'You'`. That is wrong on any wire another
client reads. chat-v1 generalizes identity **without a DB migration** —
`resident_messages.from_id` is already a free string.

**`from_id` grammar** (parse rule, backwards compatible with every existing
row):

| Form                  | Kind     | Notes                                                              |
| --------------------- | -------- | ------------------------------------------------------------------ |
| `system`              | system   | unchanged                                                          |
| `user`                | human    | the local/collective human — unchanged                             |
| `human:<principalId>` | human    | cloud team members; stamped from the authenticated principal       |
| `ext:<network>:<id>`  | external | bridged users (`ext:slack:U123…`); only writable with bridge scope |
| anything else         | agent    | bare roster id (`res_…`), unchanged — existing rows all parse      |

**Wire type** — participants are never raw strings on the chat-v1 wire:

```ts
type ParticipantRef = {
  kind: 'human' | 'agent' | 'system' | 'external';
  id: string; // the from_id string above
  displayName: string; // resolved at read time for agents; stored for humans/external
};
```

**Edits:**

- `src/lib/resident-agent.ts`: add `parseParticipant(fromId)` and
  `isHumanParticipant(fromId)` (true for `user` and `human:*`). Every check
  that compares against `USER_PARTICIPANT` for "a human did this"
  (`isDirectedAtUser`, `post()` routing, `channelAudienceIds`) generalizes to
  `isHumanParticipant`. `USER_PARTICIPANT` itself survives as the collective
  human id used in DM channel ids.
- `post()` stops storing `'You'`: locally it stamps `from: 'user'`,
  `fromName: null`; in cloud team mode it stamps `human:<principalId>` + the
  principal's display name (the ws `HandlerContext` already carries
  `principalId`). Renderers show "You" by comparing `from` to _their own_
  participant id — display becomes viewer-relative, as it must be with >1
  human. Existing `'You'` rows render fine (name is display-only).
- `channel_user` event semantics unchanged: any human post is "the user
  spoke" from the agents' perspective. Ping lines render the human's display
  name when present so agents can tell teammates apart.

## Wire contract

### Objects

```ts
type Channel = {
  id: string; // 'team' | slug | 'dm:<a>:<b>' | 'system'
  kind: 'team' | 'named' | 'dm' | 'system';
  description?: string;
  members?: string[]; // roster ids; absent = open (named only)
  dmParticipants?: [ParticipantRef, ParticipantRef]; // dm only
};

type Message = {
  id: number; // monotonic, log-global (the replay cursor)
  channel: string;
  from: ParticipantRef;
  text: string;
  at: number; // epoch ms
  rootId?: number; // thread root (pre-normalized on write)
};

type RosterAgent = {
  id: string; // opaque res_* id
  handle: string; // @address, derived from current name
  name: string;
  role: string;
  enabled: boolean;
  superuser?: boolean;
};

type Presence = {
  agentId: string;
  state: 'parked' | 'starting' | 'idle' | 'thinking' | 'reflecting';
  lastWakeupAt: number | null;
  lastReason: string | null;
  seenMessageId: number; // read-receipt watermark (digest cursor)
  queuedMessageIds: number[]; // routed but not yet delivered
};
```

### Methods (client → server)

| Method                      | Params                                                                                           | Result                                                                  | Notes                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `chat.hello`                | `{}`                                                                                             | `{ protocol: 'chat-v1', self: ParticipantRef, capabilities: string[] }` | handshake; `self` is the caller's stamped identity                                                                 |
| `chat.list_channels`        | `{}`                                                                                             | `{ channels: Channel[] }`                                               | includes the caller-visible DM channels + `system`                                                                 |
| `chat.list_messages`        | `{ channel?: string, after?: number, before?: number, limit?: number }`                          | `{ messages: Message[], hasMore: boolean }`                             | keyset pagination on `id`; omitted `channel` = all visible; repo already has `listResidentMessagesAfter`           |
| `chat.post_message`         | `{ channel: string, text: string, replyTo?: number, asExternal?: { network, id, displayName } }` | `{ message: Message }`                                                  | delegates to `post()`; `asExternal` requires `bridge` scope; identity otherwise comes from auth, never the payload |
| `chat.create_channel`       | `{ name: string, description?: string }`                                                         | `{ channel: Channel }`                                                  |                                                                                                                    |
| `chat.update_channel`       | `{ channelId: string, description?: string }`                                                    | `{ channel: Channel }`                                                  |                                                                                                                    |
| `chat.delete_channel`       | `{ channelId: string }`                                                                          | `{}`                                                                    |                                                                                                                    |
| `chat.set_channel_members`  | `{ channelId: string, members: string[] \| null }`                                               | `{ channel: Channel }`                                                  | `null` restores open membership                                                                                    |
| `chat.list_roster`          | `{}`                                                                                             | `{ agents: RosterAgent[] }`                                             | read-only; roster CRUD stays on `resident:*` (admin surface, not chat)                                             |
| `chat.get_presence`         | `{}`                                                                                             | `{ presence: Presence[] }`                                              | snapshot; then rely on pushes                                                                                      |
| `chat.wake_agent`           | `{ agentId: string }`                                                                            | `{}`                                                                    | the roster-panel wake                                                                                              |
| `chat.attach_agent_session` | `{ agentId: string }`                                                                            | `{ sessionId: string, connection: { baseUrl, authToken? } }`            | `ensureSession()` passthrough — returns a **gui-v1** connection for the live session view                          |

### Notifications (server → client)

| Notification            | Payload                                            | Source                                                  |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `chat.message_added`    | `{ message: Message }`                             | every `appendMessage` (user, agent speech, system rows) |
| `chat.channel_changed`  | `{ channel?: Channel, deletedId?: string }`        | channel CRUD / membership                               |
| `chat.presence_changed` | `{ presence: Presence[] }`                         | the current `resident:status` broadcast, re-shaped      |
| `chat.roster_changed`   | `{ agents: RosterAgent[] }`                        | create/update/delete                                    |
| `chat.attention`        | `{ agentId: string, message: string, at: number }` | the current `resident:attention`                        |

### Reconnect / replay

No replay buffer and no server-side subscription state: **the durable log is
the replay substrate.** Message ids are monotonic and log-global, so a client
resumes with `chat.list_messages({ after: lastSeenId })`, then applies live
`message_added` events (dedupe by id). Presence and roster are
snapshot-on-connect (`get_presence`, `list_roster`) + push. This is
deliberately simpler than gui-v1's sequenced replay envelope — chat has one
totally-ordered durable stream, so the cursor is free.

### Visibility & authorization

- Callers see: `team`, all named channels, `system`, and DM channels whose
  participants include a human (all humans share the collective view in v1,
  matching today's Activity feed). Agent↔agent DMs are visible read-only —
  the log is the observability surface by design.
- Humans may post to any named channel and any `dm:user:*` channel. Posts to
  `system` are rejected (server-authored only). `asExternal` without bridge
  scope → error.
- Tenancy: every method resolves against the caller's tenant exactly like
  `resident:*` does today (per-tenant manager in server mode).

### Errors

JSON-RPC error objects with `data.kind`: `unknown_channel`,
`unknown_recipient`, `reply_not_in_channel`, `reserved_channel`,
`forbidden` (scope/authz), `invalid_params`. Internal-binding callers get the
same kinds via thrown `Error`s carrying the kind, as `resident:*` throws
today.

## Auth (public binding)

Reuse the existing server flow wholesale: `GET /api/ws-token` (loopback /
trusted-CIDR / EasyAuth-derived identity) mints the signed token; `/ws/chat`
accepts `?token=` exactly as `/ws` does and resolves the same
tenant/principal. One addition: tokens carry an optional `scope: 'bridge'`
claim, mintable only via a new server config allowlist
(`OMNI_CHAT_BRIDGE_KEYS` — static bearer keys exchanged at `/api/ws-token`),
gating `asExternal`. Mobile clients target the deployed server (EasyAuth in
front), which already yields a real principal.

## Contract artifact & governance

- **Source of truth**: TypeScript types + method map in
  `src/shared/chat-v1.ts` (the internal binding is typed against it).
- **Published artifact**: hand-authored OpenRPC document
  `protocol/chat-v1/openrpc.json` in this repo — Dart/Kotlin/Python clients
  generate from it. A unit test asserts parity between the OpenRPC method
  names and the registered handler names so the document can't drift.
- **Rules**: borrow gui-v1's governance (additive-only after first release;
  new methods/optional fields OK; no narrowing, renaming, or semantic
  changes; unknown-enum tolerance required of clients). chat-v1 ships as
  experimental until the Flutter client and one bridge have run against it.

## Slices

**Slice 1 — participant model (lib + manager).**
`parseParticipant`/`isHumanParticipant` in `src/lib/resident-agent.ts`;
generalize the human checks; stop storing `'You'` (stamp principal identity
in cloud post path); viewer-relative "You" in the renderer's message views.
Pure-lib changes are unit-tested; no wire or DB changes.

**Slice 2 — ChatService facade + internal binding.**
`src/main/chat-service.ts` over `ResidentAgentManager` (message→`Message`
mapping incl. `ParticipantRef` resolution, channel→`Channel` with `kind`,
presence shaping); `chat.*` handlers registered from both entry points
alongside `resident:*`; `message_added`/`channel_changed`/`presence_changed`/
`roster_changed`/`attention` notifications emitted from the facade.
`resident:*` stays untouched (no compat shims needed — nothing moves yet).

**Slice 3 — renderer migration.**
Residents feature consumes `chat.*` + notifications instead of
`residentChannels`/`residentChannelDefs` from `store:changed`; those two keys
leave `getDurableSnapshot()` and the store snapshot in the same change (both
sides in lockstep, no legacy aliases). Roster/memories/alarms stay on the
snapshot (settings surfaces, not chat). `resident:post`,
`resident:create-channel`, `resident:update-channel`,
`resident:delete-channel`, `resident:set-channel-members`, `resident:wake`
are deleted in favor of their `chat.*` equivalents — same release, both
bindings, no aliasing.

**Slice 4 — public endpoint.**
`/ws/chat` JSON-RPC adapter in `src/server/` (dial auth identical to `/ws`;
per-connection tenant resolution; notification fan-out via the facade's
subscription registry); `protocol/chat-v1/openrpc.json` + parity test;
`bridge` scope claim + `asExternal` gate. Electron-hosted endpoint (phone →
desktop) is explicitly deferred — managers are shell-agnostic, so it's an
additive later step.

## Test plan

- **Lib (vitest, pure)**: participant grammar (every legacy `from_id` parses
  to the right kind; `human:*`/`ext:*` round-trip), `isHumanParticipant`
  substitution keeps `isDirectedAtUser`/audience semantics for `user` rows.
- **Facade (vitest, electron-shim)**: `list_messages` keyset pagination
  against a seeded repo (after/before/limit, `hasMore`); `post_message` wakes
  members exactly as `post()` does today (assert via `dispatchEvent` spies);
  `asExternal` rejected without scope, stamped `ext:*` with it; `system`
  post rejected; DM visibility set correct per caller.
- **Endpoint (vitest, ws — the `ws-handler.test.ts` idiom)**: dial with
  minted token, `chat.hello` returns the principal-derived `self`;
  notifications reach only the right tenant; resume-by-cursor after a
  dropped socket yields no gaps/dupes against a concurrent poster.
- **Parity test**: OpenRPC document methods ≡ registered `chat.*` handlers.
- **Acceptance**: built-in Residents tab runs entirely on chat-v1 (slice 3)
  with `residentChannels`/`residentChannelDefs` gone from the snapshot; a
  scripted external client (test-only Node WS client) posts to #team, an
  agent wakes, replies via `post_channel`, and the client observes the
  agent's `message_added` + `presence_changed` without touching `store:*`.

## Decisions & assumptions

- **Launcher-owned contract, not omniagents.** The bus lives here; gui-v1
  stays an agent-host protocol. OpenRPC document is hand-authored in this
  repo (the omniagents Python generator generates from its own catalog and
  doesn't fit a TS-owned domain).
- **Contract-with-two-bindings** rather than WS-only, because the Electron
  renderer has no WebSocket to the main process; the existing transport
  abstraction is the internal binding for free.
- **Durable log as replay** (cursor = message id) instead of gui-v1-style
  replay envelopes — chat has one ordered durable stream; don't rebuild what
  the DB already guarantees.
- **Roster CRUD and memory/handbook editing stay on `resident:*`** — they're
  admin/settings surfaces, not messaging; chat-v1 stays small.
- **Collective + personal DMs.** Originally scoped collective-only; personal
  threads shipped as the immediate follow-up (see Non-goals for the full
  semantics). Display names for cloud principals ride the WS session from
  connect time (`HandlerContext.displayName` ← EasyAuth claims).
- **Bridges are clients** (Matrix model): canonical log + one delivery
  engine; adapters translate, never route.
- **Flutter talks to server mode / cloud** in v1; Electron-hosted `/ws/chat`
  deferred.
- **`seenMessageId` read receipts** ride the in-flight uncommitted work on
  `ResidentAgentRuntime` — this plan assumes it lands first.
