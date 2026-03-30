/**
 * Tests for the "client tools" architecture — project tools (get_ticket, move_ticket, escalate)
 * proxied through the existing WebSocket RPC instead of a separate MCP server.
 *
 * 1. handleClientToolCall dispatcher (unit)
 * 2. buildRunVariables shape (unit)
 * 3. WebSocket round-trip: client_request → onClientRequest → client_response (integration)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import {
  buildAutopilotVariables,
  buildInteractiveVariables,
  TICKET_CLIENT_TOOLS,
  PROJECT_CLIENT_TOOLS,
  BRIEF_CLIENT_TOOLS,
} from '@/lib/client-tools';
import { TicketMachine } from '@/main/ticket-machine';
import type { TicketMachineCallbacks, ClientFunctionResponder } from '@/main/ticket-machine';
import type { TicketPhase } from '@/shared/ticket-phase';
import type { TicketId } from '@/shared/types';

// ---------------------------------------------------------------------------
// #region 1 — handleClientToolCall (extracted logic, tested directly)
// ---------------------------------------------------------------------------

/**
 * Minimal reproduction of ProjectManager.handleClientToolCall so we can
 * test the dispatching logic without instantiating a full ProjectManager.
 */
type MockTicket = {
  id: string;
  title: string;
  description: string;
  priority: string;
  columnId: string;
  projectId: string;
  phase?: string;
};

type MockProject = {
  id: string;
  label: string;
  workspaceDir: string;
};

type ToolCallCtx = {
  getTicketById: (id: TicketId) => MockTicket | null;
  getPipeline: (pid: string) => { columns: { id: string; label: string }[] };
  moveTicketToColumn: (tid: TicketId, colId: string) => void;
  sendToWindow: (...a: unknown[]) => void;
  machines: Map<TicketId, { machine: { isStreaming: () => boolean; stop: () => Promise<void>; forcePhase: (p: string) => void } }>;
  // Project-scoped tool support
  getProjects?: () => MockProject[];
  getTicketsByProject?: (projectId: string) => MockTicket[];
  addTicket?: (input: Record<string, unknown>) => MockTicket;
  updateTicket?: (id: TicketId, patch: Record<string, unknown>) => void;
  startSupervisor?: (id: TicketId) => Promise<void>;
  stopSupervisor?: (id: TicketId) => Promise<void>;
};

