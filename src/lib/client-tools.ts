/**
 * Launcher-only client tool definitions.
 *
 * Project / ticket / milestone / page / inbox CRUD lives in the bundled
 * `omni-projects-mcp` stdio server (`packages/projects-mcp`), which the
 * agent spawns per `~/.config/omni_code/mcp.json`. This file only carries
 * tools that coordinate with the launcher's runtime state — escalation /
 * notification channels, supervisor lifecycle (start/stop), the deck UI
 * overlays, and the renderer-driven app-control + browser-control suites.
 */

import { getContainerArtifactsDir } from '@/lib/artifacts';
import type { ProjectSource } from '@/shared/types';

// Ticket-scoped client tools used to live here as launcher stubs
// (``notify`` / ``escalate``). They're now omniagents builtins (see the
// ``human`` capability in omni-code's ``agent.yml``) flowing through the
// ``client_request`` dispatch path with real UI (Notifications panel +
// EscalationBanner). The launcher no longer declares them.

/**
 * Supervisor lifecycle tools — drive the launcher's autopilot orchestrator.
 * Project / ticket CRUD lives in the MCP server; only run-control sits here
 * because it touches launcher-side process state, not just the database.
 */
export const PROJECT_CLIENT_TOOLS = [
  {
    name: 'start_ticket',
    description: 'Dispatch an agent to start working on a ticket.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket ID to start' },
      },
      required: ['ticket_id'],
    },
  },
  {
    name: 'stop_ticket',
    description: 'Stop the agent currently working on a ticket.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket ID to stop' },
      },
      required: ['ticket_id'],
    },
  },
] as const;

/** Code-deck-only UI tools — require the overlay panel infrastructure. */
export const CODE_UI_TOOLS = [
  {
    name: 'browser_open',
    safe: true,
    description:
      "Mount this session's browser sidecar and point it at `url`. Opens the sidecar if it is not already showing. Use to surface a running web app, dev server, or page to the user; for subsequent navigation use `app_navigate` against the `browser` app id.",
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to load (e.g. "http://localhost:3000")' },
      },
      required: ['url'],
    },
  },
  {
    name: 'launch_app',
    safe: true,
    description:
      'Open (mount) an app in a workspace column so it becomes drivable. Apps mount lazily — an app `list_apps` reports with `running: false` has no live surface until you launch it. For column-scoped apps (`code`, `desktop`/VNC, `terminal`, `browser`) pass the target column via `tab_id`; omit it to use your own column. Returns `{ handle_id }` — pass that as `app_id` to the `app_*` tools. Note: a column shows one non-chat app at a time, so launching one replaces whatever was mounted in that column.',
    parameters: {
      type: 'object',
      properties: {
        app_id: {
          type: 'string',
          description: 'App id from `list_apps` (e.g. "terminal", "code", "desktop", "browser").',
        },
        tab_id: {
          type: 'string',
          description: 'Target column id (from `list_workspace`). Omit to use your own column.',
        },
      },
      required: ['app_id'],
    },
  },
] as const;

/**
 * Global-orchestrator-only tools. Registered solely for the headless global
 * agent (`surface: 'global'`) — the workspace superuser that owns no column but
 * observes and drives every one. `list_workspace` is its map; `column_*` reach
 * into another column's agent (send / approve / cancel) via the renderer's
 * per-column RPC clients; `open_column` / `close_column` manage the deck itself.
 *
 * Autopilot start/stop is NOT here — that's the shared `start_ticket` /
 * `stop_ticket` in {@link PROJECT_CLIENT_TOOLS}.
 */
