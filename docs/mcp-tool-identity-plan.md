# MCP Tool Identity: (server, tool) as Canonical Identity

## Summary

Make `(server_name, tool_name)` the canonical identity for MCP-derived tools across omniagents and the launcher, with the flat model-facing name existing only as a derived serialization at the model boundary — never parsed for trust decisions. This closes the bare-name collision class (approval grants leaking across servers, ambiguous SDK routing) before third-party connectors ship via the Plugins tab, and it converges local/stdio MCP with the tuple-keyed machinery that already exists for hosted MCP (`always_allow_mcp_tools`, `safe_mcp_tools`).

Lockstep change across omniagents + launcher, no backward-compat aliases. Hosted-MCP approvals are already tuple-keyed and are untouched.

## What the SDK already provides (build on, don't reinvent)

Grounded against the installed `openai-agents` SDK (`agents/mcp/util.py`, `agents/items.py`, `agents/tool.py`):

- **`Agent.mcp_config["include_server_in_tool_names"] = True`** → MCP tools get deterministic public names `mcp_<server>__<tool>` (sanitized to `[A-Za-z0-9_-]`, hyphens preserved, so `mcp_omni-projects__create_ticket`). Cross-server duplicates and >64-char names are resolved by a deterministic seeded hash suffix. Duplicate final names raise `UserError` at build time — loud, not silent.
- **`ToolOrigin`** (`type: "mcp"`, `mcp_server_name`) is stamped on every MCP-derived `FunctionTool` **and** on `ToolCallItem`, `ToolCallOutputItem`, and `ToolApprovalItem` — the bridge can read structured server identity straight off stream/interruption items. Note `ToolOrigin` does **not** carry the original MCP tool name; recovering it is our job (see identity map below).
- Renaming is invocation-safe: the on-invoke closure binds the original MCP tool name; the public name is only the schema/routing key.
- omniagents' `builder.py` already passes `spec.mcp_config` through to `Agent(mcp_config=...)`.

Deliberately **not** used: the Responses API tool-namespace mechanism (`tool_namespace`, `namespaced` lookup keys). It is provider-specific; omniagents runs against Azure/litellm proxies that already required stripping Responses-only fields (see `_strip_phase_from_model_input`). Name-prefixing survives every provider.

## Key Changes

### 1. omniagents — enable prefixed names (model boundary)

- `builder.py`: default `include_server_in_tool_names=True` in the `mcp_config` handed to `Agent` whenever the spec has MCP servers; `spec.mcp_config` may override it to `False`. This is the single switch that makes flat names unique.
- Build-time guard: after tool resolution, assert every MCP-derived public name is ≤64 chars and log the full name map once at debug level (the SDK already hard-fails on duplicates).

### 2. omniagents — session identity map (the tuple's source of truth)

New module-level helper (natural home: `core/agents/mcp_identity.py`), built once per agent build inside the existing `get_all_tools` wrapper in `configure_tool_approval` (approval.py) — the one place that already sees the final, converted tool list:

- **Construction by order-correlation, not parsing**: `MCPUtil.get_all_function_tools` preserves per-server tool order (index-mapped conversion) and iterates `agent.mcp_servers` in order. Re-list each server's tools (`server.list_tools` is cached and applies the server's own tool filter), group the converted MCP-origin `FunctionTool`s by `tool_origin.mcp_server_name` in encounter order, and zip. Result stored on the session:
  - `session.mcp_tool_identities: dict[public_name, tuple[server_name, original_name]]`
- Verify during implementation that `list_tools` filtering happens inside the server (so the zip lists are congruent); add an assertion that group lengths match, falling back to `(server_name, public_name)` for any tool the zip can't pair (hash-shortened edge, filter drift) — a stable key is mandatory, a pretty one is not.
- Also stamp `_mcp_identity = (server_name, original_name)` on each MCP-derived `FunctionTool` so the predicate needs no session lookup.

### 3. omniagents — tuple-keyed approval for MCP-derived tools

- `approval.py` `_attach`: when a tool carries `tool_origin.type == "mcp"`, attach a predicate that checks `_is_mcp_tool_always_allowed(session, server_name, original_name)` (the existing hosted-MCP tuple set) instead of the flat `session_allows_tool`. Plain function tools keep the flat set. `skip_approvals` and spec-level `safe_tool_names`/`safe_tool_patterns` continue to match against the tool's **public** name (pattern `.*` for autopilot keeps working unchanged).
- `service.py` `request_tool_approval`: `_pending_approval_tool_names` stores the identity tuple for MCP-derived calls (resolved via `session.mcp_tool_identities`); payload gains `server_label` and `tool_label` (original name) fields when the call is MCP-derived (flat `tool` stays the wire name).
- `service.py` `tool_approval_response`: on `always_approve`, if the tracker holds a tuple, add it to `always_allow_mcp_tools`; otherwise add the bare name to `always_allow_tools` as today.
- `bridge.py` interruption loop: the batch re-check (added for the parallel-approvals fix) becomes identity-aware — MCP-origin interruptions (read `item.tool_origin`) check the tuple set, others the flat set. The existing unit test gains an MCP-flavored sibling.

### 4. omniagents — event payloads carry structured identity

