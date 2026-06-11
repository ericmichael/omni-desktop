# Codex (ChatGPT) OAuth + Responses API

Lets a ChatGPT Plus/Pro/Team subscriber drive the agent through their
subscription instead of a metered OpenAI API key, by authenticating with
ChatGPT OAuth and talking the **Responses API** to the Codex backend
(`chatgpt.com/backend-api/codex`).

This spans three repos. The contract between them is one file on disk:
**`<omni-config-dir>/codex.json`** — `{ refresh, access, expires (ms), account_id? }`.

```
launcher (Electron)            omni-code (runtime)              omniagents (framework)
─────────────────────          ─────────────────────            ─────────────────────
browser PKCE flow  ──writes──▶ codex.json ──read+refresh──▶     (unchanged — uses the
:1455 loopback                 build_codex_openai_client()       default OpenAI client /
shell.openExternal             set_default_openai_client()       OpenAIProvider it's given)
```

## Why it's mostly free

omniagents runs on the OpenAI **Agents SDK**, which defaults to the Responses
API and POSTs to `{base_url}/responses`. Setting `base_url` to the Codex root
lands exactly on `.../codex/responses` — no URL rewrite needed. (opencode's JS
plugin rewrites the path only because the AI-SDK hard-codes it.) The Agents SDK
also accepts a custom `AsyncOpenAI` client, so Codex is just "a client with the
right auth + base_url," mirroring the existing Azure dummy-key pattern.

## launcher — interactive OAuth only

- `src/main/codex-auth.ts` — PKCE S256 browser flow against `auth.openai.com`,
  loopback callback on `:1455`, writes `codex.json` (0600) into the omni config
  dir. Never refreshes — that's the runtime's job (it can outlive the launcher).
- IPC `codex:login` / `codex:logout` / `codex:status` (Electron-only handlers in
  `src/main/index.ts`; `CodexIpcEvents` in `src/shared/types.ts`).
- `ProviderEntry.type` gains `'openai-oauth'` (`src/shared/types.ts`).
- Settings → Models: a "Sign in with ChatGPT" card. **Signing in is all the user
  does** — on success (`applyCodexSignIn`) the launcher auto-registers the
  built-in `codex` provider in the store (empty models — the runtime discovers
  them) and, *only when no other provider is configured*, sets a discovered
  Codex model (preferring `gpt-5.5`) as the default. With other providers
  present it leaves the default alone; Codex is still selectable via the picker
  or `/model`. No manual provider/model setup is ever required.

## omniagents — owns the Codex provider

The Codex provider lives in **`omniagents/core/providers/codex.py`** so any
OmniAgents agent can use it: the token store (`codex.json`), OAuth refresh +
device-code login, `build_codex_openai_client()` (refreshing `AsyncOpenAI` with
an httpx request hook that injects/refreshes the bearer + `ChatGPT-Account-Id`),
live discovery (`list_codex_models()`), and `register_codex_provider()`.

- **Auto-registered** on `import omniagents` (`__init__.py`) — `openai-oauth`
  works out of the box; the builder returns `None` until signed in.
- **Login CLI**: `omniagents auth codex {login,logout,status}` (device flow).
- **Token store dir** is overridable (`set_token_store_dir` / `$OMNIAGENTS_CODEX_HOME`),
  default `~/.config/omniagents/codex.json`.
- A plain omniagents user: `omniagents auth codex login`, then
  `model_provider: { type: openai-oauth }` + a model slug in agent YAML.

## omni-code — binds the shared provider

- `omni_code/codex_auth.py` is now a thin binding: `set_token_store_dir(get_config_dir())`
  so tokens resolve at `~/.config/omni_code/codex.json` (where the launcher
  writes them), then re-exports the provider API for omni-code's call sites.
- Provider type `openai-oauth` ships as the default `codex` provider in
  `default_models.py`; `resolve_model_for_runtime` surfaces it; discovery in
  `models._apply_oauth_discovery` fills the live model list.
- Main agent uses the registry (above). Aux agents (`compact`, `recap`,
  `session_summarizer`) run via `Runner.run_streamed`. `serve_cli` calls
  `register_codex_provider()` at startup (redundant with the auto-register, but
  harmless and explicit).