export const WORKSPACE_CLIENT_TOOLS = [
  {
    name: 'list_workspace',
    safe: true,
    description:
      'Survey the whole Tile workspace: every open column with its `tab_id`, session id, sandbox profile, bound project/ticket, the app it is currently showing, and its agent run state (idle / running / awaiting-approval). Plus the global dock apps. Call this first — the `tab_id` values it returns are what `launch_app` and the `column_*` tools need.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'open_column',
    safe: true,
    description:
      'Open a new agent column in the Tile workspace and start its sandbox. Optionally bind it to a project (and a ticket) so the sandbox mounts that project. Returns `{ tab_id }`.',
    parameters: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project to open the column on. Omit for an unbound column the user will configure.',
        },
        ticket_id: { type: 'string', description: 'Ticket to bind the column to (implies its project).' },
      },
    },
  },
  {
    name: 'close_column',
    description:
      'Close a workspace column and stop its sandbox. Destructive — the conversation and any unsaved in-sandbox state go away. Confirm with the user before calling.',
    parameters: {
      type: 'object',
      properties: { tab_id: { type: 'string', description: 'Column id from `list_workspace`.' } },
      required: ['tab_id'],
    },
  },
  {
    name: 'column_send',
    safe: true,
    description:
      "Send a message to another column's agent — starts a run there as if the user typed it. Use to delegate or steer work in a specific column. The target runs autonomously; poll its state with `list_workspace`.",
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        message: { type: 'string', description: "The instruction to send to that column's agent." },
      },
      required: ['tab_id', 'message'],
    },
  },
  {
    name: 'column_decide',
    safe: true,
    description:
      "Approve or reject a tool-call approval that a column's agent is blocked on. Get the `request_id` and which columns are awaiting approval from `list_workspace`.",
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        request_id: { type: 'string', description: 'Approval request id from `list_workspace`.' },
        decision: { type: 'string', enum: ['approve', 'reject'] },
      },
      required: ['tab_id', 'request_id', 'decision'],
    },
  },
  {
    name: 'column_cancel',
    safe: true,
    description: "Cancel / interrupt the in-flight run of a column's agent.",
    parameters: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
    },
  },
  {
    name: 'column_transcript',
    safe: true,
    description:
      "Read a window of a column's conversation — messages, tool calls/results, pending approvals — to see what that agent is doing. Returns `{ total, latest_cursor, entries, has_more }`; every entry carries a stable `cursor` and entries are chronological. **To poll incrementally**, pass `after: <the cursor you last saw>` (or a prior `latest_cursor`) — you get only what's new; an empty result means nothing changed. Omit `after` for the newest `limit` entries; pass `before: <cursor>` to page backward through history. Long fields cap at 2000 chars with the entry's `truncated` map giving each cut field's FULL length — use `column_read_entry` for the complete text. `list_workspace` returns each column's `latest_cursor` so you can spot which advanced.",
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        after: {
          type: 'number',
          description: 'Return only entries newer than this cursor (incremental polling).',
        },
        before: {
          type: 'number',
          description: 'Return entries older than this cursor (page backward through history).',
        },
        limit: { type: 'number', description: 'Max entries to return (default 20, max 100).' },
      },
      required: ['tab_id'],
    },
  },
  {
    name: 'column_read_entry',
    safe: true,
    description:
      "Read a single transcript entry in full — no truncation. Use after `column_transcript` shows an entry whose `truncated` map flags a long message or tool output you need complete. `cursor` is the entry's stable id from `column_transcript`.",
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        cursor: { type: 'number', description: 'Stable entry cursor from `column_transcript`.' },
      },
      required: ['tab_id', 'cursor'],
    },
  },
  {
    name: 'terminal_list',
    safe: true,
    description:
      "List a column's open terminals (their `terminal_id`s and which is active). Call before `terminal_send_keys` / `terminal_capture` only if you need a specific terminal; otherwise those default to the column's active terminal.",
    parameters: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
    },
  },
  {
    name: 'terminal_open',
    safe: true,
    description:
      'Open a new terminal in a column and make it active. Use when the user has none, or you want a fresh shell. Returns its `terminal_id`. The terminal is visible to the user.',
    parameters: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
    },
  },
  {
    name: 'terminal_capture',
    safe: true,
    description:
      "Capture the visible contents of a column's terminal — like `tmux capture-pane`. Returns the rendered screen + scrollback as text (exactly what the user sees). Use to read command output, errors, or current state before deciding what to send. This is the terminal's `snapshot`.",
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        lines: { type: 'number', description: 'Max trailing lines to return (default: full scrollback).' },
        terminal_id: { type: 'string', description: "Target terminal; omit for the column's active one." },
      },
      required: ['tab_id'],
    },
  },
  {
    name: 'terminal_send_keys',
    safe: true,
    description:
      'Send keys to a column\'s VISIBLE terminal — like `tmux send-keys`. `keys` is an ordered list of tokens; each is resolved as a key name (`C-c`, `Enter`, `Up`, `Down`, `Escape`, `Tab`, `M-b`, `F5`, `BSpace`, …) or, if unrecognized, typed literally. `literal: true` types every token verbatim (tmux `-l`); `count` repeats the whole sequence (tmux `-N`). This drives the SAME terminal the user is watching. Examples: run a command → `["git status", "Enter"]`; interrupt → `["C-c"]`; quit vim → `["Escape", ":q!", "Enter"]`. Tokens are sent back-to-back with no pacing (tmux-faithful): for a guaranteed double Ctrl-C — where the program must handle the first SIGINT before the second arrives — call this twice and check with `terminal_capture` between, rather than `["C-c", "C-c"]` in one call.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered tmux-style key tokens.',
        },
        literal: { type: 'boolean', description: 'Type every token verbatim (tmux `-l`).' },
        count: { type: 'number', description: 'Repeat the whole sequence N times (tmux `-N`).' },
        terminal_id: { type: 'string', description: "Target terminal; omit for the column's active one." },
      },
      required: ['tab_id', 'keys'],
    },
  },
] as const;

