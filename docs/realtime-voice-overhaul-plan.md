# Realtime Voice Overhaul — Plan

## Summary

Replace the full-screen VoiceModal with an inline voice dock in the chat UI, fix the transcript-fragmentation and history-loss defects at their source in omniagents, and gate voice-mode tools through the existing text-path approval flow. Two repos change in lockstep (omniagents server first, launcher client second); the pipeline backend and the local-voice (Option A) path are untouched.

Confirmed defects this plan fixes:

- Assistant transcripts arrive as per-delta events with no `item_id` (`realtime_events.py:470`), so the client renders each fragment as its own message.
- Voice conversations are never persisted (`RealtimeSession` writes only audio chunks), and the realtime agent starts with zero prior conversation — history transfers in neither direction.
- Voice tools run ungated server-side despite `skip_approvals: false`; the modal's approval cards call RPCs that don't exist on the realtime channel.
- Orb bugs: WebGL context recreated on every state transition (`Orb.tsx:333` effect deps), 60 fps `forceUpdate` loop fighting a 300 ms CSS transition, stale-closure audio meter re-rendering every frame, THINKING state sticks when a response produces no audio.
- Stream-pump errors are sent on an unhandled `realtime_error` method; the UI shows "Live" regardless.
- `ResidentHostedVoice` starts voice with no session id — no tool bridging, no environment lease, no pairing.
- No barge-in: mic is disabled during playback and nothing calls the implemented `interrupt` RPC.

---

## Phase A — omniagents (server)

### A1. Transcript protocol: deltas with identity, finals per item

`omniagents/rpc/realtime_events.py`:

- `RealtimeTranscriptEvent` gains a required `item_id: str` field.
- Stop synthesizing a `RealtimeTranscriptEvent` per assistant `transcript_delta`. Instead map raw `transcript_delta` → the existing (currently unused) `RealtimeTranscriptDeltaEvent` with `item_id` from the SDK event (`RealtimeModelTranscriptDeltaEvent.item_id`), `content_index=0`, `delta`. Assistant-only by contract.
- `input_audio_transcription_completed` → `RealtimeTranscriptEvent(role="user", item_id, transcript)` (full utterance, as today, now with item_id).
- Map raw `turn_started` / `turn_ended` model events → the existing `RealtimeTurnStartedEvent` / `RealtimeTurnEndedEvent` (defined, never produced today).

`RealtimeSession.stream_events()` accumulates assistant deltas per `item_id`; on `turn_ended` (and on `stop()` for a mid-turn teardown) it flushes each accumulated item as a final `RealtimeTranscriptEvent(role="assistant", item_id, transcript=<full text>)` yielded to the client _and_ persists it (A2). The delta accumulator is cleared per flush.

Wire contract after this change (client keys bubbles by `item_id`):

```
realtime_transcript_delta  {run_id, item_id, content_index, delta}          # assistant streaming
realtime_transcript        {run_id, item_id, role, transcript}              # final, both roles
realtime_turn_started      {run_id}
realtime_turn_ended        {run_id}
```

Update `realtime_protocol.md` accordingly. No back-compat aliases.

### A2. Persist voice turns into the session thread

New module-level helper in `realtime_session.py` (used by `RealtimeSession`, which gains an optional `agent_service` reference passed by `RealtimeService`):

- **User turn**: on `input_audio_transcription_completed`, append `{"role": "user", "content": <transcript>}`.
- **Assistant turn**: on flush (A1), append `{"role": "assistant", "content": [{"type": "output_text", "text": <transcript>, "annotations": []}], "type": "message"}` — the explicit output-parts form (`service.py:3609` pattern; bare strings get coerced to `input_text` and break `responses.compact`).
- Write path: `agent_service._session_manager.get_or_create(session_id, user_id=owner)` → `ensure_conversation_thread(sess)` best-effort → `sess.append_message(msg)` → explicit recorder item, mirroring `send_user_message` (`service.py:3595-3620` region). Fallback when `agent_service` is None (embedded use): `history_db.append_message(session_id, msg, project_slug=..., agent_slug=...)`.
- Empty/whitespace transcripts are skipped. Tool calls are _not_ persisted (assumption below).

Consequence: `get_session_history` returns voice turns after the dock closes, and the next _text_ run sees the voice conversation in `sess.history` — voice→text continuity comes free.

