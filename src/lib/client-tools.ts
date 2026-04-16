/**
 * Client tool definitions for agent sessions.
 *
 * TICKET tools: scoped to the current ticket (get/move/escalate).
 * READ-ONLY CONTEXT tools: read surrounding project state (list_tickets, read_brief, etc.).
 * PROJECT tools: broader project & ticket management (list/create/update/start/stop).
 *
 * Autopilot runs get TICKET tools + READ-ONLY CONTEXT tools.
 * Human-interactive sessions get everything.
 */

import { getContainerArtifactsDir } from '@/lib/artifacts';

export const TICKET_CLIENT_TOOLS = [
  {
    name: 'get_ticket',
    safe: true,
    description:
      'Get a ticket\'s state including title, description, priority, current column, and pipeline columns. Pass a ticket_id to look up any ticket, or omit it to get the current ticket.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket ID to look up. Omit to get the current ticket.' },
      },
    },
  },
  {
    name: 'move_ticket',
    description: 'Move this ticket to a different pipeline column. Use exact column labels from the pipeline.',
    parameters: {
      type: 'object',
      properties: {
        column: { type: 'string', description: 'The target column label (e.g. "In Progress", "Done")' },
      },
      required: ['column'],
    },
  },
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
  {
    name: 'add_ticket_comment',
    description:
      'Add a comment to a ticket. Use this to record decisions, findings, progress, blockers, or anything useful for future runs. Comments persist across sessions and are visible to humans and other agents. Pass a ticket_id to comment on any ticket, or omit it to comment on the current ticket.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket ID to comment on. Omit to use the current ticket.' },
        content: { type: 'string', description: 'The comment content (markdown supported).' },
      },
      required: ['content'],
    },
  },
] as const;

/** Read-only context tools — available to autopilot agents for surrounding awareness. */
export const READONLY_CONTEXT_TOOLS = [
  {
    name: 'list_tickets',
    safe: true,
    description: 'List tickets in a project, optionally filtered by column or priority.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project ID to list tickets for' },
        milestone_id: { type: 'string', description: 'Optional milestone ID to filter by' },
        column: { type: 'string', description: 'Optional column label to filter by' },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Optional priority to filter by',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'list_milestones',
    safe: true,
    description: 'List all milestones for a project.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project ID to list milestones for' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'read_milestone_brief',
    safe: true,
    description: 'Read a milestone brief — the deliverable-focused document describing goals and scope.',
    parameters: {
      type: 'object',
      properties: {
        milestone_id: { type: 'string', description: 'The milestone ID to read the brief for' },
      },
      required: ['milestone_id'],
    },
  },
  {
    name: 'get_ticket_comments',
    safe: true,
    description:
      'Read comments on a ticket. Returns the comment history — decisions, findings, progress notes, and blockers recorded by agents and humans across runs.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket ID to read comments for.' },
      },
      required: ['ticket_id'],
    },
  },
  {
    name: 'search_tickets',
    safe: true,
    description:
      'Search across all tickets by keyword. Matches against title and description. Use to find related work or check for duplicates before creating a ticket.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — matched case-insensitively against ticket title and description.' },
        project_id: { type: 'string', description: 'Optional project ID to limit search scope.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_ticket_history',
    safe: true,
    description:
      'Get the run history for a ticket — how many times it has been attempted, what each run ended with, and token usage. Useful for understanding why previous attempts failed.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket ID to get run history for.' },
      },
      required: ['ticket_id'],
    },
  },
  {
    name: 'get_pipeline',
    safe: true,
    description:
      'Get the full pipeline definition for a project — columns with labels, descriptions, and gate status. Use to understand the workflow and what each column expects.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project ID to get the pipeline for.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'list_pages',
    safe: true,
    description:
      'List all pages in a project as a flat list with parent/child relationships. Each page has an id, title, icon, parentId, sortOrder, and structured properties (status, size, outcome, etc.).',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project ID to list pages for.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'read_page',
    safe: true,
    description:
      'Read a page\'s markdown content and metadata. Returns the title, properties, and full body text.',
    parameters: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The page ID to read.' },
      },
      required: ['page_id'],
    },
  },
] as const;