/**
 * App-control tools — drive webviews (built-in browser, code-server, VNC
 * desktop, and user-installed webview apps) via Playwright-flavoured
 * commands. Every action takes an `app_id` from `list_apps`.
 *
 * Covers three layers of capability, all keyed by `app_id`:
 * - Generic (any controllable app): navigate, snapshot, click, fill, type,
 *   press, screenshot, eval, console, history.
 * - Page primitives (browser/webview kinds): scroll, find, wait, inject_css,
 *   pdf, set_viewport / user_agent / zoom.
 * - WebContents state (browser/webview kinds): cookies, storage, network log.
 *
 * For multi-tab management of a browser app (creating/switching tabs in its
 * tabset) see {@link BROWSER_CLIENT_TOOLS}.
 *
 * Scoping rules (enforced by the handler, not the schema):
 * - Autopilot agents can only reach column-scoped apps in their own tab.
 * - Interactive agents reach global dock apps + their column.
 * - Non-controllable apps (chat, terminal) show up in `list_apps` but all
 *   action tools reject with a clear error.
 */
export const APP_CONTROL_TOOLS = [
  {
    name: 'list_apps',
    safe: true,
    description:
      'List the web apps currently available in your workspace — the built-in browser, VS Code, VNC desktop, and any custom webview apps the user has installed. Returns `[{ id, kind, scope, url, title, controllable }]`. `controllable: false` means the app (e.g. terminal) is visible in the dock but cannot be driven via snapshot/click. Call this first before any other app_* tool to learn what ids exist.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'app_snapshot',
    safe: true,
    description:
      'Capture an accessibility-tree snapshot of an app. Returns a ref-tagged tree you can use with `app_click` and `app_fill`. Refs are per-snapshot — after any navigation you must re-snapshot to get fresh refs.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string', description: 'App id from `list_apps` (e.g. "browser").' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'app_snapshot_diff',
    safe: true,
    description:
      'Capture a fresh snapshot and return only what changed since the previous `app_snapshot_diff` call (first call returns everything as `added`). Use between steps of a long automation to save context — no need to re-send an entire tree when only a toast appeared or a row was removed.',
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' } },
      required: ['app_id'],
    },
  },
  {
    name: 'app_navigate',
    safe: true,
    description: 'Load a URL in the given app (usually `browser`). Waits until the page finishes loading.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        url: { type: 'string', description: 'Fully qualified URL to navigate to.' },
      },
      required: ['app_id', 'url'],
    },
  },
  {
    name: 'app_click',
    safe: true,
    description: 'Click an element identified by a ref from `app_snapshot`.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        ref: { type: 'string', description: 'Element ref from the most recent `app_snapshot`.' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button (default: left).',
        },
      },
      required: ['app_id', 'ref'],
    },
  },
  {
    name: 'app_fill',
    safe: true,
    description:
      'Clear and type text into an input/textarea identified by a ref. Handles IME/composition correctly; prefer this over `app_type` when you know the target field.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        ref: { type: 'string' },
        text: { type: 'string', description: 'Text to insert. Empty string clears the field.' },
      },
      required: ['app_id', 'ref', 'text'],
    },
  },
  {
    name: 'app_type',
    safe: true,
    description:
      "Type text at the currently focused element — no ref targeting. Use `app_fill` if you want to replace a field's value; use `app_type` when the element is already focused (e.g. after a click).",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['app_id', 'text'],
    },
  },
  {
    name: 'app_press',
    safe: true,
    description: 'Press a single key (e.g. `Enter`, `Escape`, `ArrowLeft`). Goes to the focused element.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        key: { type: 'string', description: 'Electron keyCode, e.g. "Enter", "Tab", "a".' },
      },
      required: ['app_id', 'key'],
    },
  },
  {
    name: 'app_screenshot',
    safe: true,
    description:
      "Capture a PNG screenshot of an app and write it to the ticket's artifacts directory. By default captures the visible viewport. Pass `full_page: true` for the entire scrollable page (browser/webview only) or `ref` (from `app_snapshot`) to clip to a specific element. Returns the absolute file path.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        full_page: { type: 'boolean', description: 'Capture the full scrollable page instead of just the viewport.' },
        ref: { type: 'string', description: 'Element ref from `app_snapshot` — clip the screenshot to this element.' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'app_eval',
    safe: true,
    description:
      "Run a JavaScript expression in the app's page context and return the result. The expression must be serialisable (primitives, arrays, objects). Use sparingly — `app_snapshot` + `app_click` is usually better.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        code: { type: 'string', description: 'JavaScript expression or IIFE.' },
      },
      required: ['app_id', 'code'],
    },
  },
  {
    name: 'app_console',
    safe: true,
    description:
      'Read recent console messages the app has emitted (up to the last 1000). Use to diagnose why a page or dev-server looks wrong.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        min_level: {
          type: 'string',
          enum: ['log', 'warn', 'error'],
          description: 'Minimum severity to include. Default: log (all messages).',
        },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'app_reload',
    safe: true,
    description: 'Reload the current page of an app.',
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' } },
      required: ['app_id'],
    },
  },
  {
    name: 'app_back',
    safe: true,
    description: "Navigate back in the app's history, if possible.",
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' } },
      required: ['app_id'],
    },
  },
  {
    name: 'app_forward',
    safe: true,
    description: "Navigate forward in the app's history, if possible.",
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' } },
      required: ['app_id'],
    },
  },
  {
    name: 'app_scroll',
    safe: true,
    description:
      "Scroll the app's active page. Pass one of: `to_top`, `to_bottom`, or `dx`/`dy` pixel offsets. Works on any browser- or webview-kind app from `list_apps`.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        dx: { type: 'number' },
        dy: { type: 'number' },
        to_top: { type: 'boolean' },
        to_bottom: { type: 'boolean' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'app_scroll_to_ref',
    safe: true,
    description:
      'Scroll an element identified by a `ref` from `app_snapshot` into view. Use before clicks on far-down elements to avoid off-screen misses.',
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' }, ref: { type: 'string' } },
      required: ['app_id', 'ref'],
    },
  },
  {
    name: 'app_inject_css',
    safe: true,
    description:
      "Inject a stylesheet into the app's document. Returns a `key` you can pass to `app_remove_inserted_css` to undo. The stylesheet persists until the page navigates.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        css: { type: 'string', description: 'CSS source to inject.' },
      },
      required: ['app_id', 'css'],
    },
  },
  {
    name: 'app_remove_inserted_css',
    safe: true,
    description: 'Remove previously injected CSS by its key.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['app_id', 'key'],
    },
  },
  {
    name: 'app_find_in_page',
    safe: true,
    description:
      "Search the app's page for `query`. Returns `{ matches, active_ordinal }`. Set `find_next: true` to advance to the next match after a prior call.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        query: { type: 'string' },
        case_sensitive: { type: 'boolean' },
        forward: { type: 'boolean' },
        find_next: { type: 'boolean' },
      },
      required: ['app_id', 'query'],
    },
  },
  {
    name: 'app_wait_for',
    safe: true,
    description:
      "Block until a condition on the app's page is met. Supply one of: `selector` (CSS selector must match something), `url_includes` (substring of current URL), or `network_idle: true` (page finished loading). Times out after `timeout_ms` (default 10000).",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        selector: { type: 'string' },
        url_includes: { type: 'string' },
        network_idle: { type: 'boolean' },
        timeout_ms: { type: 'number' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'app_pdf',
    safe: true,
    description:
      "Print the app's page to PDF and write it into the ticket's artifacts directory. Returns the absolute file path.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        landscape: { type: 'boolean' },
        print_background: { type: 'boolean' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'app_set_viewport',
    safe: true,
    description:
      "Emulate a specific viewport size and/or device-scale/mobile flag on the app's page. Pass `clear: true` to restore the real viewport. Useful for responsive testing.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        device_scale_factor: { type: 'number' },
        mobile: { type: 'boolean' },
        clear: { type: 'boolean' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'app_set_user_agent',
    safe: true,
    description: 'Override the User-Agent header the app sends. Pass an empty string to restore the default.',
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' }, user_agent: { type: 'string' } },
      required: ['app_id', 'user_agent'],
    },
  },
  {
    name: 'app_set_zoom',
    safe: true,
    description: "Set the app's zoom factor (1.0 = 100%, range 0.25–5).",
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' }, factor: { type: 'number' } },
      required: ['app_id', 'factor'],
    },
  },
  {
    name: 'app_cookies_get',
    safe: true,
    description:
      "Read cookies from the app's partition. Optional filter narrows by URL, name, domain, or path. Returns Electron Cookie objects.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        url: { type: 'string' },
        name: { type: 'string' },
        domain: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'app_cookies_set',
    safe: true,
    description:
      "Write or update a cookie in the app's partition. `url` is required by Electron to locate the cookie's host/scheme.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        url: { type: 'string' },
        name: { type: 'string' },
        value: { type: 'string' },
        domain: { type: 'string' },
        path: { type: 'string' },
        secure: { type: 'boolean' },
        http_only: { type: 'boolean' },
        expiration_date: { type: 'number', description: 'Unix seconds.' },
        same_site: { type: 'string', enum: ['unspecified', 'no_restriction', 'lax', 'strict'] },
      },
      required: ['app_id', 'url', 'name', 'value'],
    },
  },
  {
    name: 'app_cookies_clear',
    safe: true,
    description: 'Remove cookies matching a filter. Returns the number removed.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        url: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'app_storage_get',
    safe: true,
    description: "Read all key/value pairs from localStorage or sessionStorage on the app's page.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        which: { type: 'string', enum: ['local', 'session'] },
      },
      required: ['app_id', 'which'],
    },
  },
  {
    name: 'app_storage_set',
    safe: true,
    description: "Write key/value pairs into localStorage or sessionStorage on the app's page.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        which: { type: 'string', enum: ['local', 'session'] },
        entries: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['app_id', 'which', 'entries'],
    },
  },
  {
    name: 'app_storage_clear',
    safe: true,
    description: "Clear all keys from localStorage or sessionStorage on the app's page.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        which: { type: 'string', enum: ['local', 'session'] },
      },
      required: ['app_id', 'which'],
    },
  },
  {
    name: 'app_network_log',
    safe: true,
    description:
      'Read the last N network requests the app made — method, URL, status, mimeType, timing. Useful for diagnosing failing fetches, authentication errors, or slow requests. Pass `clear: true` to reset the buffer after reading.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        limit: { type: 'number', description: 'Max entries to return (default 100, up to 500 buffered).' },
        since: { type: 'number', description: 'CDP timestamp to filter from.' },
        url_includes: { type: 'string' },
        status_min: {
          type: 'number',
          description: 'Only entries with status >= this value (e.g. 400 to find failures).',
        },
        clear: { type: 'boolean' },
      },
      required: ['app_id'],
    },
  },
] as const;

