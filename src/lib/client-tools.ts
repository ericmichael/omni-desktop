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

/** Autopilot sessions: ticket tools only. */
export const buildAutopilotVariables = (): Record<string, unknown> => ({
  client_tools: TICKET_CLIENT_TOOLS,
});

/** Human-interactive sessions: ticket + project tools. */
export const buildInteractiveVariables = (): Record<string, unknown> => ({
  client_tools: [...TICKET_CLIENT_TOOLS, ...PROJECT_CLIENT_TOOLS],
});
