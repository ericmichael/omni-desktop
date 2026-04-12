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
        initiative_id: { type: 'string', description: 'Optional initiative ID to filter by' },
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
    name: 'list_initiatives',
    safe: true,
    description: 'List all initiatives for a project.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project ID to list initiatives for' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'read_brief',
    safe: true,
    description:
      'Read a project brief — the living document that captures the problem, appetite, solution direction, open questions, decisions, and scope boundaries.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project ID to read the brief for' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'read_initiative_brief',
    safe: true,
    description: 'Read an initiative brief — the deliverable-focused document describing goals and scope.',
    parameters: {
      type: 'object',
      properties: {
        initiative_id: { type: 'string', description: 'The initiative ID to read the brief for' },
      },
      required: ['initiative_id'],
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
] as const;

export const BRIEF_CLIENT_TOOLS = [
  {
    name: 'update_brief',
    description:
      'Update a project brief. Pass the full markdown content — it replaces the existing brief.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project ID to update the brief for' },
        content: { type: 'string', description: 'The full markdown content of the brief' },
      },
      required: ['project_id', 'content'],
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
    name: 'create_ticket',
    description: 'Create a new ticket in a project. It will be placed in the first pipeline column.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project to create the ticket in' },
        initiative_id: { type: 'string', description: 'Optional initiative ID. Defaults to the project\'s General initiative.' },
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
] as const;

export const INITIATIVE_CLIENT_TOOLS = [
  {
    name: 'create_initiative',
    description:
      'Create a new initiative (large feature or deliverable) in a project. Tickets can be grouped under initiatives.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project to create the initiative in' },
        title: { type: 'string', description: 'Initiative title' },
        description: { type: 'string', description: 'What this initiative delivers' },
        branch: { type: 'string', description: 'Optional git branch for this initiative. Tickets inherit it.' },
      },
      required: ['project_id', 'title'],
    },
  },
  {
    name: 'update_initiative',
    description: 'Update an initiative — title, description, branch, status, or brief.',
    parameters: {
      type: 'object',
      properties: {
        initiative_id: { type: 'string', description: 'The initiative ID to update' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        branch: { type: 'string', description: 'New branch' },
        status: { type: 'string', enum: ['active', 'completed', 'archived'], description: 'New status' },
        brief: { type: 'string', description: 'Full markdown content of the initiative brief' },
      },
      required: ['initiative_id'],
    },
  },
] as const;

export const INBOX_CLIENT_TOOLS = [
  {
    name: 'list_inbox',
    safe: true,
    description: 'List all inbox items, optionally filtered by status.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'done', 'deferred'],
          description: 'Filter by status. Omit to list all.',
        },
      },
    },
  },
  {
    name: 'create_inbox_item',
    description:
      'Add a new item to the inbox. Use for capturing raw ideas, requests, emails, or any unstructured input.',
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
    description: 'Update an inbox item — edit title, description, add notes, change status, assign to a project.',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'The inbox item ID to update' },
        title: { type: 'string', description: 'Updated title' },
        description: { type: 'string', description: 'Updated description' },
        status: { type: 'string', enum: ['open', 'done', 'deferred'], description: 'New status' },
        project_id: { type: 'string', description: 'Assign to a project (or null to unassign)' },
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
      'Graduate an inbox item into one or more tickets on a project. Creates the tickets and marks the inbox item as done.',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'The inbox item ID to graduate' },
        project_id: { type: 'string', description: 'The project to create tickets in' },
        tickets: {
          type: 'array',
          description: 'Array of tickets to create',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            },
            required: ['title'],
          },
        },
      },
      required: ['item_id', 'project_id', 'tickets'],
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

const buildProjectManagementInstructions = (opts?: {
  projectId?: string;
  projectLabel?: string;
  ticketId?: string;
}): string => {
  const lines: string[] = [
    '## Project Management Tools',
    'You have tools to help with project management when asked. You can use them to inspect your current context or assist the user with organizing work.',
    '',
    '- **Context**: Use get_ticket, list_tickets, search_tickets, read_brief, list_initiatives, read_initiative_brief, get_ticket_comments, get_ticket_history, and get_pipeline to understand the surrounding project state.',
    '- **Comments**: Use add_ticket_comment to record decisions, findings, progress, blockers, or context that should persist across runs. Use get_ticket_comments to read previous notes. Comments are visible to humans and other agents.',
    '- **Dependencies**: Tickets can block each other. Use update_ticket with add_blocked_by/remove_blocked_by to manage dependencies. get_ticket returns the blocked_by list.',
    '- **Notifications**: Use notify to send a heads-up to the human without stopping the run. Use escalate only when you are truly blocked and need the run to stop.',
    '- **Inbox**: Capture raw ideas, stakeholder requests, or vague asks with create_inbox_item. Graduate shaped items into tickets with inbox_to_tickets.',
    '- **Initiatives**: Group related tickets under an initiative (a large feature or deliverable). Use create_initiative to start a new one. Initiatives can have a branch — tickets inherit it.',
    '- **Brief**: Projects have a repo-level brief, initiatives have a deliverable-focused brief. Use read_brief / update_brief for projects, read_initiative_brief / update_initiative for initiative briefs.',
    '- **Tickets**: Use create_ticket to decompose work into scoped units. Use list_tickets or search_tickets to see current state. Use start_ticket to dispatch an agent.',
  ];

  if (opts?.projectId) {
    lines.push(
      '',
      `Current project: ${opts.projectLabel ?? opts.projectId} (ID: ${opts.projectId})`
    );
  }

  if (opts?.ticketId) {
    lines.push(`Current ticket: ${opts.ticketId}`);
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
  additional_instructions: buildProjectManagementInstructions(opts),
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
    ...INITIATIVE_CLIENT_TOOLS,
    ...BRIEF_CLIENT_TOOLS,
    ...INBOX_CLIENT_TOOLS,
    ...UI_CLIENT_TOOLS,
  ];
  return {
    client_tools: allTools,
    safe_tool_overrides: { safe_tool_names: extractSafeToolNames(allTools) },
    additional_instructions: buildProjectManagementInstructions(opts),
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
    ...INITIATIVE_CLIENT_TOOLS,
    ...BRIEF_CLIENT_TOOLS,
    ...INBOX_CLIENT_TOOLS,
    ...UI_CLIENT_TOOLS,
    ...CODE_UI_TOOLS,
  ];
  return {
    client_tools: allTools,
    safe_tool_overrides: { safe_tool_names: extractSafeToolNames(allTools) },
    additional_instructions: buildProjectManagementInstructions(opts),
  };
};
