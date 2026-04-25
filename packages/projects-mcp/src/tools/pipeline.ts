import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectsRepo } from 'omni-projects-db';
import { z } from 'zod';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

export function registerPipelineTools(server: McpServer, db: DatabaseSync, repo: ProjectsRepo): void {
  server.tool(
    'get_pipeline',
    'Get the full pipeline definition for a project — columns with labels, descriptions, and gate status.',
    { project_id: z.string().describe('The project ID to get the pipeline for.') },
    async ({ project_id }) => {
      const cols = repo.listColumns(project_id);

      if (cols.length === 0) {
        const exists = repo.getProject(project_id);
        if (!exists) return err(`Project not found: ${project_id}`);
      }

      return json({
        columns: cols.map(c => ({
          id: c.id,
          label: c.label,
          description: c.description,
          gate: !!c.gate,
        })),
      });
    }
  );
}