function handleClientToolCall(
  ticketId: TicketId,
  functionName: string,
  args: Record<string, unknown>,
  respond: (ok: boolean, result?: Record<string, unknown>) => void,
  ctx: ToolCallCtx
): void {
  if (functionName !== 'tool.call') return;

  const toolName = args.tool as string | undefined;
  const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;

  if (!toolName) {
    respond(false, { error: { message: 'Missing tool name' } });
    return;
  }

  const ticket = ctx.getTicketById(ticketId);
  if (!ticket) {
    respond(true, { error: 'Ticket not found' });
    return;
  }

  const pipeline = ctx.getPipeline(ticket.projectId);

  switch (toolName) {
    case 'get_ticket': {
      const column = pipeline.columns.find((c) => c.id === ticket.columnId);
      respond(true, {
        id: ticket.id,
        title: ticket.title,
        description: ticket.description || '',
        priority: ticket.priority,
        column: column?.label ?? ticket.columnId,
        pipeline: pipeline.columns.map((c) => c.label),
      });
      break;
    }
    case 'move_ticket': {
      const columnLabel = (toolArgs.column as string) ?? '';
      const col = pipeline.columns.find((c) => c.label.toLowerCase() === columnLabel.toLowerCase());
      if (!col) {
        const valid = pipeline.columns.map((c) => c.label).join(', ');
        respond(true, { error: `Unknown column: "${columnLabel}". Valid columns: ${valid}` });
        return;
      }
      ctx.moveTicketToColumn(ticketId, col.id);
      respond(true, { ok: true, column: col.label });
      break;
    }
    case 'escalate': {
      const message = (toolArgs.message as string) ?? '';
      if (!message) {
        respond(true, { error: 'Empty escalation message' });
        return;
      }
      ctx.sendToWindow('toast:show', {
        level: 'warning',
        title: `Agent needs help: ${ticket.title}`,
        description: message,
      });
      const entry = ctx.machines.get(ticketId);
      if (entry?.machine.isStreaming()) {
        void entry.machine.stop().then(() => {
          entry.machine.forcePhase('awaiting_input');
          respond(true, { ok: true, message: 'Escalated to human operator' });
        });
      } else {
        respond(true, { ok: true, message: 'Escalated to human operator' });
      }
      break;
    }
    case 'list_projects': {
      const projects = (ctx.getProjects?.() ?? []).map((p) => {
        const pl = ctx.getPipeline(p.id);
        return { id: p.id, label: p.label, workspaceDir: p.workspaceDir, columns: pl.columns.map((c) => c.label) };
      });
      respond(true, { projects });
      break;
    }
    case 'list_tickets': {
      const projectId = (toolArgs.project_id as string) ?? '';
      if (!projectId) { respond(true, { error: 'Missing project_id' }); return; }
      const pl = ctx.getPipeline(projectId);
      let tickets = ctx.getTicketsByProject?.(projectId) ?? [];
      const columnFilter = toolArgs.column as string | undefined;
      if (columnFilter) {
        const col = pl.columns.find((c) => c.label.toLowerCase() === columnFilter.toLowerCase());
        if (col) tickets = tickets.filter((t) => t.columnId === col.id);
      }
      const priorityFilter = toolArgs.priority as string | undefined;
      if (priorityFilter) tickets = tickets.filter((t) => t.priority === priorityFilter);
      const result = tickets.map((t) => ({
        id: t.id, title: t.title, description: t.description || '', priority: t.priority,
        column: pl.columns.find((c) => c.id === t.columnId)?.label ?? t.columnId, phase: t.phase,
      }));
      respond(true, { tickets: result });
      break;
    }
    case 'create_ticket': {
      const projectId = (toolArgs.project_id as string) ?? '';
      const title = (toolArgs.title as string) ?? '';
      if (!projectId || !title) { respond(true, { error: 'Missing project_id or title' }); return; }
      const proj = (ctx.getProjects?.() ?? []).find((p) => p.id === projectId);
      if (!proj) { respond(true, { error: `Project not found: ${projectId}` }); return; }
      const newTicket = ctx.addTicket?.({
        projectId, title,
        description: (toolArgs.description as string) ?? '',
        priority: (toolArgs.priority as string) ?? 'medium',
        blockedBy: [],
      });
      if (newTicket) {
        respond(true, { id: newTicket.id, title: newTicket.title, column: ctx.getPipeline(projectId).columns[0]?.label });
      }
      break;
    }
    case 'update_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) { respond(true, { error: 'Missing ticket_id' }); return; }
      const target = ctx.getTicketById(targetId);
      if (!target) { respond(true, { error: `Ticket not found: ${targetId}` }); return; }
      const patch: Record<string, unknown> = {};
      if (toolArgs.title) patch.title = toolArgs.title;
      if (toolArgs.description !== undefined) patch.description = toolArgs.description;
      if (toolArgs.priority) patch.priority = toolArgs.priority;
      ctx.updateTicket?.(targetId, patch);
      respond(true, { ok: true });
      break;
    }
    case 'start_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) { respond(true, { error: 'Missing ticket_id' }); return; }
      void ctx.startSupervisor?.(targetId).then(
        () => respond(true, { ok: true }),
        (err) => respond(true, { error: String(err) })
      );
      break;
    }
    case 'stop_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) { respond(true, { error: 'Missing ticket_id' }); return; }
      void ctx.stopSupervisor?.(targetId).then(
        () => respond(true, { ok: true }),
        (err) => respond(true, { error: String(err) })
      );
      break;
    }
    default:
      respond(true, { error: `Unknown tool: ${toolName}` });
  }
}