export const PROJECT_CLIENT_TOOLS = [
  {
    name: 'list_projects',
    safe: true,
    description: 'List all projects with their pipeline columns.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'create_project',
    description:
      'Create a new project. Optionally link a local directory as the workspace.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Human-readable project name' },
        workspace_dir: {
          type: 'string',
          description: 'Local directory to link as the project workspace.',
        },
      },
      required: ['label'],
    },
  },
  {
    name: 'update_project',
    description: "Update a project's label or linked workspace directory.",
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project ID to update' },
        label: { type: 'string', description: 'New project name' },
        workspace_dir: {
          type: 'string',
          description: 'Set the linked local directory. Pass an empty string to unlink.',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'delete_project',
    description:
      'Delete a project and all its tickets, pages, and milestones. Cannot delete the Personal project.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project ID to delete' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'create_ticket',
    description: 'Create a new ticket in a project. It will be placed in the first pipeline column.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project to create the ticket in' },
        milestone_id: { type: 'string', description: 'Optional milestone ID to group this ticket under.' },
        title: { type: 'string', description: 'Ticket title' },
        description: { type: 'string', description: 'Ticket description' },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Ticket priority (default: medium)',
        },
      },
      required: ['project_id', 'title'],
    },
  },
  {
    name: 'update_ticket',
    description: "Update a ticket's title, description, priority, branch, or dependencies.",
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket ID to update' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'New priority',
        },
        branch: { type: 'string', description: 'Git branch for this ticket.' },
        add_blocked_by: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ticket IDs to add as blockers (this ticket cannot proceed until those are done).',
        },
        remove_blocked_by: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ticket IDs to remove as blockers.',
        },
      },
      required: ['ticket_id'],
    },
  },
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
  {
    name: 'archive_ticket',
    description: 'Archive a resolved ticket so it drops out of active project views.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket ID to archive' },
      },
      required: ['ticket_id'],
    },
  },
  {
    name: 'unarchive_ticket',
    description: 'Restore an archived ticket back into resolved project views.',
    parameters: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket ID to unarchive' },
      },
      required: ['ticket_id'],
    },
  },
] as const;

export const MILESTONE_CLIENT_TOOLS = [
  {
    name: 'create_milestone',
    description:
      'Create a new milestone (large feature or deliverable) in a project. Tickets can be grouped under milestones.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project to create the milestone in' },
        title: { type: 'string', description: 'Milestone title' },
        description: { type: 'string', description: 'What this milestone delivers' },
        branch: { type: 'string', description: 'Optional git branch for this milestone. Tickets inherit it.' },
        due_date: {
          type: 'string',
          description: 'Optional due date in ISO format (for example `2026-04-30` or a full ISO timestamp).',
        },
      },
      required: ['project_id', 'title'],
    },
  },
  {
    name: 'update_milestone',
    description: 'Update a milestone — title, description, branch, status, brief, or due date.',
    parameters: {
      type: 'object',
      properties: {
        milestone_id: { type: 'string', description: 'The milestone ID to update' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        branch: { type: 'string', description: 'New branch' },
        status: { type: 'string', enum: ['active', 'completed', 'archived'], description: 'New status' },
        brief: { type: 'string', description: 'Full markdown content of the milestone brief' },
        due_date: {
          type: 'string',
          description: 'Optional due date in ISO format. Pass an empty string to clear it.',
        },
      },
      required: ['milestone_id'],
    },
  },
] as const;

export const PAGE_CLIENT_TOOLS = [
  {
    name: 'create_page',
    description:
      'Create a new page in a project. Pages are markdown documents organized in a tree. Use for notes, specs, research, meeting notes, or any structured content.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project to create the page in.' },
        title: { type: 'string', description: 'Page title.' },
        parent_id: {
          type: 'string',
          description: 'Optional parent page ID. Omit for a root-level page.',
        },
        content: { type: 'string', description: 'Optional markdown body content.' },
        icon: { type: 'string', description: 'Optional emoji icon for sidebar display.' },
      },
      required: ['project_id', 'title'],
    },
  },
  {
    name: 'update_page',
    description:
      'Update a page\'s title, content, icon, or structured properties. Only pass the fields you want to change.',
    parameters: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'The page ID to update.' },
        title: { type: 'string', description: 'New title.' },
        content: { type: 'string', description: 'New markdown body content (replaces the full body).' },
        icon: { type: 'string', description: 'New emoji icon.' },
        status: {
          type: 'string',
          enum: ['new', 'ready', 'doing', 'done', 'later'],
          description: 'Workflow status.',
        },
        size: {
          type: 'string',
          enum: ['small', 'medium', 'large', 'xl'],
          description: 'Effort sizing.',
        },
        outcome: { type: 'string', description: 'What does success look like? (1-2 sentences)' },
        not_doing: { type: 'string', description: 'What is explicitly out of scope.' },
        project_id: { type: 'string', description: 'Reassign to a different project.' },
        milestone_id: { type: 'string', description: 'Assign to a milestone.' },
      },
      required: ['page_id'],
    },
  },
] as const;