- `bridge.py` `_stream_event_payload`: for `tool_call_item` / `tool_call_output_item` with MCP `tool_origin`, add `server_label` and `tool_label` (original name via the session map) to the `tool_called` / `tool_result` payloads. `tool` remains the flat wire name (call-correlation key, unchanged).
- `mcp_ui` fix-up: `mcp_ui.record(...)` keys by **original** tool name (the `call_tool` wrapper sees originals), but the bridge pops by the streamed name — now prefixed. The bridge's `mcp_ui.pop(...)`/`lookup_tool_name` call sites translate through the identity map (public → original) before lookup. Audit this module for other name-keyed entry points (`register_tool_ui_resource`, `remember_call`).

### 5. launcher — display, categorization, allowlist

- `chat-types.ts` `ToolItem`/`ApprovalItem`: add optional `server_label?: string` and `tool_label?: string`; `use-chat-session.ts` forwards both from `tool_called` / `tool_result` / `tool_approval_requested`; the chat-session machine stores them (same pattern as the `running_summary` metadata wiring).
- `ToolCard` / `ApprovalCard` headers: display name = `tool_label ?? tool`; when `server_label` is present, render it as the small grey suffix (the treatment MCP approvals already use). No string-splitting of the wire name anywhere — cosmetic fallback for old history items without labels is the raw name, which is acceptable.
- `activity-group.ts` `categorize()` and `formatArgsPreview` callers: categorize on `tool_label ?? tool` so `list_tickets` counts as a read regardless of encoding.
- `client-tools.ts`: move `OMNI_PROJECTS_SAFE_TOOLS` from `safe_tool_names` to `safe_tool_overrides.safe_mcp_tools: [{server_label: 'omni-projects', tool_name: <original>}]` — the receiving plumbing (`_apply_safe_tool_overrides` → `always_allow_mcp_tools`) already exists. Same read/write split; `delete_project` and `delete_inbox_item` stay excluded. This closes the `extraMcpServers` collision noted in the current comment; update the comment.
- `HIDDEN_TOOLS`, omni-code prompts, and compaction rules reference function/client tools only — unaffected.

### 6. omni-code

- No code changes expected (its tools are function tools). Sweep `omni_agents/*/agent.yml` `safe_tool_names` and prompt prose for MCP tool-name references; none are known today.

## Interface Changes (wire)

`tool_called`, `tool_result`, `tool_approval_requested` payloads, MCP-derived calls only:

```
{
  ...existing fields, tool: "mcp_omni-projects__create_ticket",
  server_label: "omni-projects",
  tool_label: "create_ticket"
}
```

`safe_tool_overrides` from the launcher (interactive mode):

```
{ safe_tool_names: [<client safe tools>],
  safe_mcp_tools: [{ server_label: "omni-projects", tool_name: "list_tickets" }, ...] }
```

Session state: `always_allow_mcp_tools` (existing tuple set) now also receives grants from local-MCP "Always" clicks; `always_allow_tools` reverts to plain function/client tools only.

## Test Plan

omniagents (unit, `test_bridge.py` / new `test_mcp_identity.py` / `test_approval.py`-adjacent):
1. Identity map: two fake servers, overlapping original tool names → map pairs every public name to the right tuple; group-length mismatch falls back to `(server, public_name)` without raising.
2. Predicate: MCP-origin tool + tuple in `always_allow_mcp_tools` → no interruption; same original name from a *different* server → still prompts (the collision regression test).
3. Always on MCP tool: `tool_approval_response(always_approve=True)` lands the tuple in `always_allow_mcp_tools`, not the flat set.
4. Parallel batch: MCP flavor of `test_always_approve_covers_parallel_interruptions` — 4 same-tool MCP interruptions, one prompt.
5. Events: `tool_called`/`tool_result` for an MCP-origin item carry `server_label`/`tool_label`; function tools carry neither.
6. mcp_ui: a rich MCP result recorded under the original name is still popped and attached when the stream carries the prefixed name.

launcher (vitest):
7. Machine stores `server_label`/`tool_label` from TOOL_CALLED/TOOL_RESULT and approval events.
8. `categorize('mcp_omni-projects__list_tickets', label='list_tickets')` → reads bucket.
9. `buildSessionVariables` interactive mode emits the `safe_mcp_tools` tuples and no longer inlines omni-projects names into `safe_tool_names`.

Manual acceptance: launch a project column, call `list_tickets` (auto-approved via config), call `delete_project` (prompts; "Always" then covers a second `delete_project` but not a hypothetical same-named tool on another server); cards show `list_tickets — omni-projects`, not the `mcp_…` wire name.

## Ordering / rollout

Single lockstep release (per repo convention, no compat shims): omniagents (1–4) and launcher (5) land together; omni-code just picks up the omniagents bump. Interim mismatch is cosmetic only — an old launcher against new omniagents shows prefixed wire names on cards and its `safe_tool_names` allowlist entries stop matching (tools prompt once more; "Always" still works), nothing breaks structurally.

## Assumptions

- SDK prefix format `mcp_<server>__<tool>` is adopted as-is (deterministic, collision-safe, already tested upstream) rather than a custom `server__tool` scheme.
- Responses-API tool namespacing is rejected for provider portability (Azure/litellm).
- Grant keys prefer `(server, original_name)`; the zip fallback `(server, public_name)` is accepted for unpairable edge cases because key *stability* is the requirement, prettiness is not.
- `always_allow_mcp_tools` stays session-scoped (matches current function-tool "Always" semantics); persistence is out of scope.
- Old transcripts/history render with raw wire names (no labels) — accepted, display-only.
- Upstreaming an `mcp_tool_name` field on `ToolOrigin` to openai-agents would delete the order-correlation code; worth filing, but the plan does not depend on it.