- CLI: `omni auth codex {login,logout,status}` still works (delegates to the
  shared provider, writes to the omni-code config dir).

## omniagents — framework hooks behind the provider

The main agent's per-run model provider is built by
`run_options.build_model_provider()`, and the Codex backend has two hard
requirements that the provider relies on:

1. **Provider-builder registry** (`run_options.py`): `build_model_provider`
   didn't know `openai-oauth` and fell back to a keyless `MultiProvider`
   (→ "Missing credentials" crash). Added `register_model_provider_builder(type,
   builder)`; `codex.register_codex_provider()` injects a builder that returns
   `OpenAIProvider(openai_client=build_codex_openai_client())`.
2. **Streaming requirement** (`patches/disable_token_streaming.py`): the Codex
   backend rejects `stream=false` ("Stream must be set to true"). That patch
   forces every per-turn call non-streaming for resilience; now it detects the
   Codex base URL and delegates to the SDK's real `stream_response` there.
   The aux agents (compact, recap, summarizer) were switched from `Runner.run`
   to `Runner.run_streamed` (drain events → `final_output_as`) so they go
   through that streaming path too — the SDK's run loop does the stream→result
   assembly, so we don't reimplement it. The main agent already used
   `run_streamed` (`bridge.py`). No other code calls the model's non-streaming
   `get_response`.

Codex's `/responses` also mandates `store=false`, `instructions`, and a list
`input` — all already satisfied by the agent runtime and the discovered models'
`model_settings` (`store:false` + encrypted reasoning).

## Token-refresh placement

Refresh lives in the **runtime** (omni-code), not the launcher: a serve process
can outlive a token's ~1h lifetime, and runtime refresh works for both desktop
and the server/cloud path. The launcher only performs the interactive login.

## Dynamic model discovery

The model list everywhere derives from **one** source: omni-code's
`get_merged_providers()` → `list_models()` → the `/models` & `/model` RPC server
functions (`server_functions/model.py`). The launcher switches models via
`/model <name>` slash commands (which set `session.active_model` /
`session.model_config`, read back by the omniagents builder). So discovery has a
single chokepoint:

- `models._apply_oauth_discovery()` (wrapping `get_merged_providers`) replaces a
  signed-in `openai-oauth` provider's models with a **live fetch** from the
  Codex backend (`codex_auth.list_codex_models()` → `GET /codex/models`,
  `visibility == "list"` only, 5-min process cache keyed by account). The static
  seed in `default_models.py` is the offline fallback; user overrides in
  `models.json` merge over discovered entries.

This makes `/models`, the in-chat `/model` picker, and `resolve_model_for_runtime`
all dynamic at once — no omniagents changes.

The launcher **Settings → Models** default/voice pickers also show the live set:
`model list --json` (new flag on `model_cli.cmd_list`) → `util:list-models` IPC
(`listRuntimeModels` in `util.ts`) → merged with the store keys in
`SettingsModalModelsTab`. So a discovered Codex model is selectable as the
default without hand-editing `models.json`.

**Reasoning tiers:** the Codex backend exposes an `xhigh` effort above `high`.
Modeled end-to-end: `ReasoningEffort` type (launcher), `REASONING_OPTIONS` (UI),
`set_reasoning` valid levels + `_model_entry` carry-through (omni-code). The
OpenAI Agents SDK `Reasoning(effort=...)` accepts `xhigh`.

## Known gaps / follow-ups

- **Sandbox persistence**: on refresh, omni-code rewrites `codex.json` in the
  config dir. If that dir is ephemeral in the sandbox (copy, not bind-mount),
  the refreshed token won't persist across restarts — it just refreshes again
  next boot. Verify the launcher mounts the config dir read-write for desktop.
- **Server mode**: the browser/loopback flow is Electron-only; the device flow
  (`omni auth codex login`) covers headless. No web UI for sign-in yet.
- **model_settings**: Codex models inherit `store:false` + encrypted reasoning
  like the API gpt-5.x models; confirm the Codex backend honors these.