/**
 * Browser tabset-management tools. Distinct from `app_*` because they operate
 * on a browser app's *multi-tab structure* rather than a single drivable
 * surface — each browser app has its own tabset with multiple tabs, and these
 * tools create/close/activate/navigate individual tabs in it.
 *
 * `tabset_id` is an internal identifier:
 *   - `col:<codeTabId>` — a standalone browser column in the code deck
 *   - `dock:<codeTabId>` — the per-session dock browser inside a code tab
 *   - `dock:global` — the shell's global dock browser (if present)
 *
 * Callers can fetch the full list with `browser_list_tabsets`.
 */
export const BROWSER_CLIENT_TOOLS = [
  {
    name: 'browser_list_tabsets',
    safe: true,
    description:
      'List every browser tabset (each code-deck column and per-session dock) with its tabs, active tab, and profile. Use before `browser_tab_*` tools to learn valid `tabset_id` and `tab_id` values.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_tab_create',
    safe: true,
    description:
      'Open a new tab in the given tabset. Optionally navigate it to `url` and/or leave the active tab unchanged with `activate: false`.',
    parameters: {
      type: 'object',
      properties: {
        tabset_id: { type: 'string' },
        url: { type: 'string' },
        activate: { type: 'boolean' },
      },
      required: ['tabset_id'],
    },
  },
  {
    name: 'browser_tab_close',
    safe: true,
    description: 'Close a specific tab. If it was the only tab, the tabset retains one fresh blank tab.',
    parameters: {
      type: 'object',
      properties: {
        tabset_id: { type: 'string' },
        tab_id: { type: 'string' },
      },
      required: ['tabset_id', 'tab_id'],
    },
  },
  {
    name: 'browser_tab_activate',
    safe: true,
    description: 'Make the given tab the active one in its tabset.',
    parameters: {
      type: 'object',
      properties: {
        tabset_id: { type: 'string' },
        tab_id: { type: 'string' },
      },
      required: ['tabset_id', 'tab_id'],
    },
  },
  {
    name: 'browser_tab_navigate',
    safe: true,
    description:
      'Navigate a specific tab (not just the active one) to a URL. Accepts anything `browser_tab_create.url` does — URLs, `localhost:PORT`, etc. Records a history entry.',
    parameters: {
      type: 'object',
      properties: {
        tabset_id: { type: 'string' },
        tab_id: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['tabset_id', 'tab_id', 'url'],
    },
  },
] as const;

export const UI_CLIENT_TOOLS = [
  {
    name: 'display_plan',
    safe: true,
    description:
      'Present a step-by-step plan to the user for approval before executing. The tool blocks until the user approves or rejects. Returns { approved: true } or { approved: false }. Use this when you have a multi-step implementation plan and want the user to confirm before proceeding.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the plan (e.g. "Refactor auth middleware")' },
        description: { type: 'string', description: 'Optional brief description of the overall goal' },
        steps: {
          type: 'array',
          description: 'Ordered list of steps in the plan',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Step title' },
              description: { type: 'string', description: 'Optional detail about what this step involves' },
            },
            required: ['title'],
          },
        },
      },
      required: ['title', 'steps'],
    },
  },
] as const;

