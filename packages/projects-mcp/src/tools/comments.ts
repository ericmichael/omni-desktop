import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { commentId, type IProjectsRepo, nowTimestamp } from 'omni-projects-db';
import { z } from 'zod';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

export function registerCommentTools(server: McpServer, repo: IProjectsRepo): void {
  server.tool(
    'add_ticket_comment',
    'Add a comment to a ticket. Use this to record decisions, findings, progress, blockers, or anything useful for future runs.',
    {
      ticket_id: z.string().describe('The ticket ID to comment on.'),
      content: z.string().describe('The comment content (markdown supported).'),
      author: z.enum(['agent', 'human']).optional().describe('Comment author (default: human).'),
    },
    async ({ ticket_id, content, author }) => {
      const exists = await repo.getTicket(ticket_id);
      if (!exists) return err(`Ticket not found: ${ticket_id}`);

      const id = commentId();
      await repo.upsertComment({
        id,
        ticket_id,
        author: author ?? 'human',
        content,
        created_at: nowTimestamp(),
      });

      return json({ ok: true, comment_id: id });
    }
  );

  server.tool(
    'get_ticket_comments',
    'Read comments on a ticket. Returns the comment history — decisions, findings, progress notes, and blockers.',
    { ticket_id: z.string().describe('The ticket ID to read comments for.') },
    async ({ ticket_id }) => {
      const exists = await repo.getTicket(ticket_id);
      if (!exists) return err(`Ticket not found: ${ticket_id}`);

      const comments = await repo.listCommentsByTicket(ticket_id);

      return json({
        comments: comments.map((c) => ({
          id: c.id,
          author: c.author,
          content: c.content,
          created_at: c.created_at,
        })),
      });
    }
  );
}