// Shared mock context
const MOCK_TICKET = {
  id: 'ticket-1',
  title: 'Fix the widget',
  description: 'The widget is broken',
  priority: 'high',
  columnId: 'col-2',
  projectId: 'proj-1',
};

const MOCK_PIPELINE = {
  columns: [
    { id: 'col-1', label: 'Backlog' },
    { id: 'col-2', label: 'In Progress' },
    { id: 'col-3', label: 'Done' },
  ],
};

const MOCK_PROJECT: MockProject = {
  id: 'proj-1',
  label: 'My Project',
  workspaceDir: '/workspace/my-project',
};

const MOCK_TICKET_2: MockTicket = {
  id: 'ticket-2',
  title: 'Add logging',
  description: 'Add structured logging',
  priority: 'low',
  columnId: 'col-1',
  projectId: 'proj-1',
  phase: 'idle',
};

const makeCtx = (overrides?: Partial<ToolCallCtx>) => ({
  getTicketById: vi.fn().mockReturnValue(MOCK_TICKET),
  getPipeline: vi.fn().mockReturnValue(MOCK_PIPELINE),
  moveTicketToColumn: vi.fn(),
  sendToWindow: vi.fn(),
  machines: new Map() as Map<TicketId, { machine: { isStreaming: () => boolean; stop: () => Promise<void>; forcePhase: (p: string) => void } }>,
  getProjects: vi.fn().mockReturnValue([MOCK_PROJECT]),
  getTicketsByProject: vi.fn().mockReturnValue([MOCK_TICKET, MOCK_TICKET_2]),
  addTicket: vi.fn().mockImplementation((input: Record<string, unknown>) => ({
    id: 'ticket-new',
    title: input.title,
    description: input.description ?? '',
    priority: input.priority ?? 'medium',
    columnId: 'col-1',
    projectId: input.projectId,
  })),
  updateTicket: vi.fn(),
  startSupervisor: vi.fn().mockResolvedValue(undefined),
  stopSupervisor: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('handleClientToolCall', () => {
  it('ignores non-tool.call function names', () => {
    const respond = vi.fn();
    const ctx = makeCtx();
    handleClientToolCall('ticket-1', 'other_function', {}, respond, ctx);
    expect(respond).not.toHaveBeenCalled();
  });

  it('returns error when tool name is missing', () => {
    const respond = vi.fn();
    const ctx = makeCtx();
    handleClientToolCall('ticket-1', 'tool.call', {}, respond, ctx);
    expect(respond).toHaveBeenCalledWith(false, { error: { message: 'Missing tool name' } });
  });

  it('returns error when ticket is not found', () => {
    const respond = vi.fn();
    const ctx = makeCtx({ getTicketById: vi.fn().mockReturnValue(null) });
    handleClientToolCall('ticket-1', 'tool.call', { tool: 'get_ticket' }, respond, ctx);
    expect(respond).toHaveBeenCalledWith(true, { error: 'Ticket not found' });
  });

  describe('get_ticket', () => {
    it('returns ticket data with column label and pipeline', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', { tool: 'get_ticket' }, respond, ctx);
      expect(respond).toHaveBeenCalledWith(true, {
        id: 'ticket-1',
        title: 'Fix the widget',
        description: 'The widget is broken',
        priority: 'high',
        column: 'In Progress',
        pipeline: ['Backlog', 'In Progress', 'Done'],
      });
    });

    it('falls back to columnId when column not found in pipeline', () => {
      const respond = vi.fn();
      const ctx = makeCtx({
        getTicketById: vi.fn().mockReturnValue({ ...MOCK_TICKET, columnId: 'unknown-col' }),
      });
      handleClientToolCall('ticket-1', 'tool.call', { tool: 'get_ticket' }, respond, ctx);
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ column: 'unknown-col' }));
    });
  });

  describe('move_ticket', () => {
    it('moves ticket to valid column (case-insensitive)', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', { tool: 'move_ticket', arguments: { column: 'done' } }, respond, ctx);
      expect(ctx.moveTicketToColumn).toHaveBeenCalledWith('ticket-1', 'col-3');
      expect(respond).toHaveBeenCalledWith(true, { ok: true, column: 'Done' });
    });

    it('returns error for unknown column with valid options', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', { tool: 'move_ticket', arguments: { column: 'Nonexistent' } }, respond, ctx);
      expect(respond).toHaveBeenCalledWith(true, {
        error: 'Unknown column: "Nonexistent". Valid columns: Backlog, In Progress, Done',
      });
      expect(ctx.moveTicketToColumn).not.toHaveBeenCalled();
    });
  });

  describe('escalate', () => {
    it('sends toast and responds when machine is not streaming', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', { tool: 'escalate', arguments: { message: 'I am stuck' } }, respond, ctx);
      expect(ctx.sendToWindow).toHaveBeenCalledWith('toast:show', expect.objectContaining({
        level: 'warning',
        description: 'I am stuck',
      }));
      expect(respond).toHaveBeenCalledWith(true, { ok: true, message: 'Escalated to human operator' });
    });

    it('returns error when message is empty', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', { tool: 'escalate', arguments: { message: '' } }, respond, ctx);
      expect(respond).toHaveBeenCalledWith(true, { error: 'Empty escalation message' });
    });

    it('stops streaming machine and sets awaiting_input', async () => {
      const respond = vi.fn();
      const mockMachine = {
        isStreaming: () => true,
        stop: vi.fn().mockResolvedValue(undefined),
        forcePhase: vi.fn(),
      };
      const machines = new Map<TicketId, { machine: typeof mockMachine }>([
        ['ticket-1', { machine: mockMachine }],
      ]);
      const ctx = makeCtx({ machines: machines as never });

      handleClientToolCall('ticket-1', 'tool.call', { tool: 'escalate', arguments: { message: 'Need help' } }, respond, ctx);

      // Wait for the async stop().then() chain
      await vi.waitFor(() => expect(respond).toHaveBeenCalled());

      expect(mockMachine.stop).toHaveBeenCalled();
      expect(mockMachine.forcePhase).toHaveBeenCalledWith('awaiting_input');
      expect(respond).toHaveBeenCalledWith(true, { ok: true, message: 'Escalated to human operator' });
    });
  });

  // --- Project-scoped tools ---

  describe('list_projects', () => {
    it('returns all projects with pipeline columns', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', { tool: 'list_projects' }, respond, ctx);
      expect(respond).toHaveBeenCalledWith(true, {
        projects: [{ id: 'proj-1', label: 'My Project', workspaceDir: '/workspace/my-project', columns: ['Backlog', 'In Progress', 'Done'] }],
      });
    });
  });

  describe('list_tickets', () => {
    it('returns all tickets for a project', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', { tool: 'list_tickets', arguments: { project_id: 'proj-1' } }, respond, ctx);
      const result = respond.mock.calls[0]![1] as { tickets: unknown[] };
      expect(result.tickets).toHaveLength(2);
    });

    it('filters by column label', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', { tool: 'list_tickets', arguments: { project_id: 'proj-1', column: 'Backlog' } }, respond, ctx);
      const result = respond.mock.calls[0]![1] as { tickets: { id: string }[] };
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0]!.id).toBe('ticket-2');
    });

    it('filters by priority', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', { tool: 'list_tickets', arguments: { project_id: 'proj-1', priority: 'high' } }, respond, ctx);
      const result = respond.mock.calls[0]![1] as { tickets: { id: string }[] };
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0]!.id).toBe('ticket-1');
    });

    it('returns error when project_id is missing', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', { tool: 'list_tickets', arguments: {} }, respond, ctx);
      expect(respond).toHaveBeenCalledWith(true, { error: 'Missing project_id' });
    });
  });

  describe('create_ticket', () => {
    it('creates a ticket and returns its id', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', {
        tool: 'create_ticket',
        arguments: { project_id: 'proj-1', title: 'New task', description: 'Do the thing', priority: 'high' },
      }, respond, ctx);
      expect(ctx.addTicket).toHaveBeenCalledWith({
        projectId: 'proj-1',
        title: 'New task',
        description: 'Do the thing',
        priority: 'high',
        blockedBy: [],
      });
      expect(respond).toHaveBeenCalledWith(true, { id: 'ticket-new', title: 'New task', column: 'Backlog' });
    });

    it('returns error for unknown project', () => {
      const respond = vi.fn();
      const ctx = makeCtx({ getProjects: vi.fn().mockReturnValue([]) });
      handleClientToolCall('ticket-1', 'tool.call', {
        tool: 'create_ticket',
        arguments: { project_id: 'nonexistent', title: 'Oops' },
      }, respond, ctx);
      expect(respond).toHaveBeenCalledWith(true, { error: 'Project not found: nonexistent' });
    });

    it('returns error when title is missing', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', {
        tool: 'create_ticket',
        arguments: { project_id: 'proj-1' },
      }, respond, ctx);
      expect(respond).toHaveBeenCalledWith(true, { error: 'Missing project_id or title' });
    });
  });

  describe('update_ticket', () => {
    it('updates ticket fields', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', {
        tool: 'update_ticket',
        arguments: { ticket_id: 'ticket-1', title: 'Updated title', priority: 'critical' },
      }, respond, ctx);
      expect(ctx.updateTicket).toHaveBeenCalledWith('ticket-1', { title: 'Updated title', priority: 'critical' });
      expect(respond).toHaveBeenCalledWith(true, { ok: true });
    });

    it('returns error for missing ticket_id', () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', {
        tool: 'update_ticket',
        arguments: {},
      }, respond, ctx);
      expect(respond).toHaveBeenCalledWith(true, { error: 'Missing ticket_id' });
    });

    it('returns error for unknown ticket', () => {
      const respond = vi.fn();
      const ctx = makeCtx({ getTicketById: vi.fn().mockImplementation((id: string) => id === 'ticket-1' ? MOCK_TICKET : null) });
      handleClientToolCall('ticket-1', 'tool.call', {
        tool: 'update_ticket',
        arguments: { ticket_id: 'nonexistent' },
      }, respond, ctx);
      expect(respond).toHaveBeenCalledWith(true, { error: 'Ticket not found: nonexistent' });
    });
  });

  describe('start_ticket', () => {
    it('calls startSupervisor and responds ok', async () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', {
        tool: 'start_ticket',
        arguments: { ticket_id: 'ticket-2' },
      }, respond, ctx);
      await vi.waitFor(() => expect(respond).toHaveBeenCalled());
      expect(ctx.startSupervisor).toHaveBeenCalledWith('ticket-2');
      expect(respond).toHaveBeenCalledWith(true, { ok: true });
    });

    it('returns error on failure', async () => {
      const respond = vi.fn();
      const ctx = makeCtx({ startSupervisor: vi.fn().mockRejectedValue(new Error('No sandbox')) });
      handleClientToolCall('ticket-1', 'tool.call', {
        tool: 'start_ticket',
        arguments: { ticket_id: 'ticket-2' },
      }, respond, ctx);
      await vi.waitFor(() => expect(respond).toHaveBeenCalled());
      expect(respond).toHaveBeenCalledWith(true, { error: 'Error: No sandbox' });
    });
  });

  describe('stop_ticket', () => {
    it('calls stopSupervisor and responds ok', async () => {
      const respond = vi.fn();
      const ctx = makeCtx();
      handleClientToolCall('ticket-1', 'tool.call', {
        tool: 'stop_ticket',
        arguments: { ticket_id: 'ticket-2' },
      }, respond, ctx);
      await vi.waitFor(() => expect(respond).toHaveBeenCalled());
      expect(ctx.stopSupervisor).toHaveBeenCalledWith('ticket-2');
      expect(respond).toHaveBeenCalledWith(true, { ok: true });
    });
  });

  it('returns error for unknown tool name', () => {
    const respond = vi.fn();
    const ctx = makeCtx();
    handleClientToolCall('ticket-1', 'tool.call', { tool: 'nonexistent_tool' }, respond, ctx);
    expect(respond).toHaveBeenCalledWith(true, { error: 'Unknown tool: nonexistent_tool' });
  });
});