/**
 * Voice tools — registered only when the local voice runtime is active
 * (Electron / self-hosted local mode). `speak` is the explicit TTS channel:
 * the agent calls it to say something out loud, mirroring the ghostty/Jarvis
 * paradigm. Execution is local (VoiceService) via the client-tool round-trip,
 * so nothing is spoken unless the agent chooses to speak it. `safe` so it
 * never triggers an approval prompt.
 */
export const VOICE_CLIENT_TOOLS = [
  {
    name: 'speak',
    safe: true,
    description:
      'Say a short message to the user out loud via text-to-speech. This is your VOICE — the user hears it. Keep it brief and natural (one or two sentences). Text you return at the end of your turn is NOT spoken; only what you pass to speak() is heard. Speak before long tool work so the user knows what you are doing, and speak the result when done.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to say out loud. Short and conversational.' },
      },
      required: ['message'],
    },
  },
] as const;

type ClientToolDef = { name: string; safe?: boolean; [k: string]: unknown };

/** Extract tool names that are marked safe (read-only, no approval needed). */
export const extractSafeToolNames = (tools: readonly ClientToolDef[]): string[] =>
  tools.filter((t) => t.safe).map((t) => t.name);

/**
 * Behavioral guidance inlined into `additional_instructions`. Covers the
 * concepts tool schemas can't convey: channel choice (comment vs. notify vs.
 * escalate), gate semantics, cross-session memory, and UI-visibility nuances.
 *
 * Kept short on purpose — tool names/params already come from `client_tools`,
 * so this file should never redocument them. Anything here should be
 * non-obvious from a tool's description alone.
 */