### A3. Text→voice context injection

In `RealtimeSession.start()`, before building instructions: load the paired session's history (same `get_or_create` session when `agent_service` is present, else `history_db.load_history`), render a plain-text tail — last 30 message items, hard-capped at 8,000 chars (truncate oldest first), formatted `User: …` / `Assistant: …`, output-parts flattened to their `text` — and append it to the rendered instructions under a `# Conversation so far` heading, with one sentence telling the agent this is the ongoing conversation it is joining. Skip the block entirely when the tail is empty.

### A4. Tool approvals — reuse the text-path flow over /ws

No approval RPCs are added to the realtime channel. The inline dock keeps the chat UI visible, so approvals render as the **existing** approval cards in MessageList and resolve through the **existing** `tool_approval_response` on `/ws` (`service.py:2250`), whose handler already broadcasts cross-channel dismissal ("multi-tab / voice + chat").

Implementation:

- `RealtimeService.start_session` builds an approval gate when `agent_service` is present and the spec configures approvals (`use_safe_agent` with `skip_approvals: false`): resolve the paired `Session` via `get_or_create` and wrap each non-safe tool before handing tools to `RealtimeSession`.
- The wrapper: for every `FunctionTool` whose name is not in `safe_agent_options.safe_tool_names` and not in the session's `always_allow_tools`, replace `on_invoke_tool` with a gate that mints a `call_id` (the SDK tool context's call_id when available, else `uuid4`), awaits `agent_service._request_tool_approval(session, call_id, tool_name, arguments, run_id=<realtime run_id>)`, then either invokes the original tool (approve; honoring `always_approve` — the shared handler already updates the session allow-list) or returns the rejection message as the tool output (`halt_on_rejection: true` semantics = the model receives the rejection text; the session is not torn down).
- Remove the "no approval predicates — tools run ungated" build in `RealtimeSession.start()` in favor of receiving pre-gated tools. Bridged client tools are already safe-only and stay ungated. MCP tools connected by the realtime session are out of scope for gating in this pass (assumption below).

### A5. Error routing + misc

- `RealtimeService._stream_session_events` exception path notifies via `realtime_event` with `{"type": "realtime_error", "session_id", "error_message"}` — deleting the unhandled `realtime_error` method call. Also emit the same event before cleanup if the pump ends because the model socket closed unexpectedly.
- `history_updated` mapping is left as-is (unused by the new client).

### A6. omniagents tests

- `test_realtime_events.py`: `transcript_delta` maps to `RealtimeTranscriptDeltaEvent` with the SDK item_id; `input_audio_transcription_completed` carries item_id; `turn_started`/`turn_ended` map; assistant per-delta `RealtimeTranscriptEvent` no longer produced.
- New `test_realtime_persistence.py`: fake SDK session yielding deltas + turn_ended → exactly one assistant `realtime_transcript` final with concatenated text, one `append_message` in output-parts form; user transcript persists as string content; empty transcript skipped; mid-turn `stop()` flushes.
- New approval-gate tests: safe tool bypasses; unsafe tool awaits `_request_tool_approval`; reject returns rejection message as output; always_approve short-circuits the next call.
- Context-tail test: tail rendered, capped, absent when history empty.

---

## Phase B — launcher (client)

### B1. `voice-session.machine.ts` (`src/shared/machines/`, pure XState v5 + colocated test)

States: `closed` → `connecting` → `starting` → `live` (substates `attending` | `responding` | `speaking`) | `stopping` → `closed`; `error` (from any active state; `CLOSE` returns to `closed`).

Context: `sessionId`, `runId`, `muted: boolean` (initial true), `startedAt: number | undefined` (set from a `SESSION_STARTED` event payload stamped by the adapter — machine never calls `Date.now()`), `items: VoiceItem[]`, `activeTool: string | undefined`, `error: string | undefined`.

`VoiceItem` is `MessageItem`-compatible (`@/shared/chat-types`): user/assistant `ChatMessage`s keyed by `item_id`, plus `ToolItem`s keyed by `tool_call_id`. Reducer rules: `TRANSCRIPT_DELTA {item_id, delta}` appends to (or creates) the assistant item for `item_id`; `TRANSCRIPT_FINAL {item_id, role, text}` replaces that item's text (creates user items); `TOOL_START {tool_call_id, name, args}` adds a running ToolItem and sets `activeTool`; `TOOL_END {tool_call_id, output}` completes it and clears `activeTool`.