export const INBOX_CLIENT_TOOLS = [
  {
    name: 'list_inbox',
    safe: true,
    description:
      'List inbox items, optionally filtered by status. Omit the status parameter to list the default inbox view (active items in "new" or "shaped").',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['new', 'shaped', 'later'],
          description:
            'Filter by status. "new" = captured but unshaped, "shaped" = clarified and ready to promote, "later" = parked. Omit to list the default inbox (new + shaped, excluding promoted items).',
        },
      },
    },
  },
  {
    name: 'create_inbox_item',
    description:
      'Add a new item to the inbox. Use for capturing raw ideas, requests, emails, or any unstructured input. Item starts with status "new".',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the inbox item.' },
        description: { type: 'string', description: 'Optional longer description — brain dump, email paste, meeting note, etc.' },
        project_id: { type: 'string', description: 'Optional project ID to associate with.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_inbox_item',
    description:
      'Update an inbox item — edit title, description, assign to a project, shape it, or park/reactivate it. To shape an item, pass shaping fields like outcome/appetite/not_doing. Status only supports "new", "shaped", and "later".',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'The inbox item ID to update' },
        title: { type: 'string', description: 'Updated title' },
        description: { type: 'string', description: 'Updated description (overwrites the full body)' },
        status: {
          type: 'string',
          enum: ['new', 'shaped', 'later'],
          description:
            'New status. "new" = captured, "shaped" = active/shaped, "later" = parked. Use shaping fields to attach shaping metadata.',
        },
        project_id: { type: 'string', description: 'Assign to a project (or null to unassign)' },
        outcome: { type: 'string', description: 'What success looks like. Passing this shapes the item.' },
        appetite: {
          type: 'string',
          enum: ['small', 'medium', 'large', 'xl'],
          description: 'Rough effort sizing used when shaping the item.',
        },
        not_doing: { type: 'string', description: 'Explicitly out-of-scope work for the shaped item.' },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'delete_inbox_item',
    description: 'Remove an inbox item.',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'The inbox item ID to delete' },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'inbox_to_tickets',
    description:
      'Promote an inbox item into a single ticket on a project. The ticket title/description are seeded from the inbox item and the inbox item is marked as promoted.',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'The inbox item ID to graduate' },
        project_id: { type: 'string', description: 'The project to create tickets in' },
        milestone_id: { type: 'string', description: 'Optional milestone to assign the new ticket to.' },
      },
      required: ['item_id', 'project_id'],
    },
  },
  {
    name: 'inbox_to_project',
    description:
      'Promote an inbox item into a new project. The new project label comes from `label`, falling back to the inbox item title.',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'The inbox item ID to promote.' },
        label: { type: 'string', description: 'Optional label for the new project.' },
      },
      required: ['item_id'],
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
  'Before starting a ticket: read `get_ticket_comments` and `get_ticket_history` to see what prior runs learned and why they ended. Before ending work, write a comment summarizing decisions, blockers, and next steps — this is the cross-session memory for the next run.',
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

/** Autopilot sessions: ticket tools + read-only context tools for surrounding awareness. */
export const buildAutopilotVariables = (opts?: {
  projectId?: string;
  projectLabel?: string;
  ticketId?: string;
}): Record<string, unknown> => ({
  client_tools: [...TICKET_CLIENT_TOOLS, ...READONLY_CONTEXT_TOOLS],
  additional_instructions: buildContextIdentifiers(opts),
});

/** Interactive sessions (Chat tab): all tools except code-deck-only tools. */
export const buildInteractiveVariables = (opts?: {
  projectId?: string;
  projectLabel?: string;
  ticketId?: string;
}): Record<string, unknown> => {
  const allTools = [
    ...TICKET_CLIENT_TOOLS,
    ...READONLY_CONTEXT_TOOLS,
    ...PROJECT_CLIENT_TOOLS,
    ...MILESTONE_CLIENT_TOOLS,

    ...PAGE_CLIENT_TOOLS,
    ...INBOX_CLIENT_TOOLS,
    ...UI_CLIENT_TOOLS,
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
    ...READONLY_CONTEXT_TOOLS,
    ...PROJECT_CLIENT_TOOLS,
    ...MILESTONE_CLIENT_TOOLS,

    ...PAGE_CLIENT_TOOLS,
    ...INBOX_CLIENT_TOOLS,
    ...UI_CLIENT_TOOLS,
    ...CODE_UI_TOOLS,
  ];
  return {
    client_tools: allTools,
    safe_tool_overrides: { safe_tool_names: extractSafeToolNames(allTools) },
    additional_instructions: buildContextIdentifiers(opts),
  };
};