const PROJECT_GUIDANCE = [
  '## Working with projects and tickets',
  '',
  'Hierarchy: **Project** → optional **Milestone** → **Ticket** in a pipeline column. Tickets are the unit of dispatchable agent work; tickets without a milestone live in the Backlog column.',
  '',
  '**Inbox** captures raw input. Items flow `new` (captured) → `shaped` (outcome filled) → promoted to a ticket (`inbox_to_tickets`) or a project (`inbox_to_project`). Capture first, shape later.',
  '',
  '**Pages** are markdown docs per project; the root page is the project brief.',
  '',
  '## Choose the right channel to talk to the human',
  '',
  '- `add_ticket_comment` — default. Persists across runs, no alert. Use for decisions, progress, findings, handoff notes.',
  '- `notify` — heads-up, run continues. Use for time-sensitive but non-blocking info.',
  '- `escalate` — **stops the run**. Use only when truly blocked (missing credentials, ambiguous requirements, external action).',
  '',
  'Before starting a ticket: read `get_ticket_comments` to see what prior runs learned. Before ending work, write a comment summarizing decisions, blockers, and next steps — this is the cross-session memory for the next run.',
  '',
  '## Pipeline gates',
  '',
  'Columns with `gate: true` require human review. Move tickets *to* a gate column and escalate or notify — never advance past a gate automatically.',
  '',
  '## Known limitations',
  '',
  '- Ticket resolution (`completed` / `wont_do` / `duplicate` / `cancelled`) is UI-only; there is no client tool for it.',
  '- `start_ticket` can fail with `WIP_LIMIT:` if too many tickets are already active. Tell the user and suggest a running ticket to stop.',
  "- Pipelines come from a linked project's `FLEET.md` or the built-in default; not configurable via tools.",
  '',
  '## Visible to the human',
  '',
  'Your actions produce immediate visible changes in the launcher (sidebar tree, kanban board, inbox, phase badges). Briefly narrate significant mutations — "Created 3 tickets under the Auth milestone" — so the user can follow along.',
  '',
  '## Driving apps (browser, webviews)',
  '',
  'The dock hosts web apps the user can see — the built-in browser, VS Code, a VNC desktop, and any custom webview apps they installed. Drive them through the `app_*` family: `list_apps` (discovery), `app_snapshot` / `app_click` / `app_fill` / `app_type` / `app_press` (interaction), `app_navigate` / `app_reload` / `app_back` / `app_forward` (history), `app_screenshot` / `app_pdf` (capture), `app_eval` / `app_console` / `app_network_log` (diagnostics), `app_scroll` / `app_scroll_to_ref` / `app_find_in_page` / `app_wait_for` (page), `app_inject_css` / `app_remove_inserted_css` / `app_set_viewport` / `app_set_user_agent` / `app_set_zoom` (presentation), `app_cookies_*` / `app_storage_*` (state). Always `list_apps` first to find valid ids, then `app_snapshot` before clicking — refs are per-snapshot and invalidate after any navigation. Prefer `app_fill` for text fields (handles clearing); use `app_type` only when the element is already focused. Browser apps additionally have `browser_*` tools for managing their tabsets (multiple tabs in one app).',
].join('\n');

export type ContextIdentifierOpts = {
  projectId?: string;
  projectLabel?: string;
  ticketId?: string;
  /**
   * Absolute path to the ticket's artifacts directory as the agent sees it.
   * Pass the host path when the agent runs on the host (sandboxBackend
   * 'none' / 'local'); pass the container path otherwise. Omit to default
   * to the container path.
   */
  artifactsDir?: string;
  /**
   * Absolute path to the ticket's workspace directory (worktree root). Set
   * by the orchestrator before the session is opened; surfaced into
   * ``session.variables`` so omni-code tools/skills can read it via
   * ``session_variables(ctx)`` without parsing additional_instructions.
   */
  workspaceDir?: string;
  /**
   * Project sources, when known. Renders a workspace-layout section so the
   * agent knows which subdirectories of ``/workspace/`` are populated and
   * what each one represents. Multi-source projects co-mount each here.
   */
  sources?: readonly ProjectSource[];
};

