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

export const TICKET_CLIENT_TOOLS = [
  {
    name: 'escalate',
    description:
      'Pause the current run and notify the human operator. Only use when truly blocked by something outside your control.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Brief description of what you need help with' },
      },
      required: ['message'],
    },
  },
  {
    name: 'notify',
    description:
      'Send a notification to the human operator without stopping the run. Use for heads-up messages like "changed the DB schema" or "found something unexpected". The run continues.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Brief notification message for the human.' },
      },
      required: ['message'],
    },
  },
] as const;

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
    name: 'open_preview',
    safe: true,
    description:
      'Open a web preview panel showing the given URL. Use this to show the user a running web app, dev server, or any web page. The preview opens as an overlay panel with a URL bar.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to preview (e.g. "http://localhost:3000")' },
      },
      required: ['url'],
    },
  },
] as const;

/**
 * App-control tools — drive webviews (built-in browser, code-server, VNC
 * desktop, and user-installed webview apps) via Playwright-flavoured
 * commands. Every action takes an `app_id` from `list_apps`.
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
      "Capture a fresh snapshot and return only what changed since the previous `app_snapshot_diff` call (first call returns everything as `added`). Use between steps of a long automation to save context — no need to re-send an entire tree when only a toast appeared or a row was removed.",
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
      'Type text at the currently focused element — no ref targeting. Use `app_fill` if you want to replace a field\'s value; use `app_type` when the element is already focused (e.g. after a click).',
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
    description:
      'Press a single key (e.g. `Enter`, `Escape`, `ArrowLeft`). Goes to the focused element.',
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
      'Capture a PNG screenshot of the app\'s visible viewport and write it to the ticket\'s artifacts directory (or a default location). Returns the absolute file path — show the path to the user and/or attach it via `display_artifact`.',
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
      },
      required: ['app_id'],
    },
  },
  {
    name: 'app_eval',
    safe: true,
    description:
      'Run a JavaScript expression in the app\'s page context and return the result. The expression must be serialisable (primitives, arrays, objects). Use sparingly — `app_snapshot` + `app_click` is usually better.',
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
    description: 'Navigate back in the app\'s history, if possible.',
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' } },
      required: ['app_id'],
    },
  },
  {
    name: 'app_forward',
    safe: true,
    description: 'Navigate forward in the app\'s history, if possible.',
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' } },
      required: ['app_id'],
    },
  },
] as const;

/**
 * Browser-specific tools. Split out from APP_CONTROL_TOOLS because they
 * operate on browser concepts (tabs, tabsets, stylesheets, find-in-page)
 * rather than generic webviews. They still use the same `app_id` scheme for
 * the active-tab operations so scoping stays consistent.
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
  {
    name: 'browser_scroll',
    safe: true,
    description:
      "Scroll the active tab of a browser app. Pass one of: `to_top`, `to_bottom`, or `dx`/`dy` pixel offsets. `app_id` refers to a browser-kind app from `list_apps` (usually `\"browser\"`).",
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
    name: 'browser_inject_css',
    safe: true,
    description:
      "Inject a stylesheet into the active tab's document. Returns a `key` you can pass to `browser_remove_inserted_css` to undo. The stylesheet persists until the page navigates.",
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
    name: 'browser_remove_inserted_css',
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
    name: 'browser_find_in_page',
    safe: true,
    description:
      "Search the active tab for `query`. Returns `{ matches, active_ordinal }`. Set `find_next: true` to advance to the next match after a prior call.",
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
    name: 'browser_wait_for',
    safe: true,
    description:
      "Block until a condition on the active tab is met. Supply one of: `selector` (CSS selector must match something), `url_includes` (substring of current URL), or `network_idle: true` (page finished loading). Times out after `timeout_ms` (default 10000).",
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
    name: 'browser_scroll_to_ref',
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
    name: 'browser_pdf',
    safe: true,
    description:
      "Print the active tab to PDF and write it into the ticket's artifacts directory. Returns the absolute file path.",
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
    name: 'browser_full_screenshot',
    safe: true,
    description:
      'Capture a full-page PNG of the active tab (not just the viewport) using CDP. Returns the absolute file path in the ticket artifacts directory.',
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' } },
      required: ['app_id'],
    },
  },
  {
    name: 'browser_screenshot_element',
    safe: true,
    description:
      'Capture a PNG clipped to a specific element identified by `ref` (from `app_snapshot`). Great for visual confirmation of a button, card, or error message without a full-page screenshot.',
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' }, ref: { type: 'string' } },
      required: ['app_id', 'ref'],
    },
  },
  {
    name: 'browser_set_viewport',
    safe: true,
    description:
      'Emulate a specific viewport size and/or device-scale/mobile flag on the active tab. Pass `clear: true` to restore the real viewport. Useful for responsive testing.',
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
    name: 'browser_set_user_agent',
    safe: true,
    description:
      'Override the User-Agent header the active tab sends. Pass an empty string to restore the default.',
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' }, user_agent: { type: 'string' } },
      required: ['app_id', 'user_agent'],
    },
  },
  {
    name: 'browser_set_zoom',
    safe: true,
    description: 'Set the active tab\'s zoom factor (1.0 = 100%, range 0.25–5).',
    parameters: {
      type: 'object',
      properties: { app_id: { type: 'string' }, factor: { type: 'number' } },
      required: ['app_id', 'factor'],
    },
  },
  {
    name: 'browser_cookies_get',
    safe: true,
    description:
      "Read cookies from the active tab's partition. Optional filter narrows by URL, name, domain, or path. Returns Electron Cookie objects.",
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
    name: 'browser_cookies_set',
    safe: true,
    description:
      "Write or update a cookie in the active tab's partition. `url` is required by Electron to locate the cookie's host/scheme.",
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
    name: 'browser_cookies_clear',
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
    name: 'browser_storage_get',
    safe: true,
    description: 'Read all key/value pairs from localStorage or sessionStorage on the active tab.',
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
    name: 'browser_storage_set',
    safe: true,
    description: 'Write key/value pairs into localStorage or sessionStorage on the active tab.',
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
    name: 'browser_storage_clear',
    safe: true,
    description: 'Clear all keys from localStorage or sessionStorage on the active tab.',
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
    name: 'browser_network_log',
    safe: true,
    description:
      "Read the last N network requests the active tab made — method, URL, status, mimeType, timing. Useful for diagnosing failing fetches, authentication errors, or slow requests. Pass `clear: true` to reset the buffer after reading.",
    parameters: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        limit: { type: 'number', description: 'Max entries to return (default 100, up to 500 buffered).' },
        since: { type: 'number', description: 'CDP timestamp to filter from.' },
        url_includes: { type: 'string' },
        status_min: { type: 'number', description: 'Only entries with status >= this value (e.g. 400 to find failures).' },
        clear: { type: 'boolean' },
      },
      required: ['app_id'],
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
  '- Pipelines come from a linked project\'s `FLEET.md` or the built-in default; not configurable via tools.',
  '',
  '## Visible to the human',
  '',
  'Your actions produce immediate visible changes in the launcher (sidebar tree, kanban board, inbox, phase badges). Briefly narrate significant mutations — "Created 3 tickets under the Auth milestone" — so the user can follow along.',
  '',
  '## Driving apps (browser, webviews)',
  '',
  'The dock hosts web apps the user can see — the built-in browser, VS Code, a VNC desktop, and any custom webview apps they installed. You can drive them with `list_apps`, `app_snapshot`, `app_click`, `app_fill`, `app_type`, `app_press`, `app_screenshot`, `app_eval`, and `app_navigate`. Always `list_apps` first to find valid ids, then `app_snapshot` before clicking — refs are per-snapshot and invalidate after any navigation. Prefer `app_fill` for text fields (handles clearing); use `app_type` only when the element is already focused.',
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
        "Refresh these whenever the scope or nature of your work shifts — don't wait for a column change or for the work to be \"done.\" If nothing material has changed, leave them alone.",
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
  surface: 'chat' | 'code';
  autopilot?: boolean;
  context?: ContextIdentifierOpts;
  /** Prepended to additional_instructions when autopilot is true. */
  supervisorPrompt?: string;
};

const CHAT_CLIENT_TOOLS: readonly ClientToolDef[] = [
  ...TICKET_CLIENT_TOOLS,
  ...PROJECT_CLIENT_TOOLS,
  ...UI_CLIENT_TOOLS,
  ...APP_CONTROL_TOOLS,
  ...BROWSER_CLIENT_TOOLS,
];

const CODE_CLIENT_TOOLS: readonly ClientToolDef[] = [
  ...CHAT_CLIENT_TOOLS,
  ...CODE_UI_TOOLS,
];

export const buildSessionVariables = (args: SessionVariablesArgs): Record<string, unknown> => {
  const { surface, autopilot = false, context, supervisorPrompt } = args;
  const tools = surface === 'code' ? CODE_CLIENT_TOOLS : CHAT_CLIENT_TOOLS;
  const baseInstructions = buildContextIdentifiers(context);
  const instructions =
    autopilot && supervisorPrompt ? `${supervisorPrompt}\n\n${baseInstructions}` : baseInstructions;

  return {
    client_tools: tools,
    safe_tool_overrides: autopilot
      ? { safe_tool_patterns: ['.*'] }
      : { safe_tool_names: extractSafeToolNames(tools) },
    additional_instructions: instructions,
  };
};
