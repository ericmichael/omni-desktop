import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type IProjectsRepo, nowTimestamp } from 'omni-projects-db';
import { z } from 'zod';

import type { ProjectsMcpContext } from '../server.js';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

/**
 * Team handbook — the roster's ONE shared rules document (handbook-first:
 * the launcher renders the body into every agent's identity instructions on
 * every wake, so an update here reaches the whole team without any
 * announcement). Edits are stamped with the calling principal.
 */
export function registerHandbookTools(server: McpServer, repo: IProjectsRepo, context: ProjectsMcpContext = {}): void {
  server.tool(
    'read_handbook',
    'Read the team handbook — the shared rules document every agent receives on wake.',
    {},
    async () => {
      const row = await repo.getTeamHandbook();
      return json({ body: row?.body ?? '', updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null });
    }
  );

  server.tool(
    'update_handbook',
    'Replace the team handbook body. It reaches every agent on their next wake — no announcement needed. ' +
      'Keep it ONE page of standing rules; project-specific knowledge belongs in that project instead.',
    {
      body: z.string().describe('The full new handbook body (markdown). Replaces the current document.'),
    },
    async ({ body }) => {
      const principal = context.getCurrentPrincipal ? await context.getCurrentPrincipal() : null;
      await repo.setTeamHandbook(body, principal, nowTimestamp());
      return json({ ok: true });
    }
  );
}