// ---------------------------------------------------------------------------
// #region 2 — buildRunVariables shape
// ---------------------------------------------------------------------------

describe('client_tools shape', () => {

  it('every tool has name, description, and parameters', () => {
    for (const tool of [...TICKET_CLIENT_TOOLS, ...PROJECT_CLIENT_TOOLS, ...BRIEF_CLIENT_TOOLS]) {
      expect(tool.name).toBeTypeOf('string');
      expect(tool.description).toBeTypeOf('string');
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.properties).toBeDefined();
    }
  });

  it('autopilot variables contain only ticket tools', () => {
    const vars = buildAutopilotVariables() as { client_tools: { name: string }[] };
    const names = vars.client_tools.map((t) => t.name);
    expect(names).toEqual(['get_ticket', 'move_ticket', 'escalate']);
  });

  it('interactive variables contain project + brief + inbox tools (no ticket-scoped tools)', () => {
    const vars = buildInteractiveVariables() as { client_tools: { name: string }[]; additional_instructions: string };
    const names = vars.client_tools.map((t) => t.name);
    // Should NOT contain ticket-scoped tools
    expect(names).not.toContain('get_ticket');
    expect(names).not.toContain('move_ticket');
    expect(names).not.toContain('escalate');
    // Project tools
    expect(names).toContain('list_projects');
    expect(names).toContain('list_tickets');
    expect(names).toContain('create_ticket');
    expect(names).toContain('update_ticket');
    expect(names).toContain('start_ticket');
    expect(names).toContain('stop_ticket');
    // Brief tools
    expect(names).toContain('read_brief');
    expect(names).toContain('update_brief');
    // Inbox tools
    expect(names).toContain('list_inbox');
    expect(names).toContain('create_inbox_item');
    expect(names).toContain('update_inbox_item');
    expect(names).toContain('delete_inbox_item');
    expect(names).toContain('inbox_to_tickets');
    // Initiative tools
    expect(names).toContain('list_initiatives');
    expect(names).toContain('create_initiative');
    expect(names).toContain('update_initiative');
    expect(names).toContain('read_initiative_brief');
    expect(names).toHaveLength(17);
    // Should include additional_instructions with project management guidance
    expect(vars.additional_instructions).toContain('Inbox');
    expect(vars.additional_instructions).toContain('Brief');
    expect(vars.additional_instructions).toContain('Tickets');
    expect(vars.additional_instructions).toContain('Initiatives');
  });

  it('interactive variables include project context when provided', () => {
    const vars = buildInteractiveVariables({ projectId: 'proj-1', projectLabel: 'My Project' }) as {
      additional_instructions: string;
    };
    expect(vars.additional_instructions).toContain('My Project');
    expect(vars.additional_instructions).toContain('proj-1');
  });

  it('get_ticket takes no parameters', () => {
    const tool = TICKET_CLIENT_TOOLS.find((t) => t.name === 'get_ticket')!;
    expect(Object.keys(tool.parameters.properties)).toHaveLength(0);
  });

  it('move_ticket requires column parameter', () => {
    const tool = TICKET_CLIENT_TOOLS.find((t) => t.name === 'move_ticket')!;
    expect(tool.parameters.properties).toHaveProperty('column');
    expect(tool.parameters.required).toEqual(['column']);
  });

  it('escalate requires message parameter', () => {
    const tool = TICKET_CLIENT_TOOLS.find((t) => t.name === 'escalate')!;
    expect(tool.parameters.properties).toHaveProperty('message');
    expect(tool.parameters.required).toEqual(['message']);
  });

  it('list_tickets requires project_id', () => {
    const tool = PROJECT_CLIENT_TOOLS.find((t) => t.name === 'list_tickets')!;
    expect(tool.parameters.required).toEqual(['project_id']);
  });

  it('create_ticket requires project_id and title', () => {
    const tool = PROJECT_CLIENT_TOOLS.find((t) => t.name === 'create_ticket')!;
    expect(tool.parameters.required).toEqual(['project_id', 'title']);
  });
});