/** One-line label for a source — what to call out so the agent recognizes it. */
const describeSourceForContext = (s: ProjectSource): string => {
  if (s.kind === 'git-remote') {
    const ref = s.defaultBranch ? `@${s.defaultBranch}` : '';
    return `${s.repoUrl}${ref}`;
  }
  const basename = s.workspaceDir.split('/').filter(Boolean).pop() ?? s.workspaceDir;
  return basename;
};

/**
 * Build context identifiers for `additional_instructions`. Starts with the
 * behavioral guidance above, then appends the specific project/ticket the
 * agent is operating in (when known) and per-ticket artifact-channel
 * guidance.
 */
const buildContextIdentifiers = (opts?: ContextIdentifierOpts): string => {
  const lines: string[] = [PROJECT_GUIDANCE];
  if (opts?.projectId) {
    lines.push('');
    lines.push(`Current project: ${opts.projectLabel ?? opts.projectId} (ID: ${opts.projectId})`);
  }
  if (opts?.sources && opts.sources.length > 0) {
    const intro =
      opts.sources.length === 1
        ? 'This project has one source mounted in your workspace:'
        : `This project has ${opts.sources.length} sources co-mounted in your workspace. Each lives at a separate subdirectory and may need to be investigated when making changes:`;
    const sourceLines = opts.sources.map(
      (s) => `- \`/workspace/${s.mountName}/\` — ${describeSourceForContext(s)} (${s.kind})`
    );
    lines.push('');
    lines.push('## Workspace Layout');
    lines.push(intro);
    lines.push(...sourceLines);
  }
  if (opts?.ticketId) {
    lines.push(`Current ticket: ${opts.ticketId}`);
    const artifactsDir = opts.artifactsDir ?? getContainerArtifactsDir(opts.ticketId);
    lines.push(
      [
        '',
        '## Where to put output for the user',
        'You have two distinct channels for surfacing information, and they serve different purposes:',
        '',
        `- **Persistent artifacts directory (human-visible): \`${artifactsDir}\`**. Files you write here survive across runs and appear in this ticket's **Artifacts** tab in the launcher UI. Use for progress notes, research, generated deliverables, or any work product that should stick around for the user to review later and doesn't belong in the repo or project folder.`,
        '- **`display_artifact` tool** — renders content inline in the chat stream (markdown, HTML, etc.). Ephemeral, tied to the conversation. Use for "show this to the user now" — previews, summaries, diagrams responding to the current turn.',
        '',
        'Both are visible to the user. Choose by lifecycle: artifacts directory = "this should persist"; `display_artifact` = "show this now."',
        '',
        '## Keep the PR writeup current',
        '',
        "Maintain an accurate PR title and body reflecting the changes you've made so far. The launcher's **PR** tab reads these files (polled, so updates are picked up automatically):",
        '',
        `- \`${artifactsDir}/pr/PR_TITLE.md\` — one short line (≤70 chars) describing the ticket's change. No markdown, no trailing punctuation.`,
        `- \`${artifactsDir}/pr/PR_BODY.md\` — markdown with a **Summary** section (what and why) and a **Test plan** section (how to verify). Keep it grounded in the diff.`,
        `- \`${artifactsDir}/pr/CI_STATUS.md\` — optional. Latest CI/test status, if you've produced any.`,
        '',
        'Refresh these whenever the scope or nature of your work shifts — don\'t wait for a column change or for the work to be "done." If nothing material has changed, leave them alone.',
      ].join('\n')
    );
  }
  return lines.join('\n');
};

/**
 * Build the variables bundle attached to a run / session.
 *
 * - `surface` picks the tool set. Chat surface gets project/inbox/page tools but
 *   not code-deck-only tools. Code surface gets everything.
 * - `autopilot` picks the approval policy. When true, we emit the catch-all
 *   `safe_tool_patterns: ['.*']` so every tool runs without approval, and the
 *   caller can supply a `supervisorPrompt` to prepend to additional_instructions.
 *   When false, only tools marked `safe: true` on the client skip approval.
 *
 * One builder, two switches — this replaces the old `buildAutopilotVariables` /
 * `buildInteractiveVariables` / `buildCodeVariables` trio whose divergent
 * whitelists were the source of the "tool calls require approval" bug.
 */
export type SessionVariablesArgs = {
  surface: 'chat' | 'code' | 'global';
  autopilot?: boolean;
  context?: ContextIdentifierOpts;
  /** Prepended to additional_instructions when autopilot is true. */
  supervisorPrompt?: string;
  /**
   * Enable local voice mode: registers the `speak` client tool and injects the
   * speak-first persona guidance. Set by the renderer only when the local
   * voice runtime is active (Electron / self-hosted local). See VoiceService.
   */
  voice?: boolean;
  /**
   * Voice persona character (e.g. Jarvis), appended to additional_instructions
   * in voice mode. Empty for the neutral Default persona. Ignored unless
   * `voice` is true. See `shared/voice-personas.ts`.
   */
  personaInstructions?: string;
};

