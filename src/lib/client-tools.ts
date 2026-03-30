/**
 * Client tool definitions for agent sessions.
 *
 * TICKET tools: scoped to the current ticket (get/move/escalate).
 * PROJECT tools: broader project & ticket management (list/create/update/start/stop).
 *
 * Autopilot runs get TICKET tools only.
 * Human-interactive sessions get both TICKET + PROJECT tools.
 */

export const TICKET_CLIENT_TOOLS = [
  {
    name: 'get_ticket',
    description:
      'Get the current ticket state including title, description, priority, current column, and pipeline columns.',
    parameters: { type: 'object', properties: {} },
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
] as const;

export const BRIEF_CLIENT_TOOLS = [
  {
    name: 'read_brief',
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
    description: 'List all projects with their pipeline columns.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_tickets',
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
    description: "Update a ticket's title, description, or priority.",
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
    name: 'list_initiatives',
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
  {
    name: 'read_initiative_brief',
    description: 'Read an initiative brief — the deliverable-focused document describing goals and scope.',
    parameters: {
      type: 'object',
      properties: {
        initiative_id: { type: 'string', description: 'The initiative ID to read the brief for' },
      },
      required: ['initiative_id'],
    },
  },
] as const;

export const INBOX_CLIENT_TOOLS = [
  {
    name: 'list_inbox',
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

/** Autopilot sessions: ticket tools only. */
export const buildAutopilotVariables = (): Record<string, unknown> => ({
  client_tools: TICKET_CLIENT_TOOLS,
});

/** Human-interactive sessions: project + inbox + brief tools (no ticket-scoped tools). */
export const buildInteractiveVariables = (opts?: {
  projectId?: string;
  projectLabel?: string;
}): Record<string, unknown> => {
  const vars: Record<string, unknown> = {
    client_tools: [...PROJECT_CLIENT_TOOLS, ...INITIATIVE_CLIENT_TOOLS, ...BRIEF_CLIENT_TOOLS, ...INBOX_CLIENT_TOOLS],
  };

  const lines: string[] = [
    '## Project Management Tools',
    'You have tools to help with project management when asked. You can use them to inspect your current context or assist the user with organizing work.',
    '',
    '- **Inbox**: Capture raw ideas, stakeholder requests, or vague asks with create_inbox_item. Graduate shaped items into tickets with inbox_to_tickets.',
    '- **Initiatives**: Group related tickets under an initiative (a large feature or deliverable). Use list_initiatives to see current initiatives. Use create_initiative to start a new one. Initiatives can have a branch — tickets inherit it.',
    '- **Brief**: Projects have a repo-level brief, initiatives have a deliverable-focused brief. Use read_brief / update_brief for projects, read_initiative_brief / update_initiative for initiative briefs.',
    '- **Tickets**: Use create_ticket to decompose work into scoped units. Use list_tickets to see current state. Use start_ticket to dispatch an agent.',
  ];

  if (opts?.projectId) {
    lines.push(
      '',
      `Current project: ${opts.projectLabel ?? opts.projectId} (ID: ${opts.projectId})`
    );
  }

  vars.additional_instructions = lines.join('\n');
  return vars;
};