// ---------------------------------------------------------------------------
// #region 3 — WebSocket round-trip integration test
// ---------------------------------------------------------------------------

// Helpers — same pattern as ticket-machine.test.ts
let wss: WebSocketServer | null = null;

type ServerSocket = import('ws').WebSocket;
let serverSockets: ServerSocket[] = [];

const startServer = (handler: (method: string, params: Record<string, unknown>, id: string) => unknown): Promise<string> =>
  new Promise((resolve) => {
    wss = new WebSocketServer({ port: 0 });
    wss.on('listening', () => {
      const addr = wss!.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve(`ws://127.0.0.1:${port}`);
    });
    wss.on('connection', (ws) => {
      serverSockets.push(ws);
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { id?: string; method?: string; params?: Record<string, unknown> };
        if (msg.id && msg.method) {
          const result = handler(msg.method, msg.params ?? {}, msg.id);
          ws.send(JSON.stringify({ id: msg.id, result }));
        }
      });
    });
  });

const stopServer = (): Promise<void> =>
  new Promise((resolve) => {
    serverSockets = [];
    if (wss) {
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve());
      wss = null;
    } else {
      resolve();
    }
  });

/** Send a JSON-RPC notification from server to all connected clients. */
const broadcastNotification = (method: string, params: Record<string, unknown>): void => {
  if (!wss) return;
  const msg = JSON.stringify({ method, params });
  for (const client of wss.clients) client.send(msg);
};