/**
 * Persona guidance for voice mode, appended to additional_instructions. The
 * `speak` tool is the spoken channel; the chat (final text) is silent — so the
 * agent must voice anything it wants heard. Kept short; the tool description
 * carries the rest.
 */
const VOICE_GUIDANCE = [
  '## Voice mode',
  '',
  'The user is talking to you by voice. Reply by **calling the `speak` tool** — that is the only thing the user hears. Text you return at the end of your turn is shown silently in the chat, never spoken.',
  '',
  '- Speak in short, natural sentences. If you did not say it with `speak`, the user did not hear it.',
  '- Speak a brief acknowledgement before any long tool work ("One moment, checking that now."), and speak the outcome when finished.',
  '- Put long details (paths, commands, code) in your returned text and just tell the user you have done so — do not read them aloud.',
].join('\n');

const CHAT_CLIENT_TOOLS: readonly ClientToolDef[] = [
  ...PROJECT_CLIENT_TOOLS,
  ...UI_CLIENT_TOOLS,
  ...APP_CONTROL_TOOLS,
  ...BROWSER_CLIENT_TOOLS,
];

const CODE_CLIENT_TOOLS: readonly ClientToolDef[] = [...CHAT_CLIENT_TOOLS, ...CODE_UI_TOOLS];

/**
 * The headless workspace orchestrator: everything a code column has, plus the
 * workspace-superuser tools. App-scope enforcement (this caller may drive every
 * column's apps, addressed by `handle_id`) lives in the renderer's
 * `buildClientToolHandler`, not in the tool list.
 */
const GLOBAL_CLIENT_TOOLS: readonly ClientToolDef[] = [...CODE_CLIENT_TOOLS, ...WORKSPACE_CLIENT_TOOLS];

/**
 * Persona/role guidance for the global orchestrator, appended to
 * additional_instructions when `surface: 'global'`. Explains the superuser
 * stance and the addressing rule the tool schemas can't convey (the same app
 * id exists in many columns → address by `handle_id`).
 */
const GLOBAL_GUIDANCE = [
  '## You are the workspace orchestrator',
  '',
  'You operate the entire Tile workspace on the user’s behalf — usually by voice. You own no column of your own; instead you observe and drive every column.',
  '',
  '- `list_workspace` is your map: open columns, their sessions, sandbox profiles, bound project/ticket, and run state. `list_apps` shows every app across all columns (each with a `handle_id`) plus the global dock apps.',
  '- Act inside a column with `column_send` (instruct its agent), `column_decide` (approve/reject what it is blocked on), `column_cancel` (stop it), and `start_ticket` / `stop_ticket` (autopilot). Shape the deck with `open_column`, `close_column`, and `launch_app`.',
  '- Drive any column’s apps with the `app_*` tools using the `handle_id` from `list_apps` — not a bare name, because the same app (e.g. `terminal`) exists in many columns.',
  '- Narrate what you are doing, and confirm with the user before anything destructive (closing a column, cancelling a run).',
].join('\n');

export const buildSessionVariables = (args: SessionVariablesArgs): Record<string, unknown> => {
  const { surface, autopilot = false, context, supervisorPrompt, voice = false, personaInstructions } = args;
  const baseTools =
    surface === 'global' ? GLOBAL_CLIENT_TOOLS : surface === 'code' ? CODE_CLIENT_TOOLS : CHAT_CLIENT_TOOLS;
  const tools: readonly ClientToolDef[] = voice ? [...baseTools, ...VOICE_CLIENT_TOOLS] : baseTools;
  const baseInstructions = buildContextIdentifiers(context);
  const parts = [
    autopilot && supervisorPrompt ? supervisorPrompt : '',
    surface === 'global' ? GLOBAL_GUIDANCE : '',
    voice ? VOICE_GUIDANCE : '',
    voice && personaInstructions ? personaInstructions : '',
    baseInstructions,
  ].filter(Boolean);
  const instructions = parts.join('\n\n');

  return {
    client_tools: tools,
    safe_tool_overrides: autopilot ? { safe_tool_patterns: ['.*'] } : { safe_tool_names: extractSafeToolNames(tools) },
    additional_instructions: instructions,
    // Structured ticket context — omniagents persists these into
    // ``session.variables`` so omni-code tools / server functions /
    // prompts can read them via ``session_variables(ctx)`` without
    // grepping additional_instructions.
    ...(context?.ticketId ? { ticket_id: context.ticketId } : {}),
    ...(context?.projectId ? { project_id: context.projectId } : {}),
    ...(context?.workspaceDir ? { workspace_dir: context.workspaceDir } : {}),
  };
};
