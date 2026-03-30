/**
 * Project MCP Server
 *
 * Exposes project-management tools over the MCP Streamable HTTP transport.
 * The launcher starts one MCP server per sandbox so the agent inside Docker can
 * interact with tickets, pipelines, and UI via standard MCP tool calls.
 *
 * From inside the container the agent connects to:
 *   http://host.docker.internal:{port}/mcp
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { TicketId, Pipeline } from '@/shared/types';

// ---------------------------------------------------------------------------
//  Context interface — the ProjectManager passes a narrow delegate so this
//  module stays decoupled from the full manager.
// ---------------------------------------------------------------------------

export type ProjectMcpDelegate = {
  /** Return ticket data (or null) for the bound ticket. */
  getTicket: (ticketId: TicketId) => {
    id: string;
    title: string;
    description: string;
    priority: string;
    columnId: string;
    projectId: string;
  } | null;

  /** Return the pipeline for a project. */
  getPipeline: (projectId: string) => Pipeline;

  /** Move a ticket to a column (by column id). */
  moveTicketToColumn: (ticketId: TicketId, columnId: string) => void;

  /** Escalate — pause the run and notify the human. Returns a promise that resolves once the run is stopped. */
  escalate: (ticketId: TicketId, message: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
//  ProjectMcpServer — one per ticket/sandbox
// ---------------------------------------------------------------------------

export class ProjectMcpServer {
  private mcp: McpServer;
  private httpServer: HttpServer | null = null;
  private transport: StreamableHTTPServerTransport | null = null;
  private _port: number | null = null;

  constructor(
    private ticketId: TicketId,
    private delegate: ProjectMcpDelegate
  ) {
    this.mcp = new McpServer(
      { name: 'omni-launcher', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    this.registerTools();
  }

  /** The port the HTTP server is listening on (null before start). */
  get port(): number | null {
    return this._port;
  }

  /**
   * Build the MCP endpoint URL as seen from inside a Docker container.
   * Uses host.docker.internal to reach the host-side MCP server through
   * the Docker gateway.
   */
  containerUrl(): string {
    return `http://host.docker.internal:${this._port}/mcp`;
  }

  // -----------------------------------------------------------------------
  //  Tool registration
  // -----------------------------------------------------------------------

  private registerTools(): void {
    // --- get_ticket ---
    this.mcp.tool(
      'get_ticket',
      'Get the current ticket state including title, description, priority, current column, and pipeline columns.',
      {},
      async () => {
        const ticket = this.delegate.getTicket(this.ticketId);
        if (!ticket) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Ticket not found' }) }], isError: true };
        }
        const pipeline = this.delegate.getPipeline(ticket.projectId);
        const column = pipeline.columns.find((c) => c.id === ticket.columnId);
        const result = {
          id: ticket.id,
          title: ticket.title,
          description: ticket.description || '',
          priority: ticket.priority,
          column: column?.label ?? ticket.columnId,
          pipeline: pipeline.columns.map((c) => c.label),
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
    );

    // --- move_ticket ---
    this.mcp.tool(
      'move_ticket',
      'Move this ticket to a different pipeline column. Use exact column labels from the pipeline.',
      { column: z.string().describe('The target column label (e.g. "In Progress", "Done")') },
      async ({ column: columnLabel }) => {
        const ticket = this.delegate.getTicket(this.ticketId);
        if (!ticket) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Ticket not found' }) }], isError: true };
        }
        const pipeline = this.delegate.getPipeline(ticket.projectId);
        const col = pipeline.columns.find((c) => c.label.toLowerCase() === columnLabel.toLowerCase());
        if (!col) {
          const valid = pipeline.columns.map((c) => c.label).join(', ');
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Unknown column: "${columnLabel}". Valid columns: ${valid}` }) }],
            isError: true,
          };
        }
        this.delegate.moveTicketToColumn(this.ticketId, col.id);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, column: col.label }) }] };
      }
    );

    // --- escalate ---
    this.mcp.tool(
      'escalate',
      'Pause the current run and notify the human operator. Only use when truly blocked by something outside your control.',
      { message: z.string().describe('Brief description of what you need help with') },
      async ({ message }) => {
        const ticket = this.delegate.getTicket(this.ticketId);
        if (!ticket || !message) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Ticket not found or empty message' }) }],
            isError: true,
          };
        }
        await this.delegate.escalate(this.ticketId, message);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message: 'Escalated to human operator' }) }] };
      }
    );
  }

  // -----------------------------------------------------------------------
  //  Lifecycle
  // -----------------------------------------------------------------------

  /** Start the HTTP server on a random available port. */
  async start(): Promise<number> {
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await this.mcp.connect(this.transport);

    this.httpServer = createServer(async (req, res) => {
      // Route /mcp to the MCP transport
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/mcp') {
        // Collect request body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString('utf-8');
        let parsed: unknown;
        try {
          parsed = body ? JSON.parse(body) : undefined;
        } catch {
          parsed = undefined;
        }
        await this.transport!.handleRequest(req, res, parsed);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    return new Promise<number>((resolve, reject) => {
      this.httpServer!.listen(0, '0.0.0.0', () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
          console.log(`[ProjectMcpServer] Listening on port ${this._port} for ticket ${this.ticketId}`);
          resolve(this._port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });
      this.httpServer!.on('error', reject);
    });
  }

  /** Stop the HTTP server and close the MCP transport. */
  async stop(): Promise<void> {
    try {
      await this.mcp.close();
    } catch {
      // ignore
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
    this._port = null;
    console.log(`[ProjectMcpServer] Stopped for ticket ${this.ticketId}`);
  }
}