const makeCallbacks = (): TicketMachineCallbacks & {
  phases: TicketPhase[];
  clientRequests: { fn: string; args: Record<string, unknown>; respond: ClientFunctionResponder }[];
} => {
  const phases: TicketPhase[] = [];
  const clientRequests: { fn: string; args: Record<string, unknown>; respond: ClientFunctionResponder }[] = [];
  return {
    phases,
    clientRequests,
    onPhaseChange: (_id, phase) => phases.push(phase),
    onMessage: vi.fn(),
    onRunEnd: vi.fn(),
    onTokenUsage: vi.fn(),
    onClientRequest: (_id, fn, args, respond) => {
      clientRequests.push({ fn, args, respond });
    },
  };
};

describe('WebSocket client_request → client_response round-trip', () => {
  afterEach(async () => {
    await stopServer();
    vi.restoreAllMocks();
  });

  it('delivers client_request to onClientRequest callback', async () => {
    const wsUrl = await startServer((method) => {
      if (method === 'server_call') return { session_id: 'sess-1' };
      if (method === 'start_run') return { session_id: 'sess-1', run_id: 'run-1' };
      return {};
    });
    const cb = makeCallbacks();
    const m = new TicketMachine('t1', cb);
    m.transition('provisioning');
    m.setWsUrl(wsUrl);
    await m.createSession();
    await m.startRun('go');

    // Simulate agent sending a client_request
    broadcastNotification('client_request', {
      function: 'tool.call',
      request_id: 'req-42',
      args: { tool: 'get_ticket', arguments: {} },
    });

    await vi.waitFor(() => expect(cb.clientRequests).toHaveLength(1));

    expect(cb.clientRequests[0]!.fn).toBe('tool.call');
    expect(cb.clientRequests[0]!.args).toEqual({ tool: 'get_ticket', arguments: {} });
  });

  it('sends client_response back over WebSocket when respond() is called', async () => {
    const serverReceived: { method: string; params: Record<string, unknown> }[] = [];

    const wsUrl = await startServer((method, params) => {
      if (method === 'server_call') return { session_id: 'sess-1' };
      if (method === 'start_run') return { session_id: 'sess-1', run_id: 'run-1' };
      // Capture client_response calls
      if (method === 'client_response') {
        serverReceived.push({ method, params });
        return {};
      }
      return {};
    });
    const cb = makeCallbacks();
    const m = new TicketMachine('t1', cb);
    m.transition('provisioning');
    m.setWsUrl(wsUrl);
    await m.createSession();
    await m.startRun('go');

    // Simulate agent sending a client_request
    broadcastNotification('client_request', {
      function: 'tool.call',
      request_id: 'req-99',
      args: { tool: 'get_ticket' },
    });

    // Wait for callback
    await vi.waitFor(() => expect(cb.clientRequests).toHaveLength(1));

    // Call respond() — this should send client_response back over WS
    cb.clientRequests[0]!.respond(true, { id: 'ticket-1', title: 'Test' });

    // The client_response is sent as an RPC call via sendRpc.
    // Wait for the server to receive it.
    await vi.waitFor(() => expect(serverReceived).toHaveLength(1), { timeout: 2000 });

    expect(serverReceived[0]!.params).toEqual(
      expect.objectContaining({
        request_id: 'req-99',
        ok: true,
        result: { id: 'ticket-1', title: 'Test' },
      })
    );
  });

  it('handles multiple concurrent client_requests independently', async () => {
    const wsUrl = await startServer((method) => {
      if (method === 'server_call') return { session_id: 'sess-1' };
      if (method === 'start_run') return { session_id: 'sess-1', run_id: 'run-1' };
      return {};
    });
    const cb = makeCallbacks();
    const m = new TicketMachine('t1', cb);
    m.transition('provisioning');
    m.setWsUrl(wsUrl);
    await m.createSession();
    await m.startRun('go');

    // Send two client_requests
    broadcastNotification('client_request', {
      function: 'tool.call',
      request_id: 'req-a',
      args: { tool: 'get_ticket' },
    });
    broadcastNotification('client_request', {
      function: 'tool.call',
      request_id: 'req-b',
      args: { tool: 'move_ticket', arguments: { column: 'Done' } },
    });

    await vi.waitFor(() => expect(cb.clientRequests).toHaveLength(2));

    // Both arrived with correct request data
    expect(cb.clientRequests.map((r) => r.args.tool)).toEqual(['get_ticket', 'move_ticket']);
  });

  it('ignores client_request with missing function or request_id', async () => {
    const wsUrl = await startServer((method) => {
      if (method === 'server_call') return { session_id: 'sess-1' };
      if (method === 'start_run') return { session_id: 'sess-1', run_id: 'run-1' };
      return {};
    });
    const cb = makeCallbacks();
    const m = new TicketMachine('t1', cb);
    m.transition('provisioning');
    m.setWsUrl(wsUrl);
    await m.createSession();
    await m.startRun('go');

    // Missing request_id
    broadcastNotification('client_request', { function: 'tool.call', args: {} });
    // Missing function
    broadcastNotification('client_request', { request_id: 'req-1', args: {} });

    // Give time for processing
    await new Promise((r) => setTimeout(r, 100));

    expect(cb.clientRequests).toHaveLength(0);
  });
});
