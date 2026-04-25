/**
 * Launcher-only client tool definitions. Project / ticket / milestone / page /
 * inbox CRUD lives in the in-process MCP server (`packages/projects-mcp` via
 * `src/main/project-mcp-server.ts`); this file only carries tools that
 * coordinate with the launcher's runtime state — supervisor lifecycle, the
 * UI escalate/notify channels, app-control, and the renderer-side overlays.
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
 * Project-tier supervisor lifecycle tools — these dispatch / halt the
 * launcher's per-ticket supervisor and aren't covered by MCP (which only
 * sees DB rows, not the running supervisor process tree).
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
  'Before starting a ticket, read `get_ticket_comments` to see what prior runs learned and decided. Before ending work, write a comment summarizing decisions, blockers, and next steps — this is the cross-session memory for the next run.',
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

/**
 * Build context identifiers for `additional_instructions`. Starts with the
 * behavioral guidance above, then appends the specific project/ticket the
 * agent is operating in (when known) and per-ticket artifact-channel
 * guidance.
 */
const buildContextIdentifiers = (opts?: {
  projectId?: string;
  projectLabel?: string;
  ticketId?: string;
}): string => {
  const lines: string[] = [PROJECT_GUIDANCE];
  if (opts?.projectId) {
    lines.push('');
    lines.push(`Current project: ${opts.projectLabel ?? opts.projectId} (ID: ${opts.projectId})`);
  }
  if (opts?.ticketId) {
    lines.push(`Current ticket: ${opts.ticketId}`);
    lines.push(
      [
        '',
        '## Where to put output for the user',
        'You have two distinct channels for surfacing information, and they serve different purposes:',
        '',
        `- **Persistent artifacts directory (human-visible): \`${getContainerArtifactsDir(opts.ticketId)}\`**. Files you write here survive across runs and appear in this ticket's **Artifacts** tab in the launcher UI. Use for progress notes, research, generated deliverables, or any work product that should stick around for the user to review later and doesn't belong in the repo or project folder.`,
        '- **`display_artifact` tool** — renders content inline in the chat stream (markdown, HTML, etc.). Ephemeral, tied to the conversation. Use for "show this to the user now" — previews, summaries, diagrams responding to the current turn.',
        '',
        'Both are visible to the user. Choose by lifecycle: artifacts directory = "this should persist"; `display_artifact` = "show this now."',
      ].join('\n')
    );
  }
  return lines.join('\n');
};

/** Autopilot sessions: ticket tools + read-only context tools + column-scoped app control. */
export const buildAutopilotVariables = (opts?: {
  projectId?: string;
  projectLabel?: string;
  ticketId?: string;
}): Record<string, unknown> => {
  const allTools = [...TICKET_CLIENT_TOOLS, ...APP_CONTROL_TOOLS];
  return {
    client_tools: allTools,
    safe_tool_overrides: { safe_tool_names: extractSafeToolNames(allTools) },
    additional_instructions: buildContextIdentifiers(opts),
  };
};

/** Interactive sessions (Chat tab): all tools except code-deck-only tools. */
export const buildInteractiveVariables = (opts?: {
  projectId?: string;
  projectLabel?: string;
  ticketId?: string;
}): Record<string, unknown> => {
  const allTools = [
    ...TICKET_CLIENT_TOOLS,
    ...PROJECT_CLIENT_TOOLS,
    ...UI_CLIENT_TOOLS,
    ...APP_CONTROL_TOOLS,
  ];
  return {
    client_tools: allTools,
    safe_tool_overrides: { safe_tool_names: extractSafeToolNames(allTools) },
    additional_instructions: buildContextIdentifiers(opts),
  };
};

/** Code deck sessions: interactive tools + code-deck-only tools (open_preview, etc.). */
export const buildCodeVariables = (opts?: {
  projectId?: string;
  projectLabel?: string;
  ticketId?: string;
}): Record<string, unknown> => {
  const allTools = [
    ...TICKET_CLIENT_TOOLS,
    ...PROJECT_CLIENT_TOOLS,
    ...UI_CLIENT_TOOLS,
    ...CODE_UI_TOOLS,
    ...APP_CONTROL_TOOLS,
  ];
  return {
    client_tools: allTools,
    safe_tool_overrides: { safe_tool_names: extractSafeToolNames(allTools) },
    additional_instructions: buildContextIdentifiers(opts),
  };
};