Events (from UI): `OPEN {sessionId?}`, `CLOSE`, `TOGGLE_MUTE`, `INTERRUPT`, `SEND_TEXT {text}` (adds a user item immediately). From adapter: `CONNECTED`, `CONNECT_ERROR {message}`, `SESSION_STARTED {sessionId, runId, at}`, `TURN_STARTED`, `RESPONSE_START`, `TURN_ENDED`, `PLAYBACK_ACTIVE`, `PLAYBACK_IDLE`, `AUDIO_INTERRUPTED`, `TRANSCRIPT_*`, `TOOL_*`, `SERVER_ERROR {message}`, `DISCONNECTED {message?}`.

Substate rules: `RESPONSE_START`/`TURN_STARTED` → `responding`; `PLAYBACK_ACTIVE` → `speaking`; `PLAYBACK_IDLE` or `TURN_ENDED` (whichever lands last — `speaking` exits on `PLAYBACK_IDLE`, `responding` exits on `TURN_ENDED`) → `attending`. This kills the stuck-THINKING bug: a no-audio turn exits on `TURN_ENDED`. `INTERRUPT` and `AUDIO_INTERRUPTED` → `attending`. `SERVER_ERROR` records the message but stays live (server errors can be per-turn); `DISCONNECTED`/`CONNECT_ERROR` → `error`.

Orb visual state is a derived selector (`idle` when muted+attending, `listening`, `thinking` = responding, `speaking`), plus `activeTool` for the overlay — no separate state storage.

### B2. Renderer adapter (`src/renderer/services/realtime-voice.ts`)

Owns one `RealtimeRPCClient` (reused as-is minus deleted methods, B6), the mic pipeline, and playback; translates between them and the machine. All extracted from VoiceModal, behavior-preserving except where noted:

- **Capture**: `getUserMedia` with persisted `audioSettings`, inline-blob AudioWorklet (ScriptProcessor fallback), linear resample to 24 kHz, 2400-sample chunking, PCM16LE→base64 → `send_audio` notifications. Gated by machine snapshot (`muted`, half-duplex hold during `speaking`).
- **Playback**: base64 PCM16 24 kHz chunks → scheduled `AudioBufferSource`s through `MediaStreamAudioDestinationNode` → hidden `<audio>` with `setSinkId`. Emits `PLAYBACK_ACTIVE` on first schedule of a response and `PLAYBACK_IDLE` when the active-source set drains **and** `ctx.currentTime` passes the scheduled end — tracked via per-source `onended` plus one short timeout armed at the scheduled end; the 50 ms polling interval is deleted.
- **Level meter**: AnalyserNode with the existing voice-frequency weighting writes to a mutable holder (`export const realtimeVoiceLevel = { current: 0 }`, same pattern as `voice-recording.ts`'s `voiceLevel`). Never touches React state.
- **Half-duplex + barge-in**: tracks disabled on `RESPONSE_START`/first audio, re-enabled 150 ms after playback idle (respecting user mute). `INTERRUPT` → stop all sources immediately, clear the schedule, call the `interrupt` RPC.
- **Lifecycle**: `OPEN` → `connect()` → `start_session(sessionId)` → `SESSION_STARTED`; `CLOSE` → await `stop_session` then `disconnect` (keeping the current in-flight-stop fix). Server notifications on `realtime_event` map 1:1 to machine events; unknown types ignored.

### B3. `VoiceDock.tsx` (omniagents-ui/components)

Compact dock rendered between `PillStrip` and `Input` in `App.tsx` when the machine is not `closed`: Orb at ~120 px, mute toggle, elapsed timer (from `startedAt`, 1 s interval in the component), end button, one status line (connecting… / active tool name / error text — replaces the unconditional "Live" dot). Tapping the orb while `speaking` sends `INTERRUPT`. The dock renders in-flow (no portal, no overlay); the composer stays usable — typed messages route to `SEND_TEXT` while voice is live.

The mic button in `Input.tsx` (`hostedVoiceSupported` branch) dispatches `OPEN {sessionId}` instead of opening the modal; while live it becomes a no-op (the dock owns controls).

### B4. MessageList integration + session continuity

- App renders `[...chatItems, ...voiceItems]` while the machine is active (voice items after live chat items; both are `MessageItem`s so MessageList needs no changes). Approval cards arrive through the normal `/ws` → chat-session-machine path (A4) and render/resolve exactly as in text runs.
- On `SESSION_STARTED` with a server-minted id (voice-first), App adopts it via the existing `setSessionId` path. On voice end, keep the existing `onVoiceClose` behavior — re-select session + `refreshSessions()` — which now returns the persisted voice turns (A2); the machine clears `items` on `closed`, so canonical history replaces the live transcript with no duplication window (clear happens after the reload is triggered).
- `use-chat-boot`'s capabilities probe is unchanged.

### B5. Orb fixes (`Orb.tsx`)

- Renderer effect runs once (`[]` deps); `rotateOnHover`/`forceHoverState` move into the existing refs so state flips never recreate the WebGL context.
- New props: `state: 'idle' | 'listening' | 'thinking' | 'speaking'`, `toolActive: boolean`, `levelSource?: { current: number }`. The per-state parameter tables and pulse/tool-overlay math (breathing sine, thinking pulse, rainbow hue cycle, turbulence) move from VoiceModal's render body into Orb's existing RAF, computed from `t` and written straight to uniforms. Scale becomes a uniform-driven draw parameter (drop the wrapper `transform` + `transition-transform` entirely).
- React re-render cost of a state change: one prop write into refs. The 60 fps `forceUpdate` loop, the stale-closure meter, and the render-phase `setOrbState` all die with VoiceModal.

### B6. Deletions and fixes (lockstep, no compat)

- Delete `VoiceModal.tsx`, `VoiceNotificationCenter.tsx`, and Input.tsx's modal wiring.
- `RealtimeRPCClient`: delete `toolApprovalResponse`, `mcpApprovalResponse`, `clientResponse` (all target nonexistent realtime-channel methods); keep the rest untouched.
- `ResidentHostedVoice` (`ResidentsTab.tsx`) renders `VoiceDock` + a minimal transcript list inside its `UiConfigProvider`, and the dock's session id defaults to `useUiConfig().session` (the resident serve's handoff URL carries it) — fixing the unpaired-session bug so client tools, the environment lease, approvals, and persistence all pair with the DM session.
- Debug-panel buttons from the modal are not carried over.

### B7. Launcher tests

- `voice-session.machine.test.ts`: full lifecycle; delta accumulation by item_id → final replacement; no-audio turn exits `responding` on `TURN_ENDED`; interrupt from `speaking`; mute toggling; error paths; `SEND_TEXT` item; items cleared on close.
- Adapter: pure helpers (`resampleTo24k`, chunker, float→PCM16) extracted and unit-tested.
- Existing `realtime.test.ts` updated for removed methods. Targeted runs only; rely on lint/tsc for the UI wiring.

---

## Sequencing

1. **A1–A6** land in omniagents (protocol, persistence, context tail, approvals, errors) — the old client keeps "working" no worse than today during the window, but the repos ship together per no-compat policy.
2. **B1–B7** land in the launcher, deleting the modal in the same change that mounts the dock.
3. Validate: voice turn → close dock → transcript visible in chat; follow-up text run references the voice conversation; unsafe tool in voice raises an approval card in chat and resolves; barge-in interrupts audio; no-audio turn returns the orb to attending.

## Assumptions

- Tool calls made during voice are shown live but **not persisted** to the thread (transcripts only); canonical tool records stay a text-run feature for now.
- MCP tool gating inside realtime sessions is deferred; function tools (spec + capability packs + agent-tools) are gated.
- Hosted-MCP approval events over the realtime channel are dropped with the modal (they were pipeline-only and the response RPC never existed).
- Context tail: 30 items / 8,000 chars, plain text, no summarization.
- Rejection returns text to the model rather than ending the turn (`halt_on_rejection` interpreted as "don't execute", matching the shared handler's contract).
- `VoicePipelineService`, the local-voice path, `VoiceHotkeys`, and the deck-column glow are untouched.
- One voice session per `OmniAgentsApp` instance (per column/DM surface), matching today.
