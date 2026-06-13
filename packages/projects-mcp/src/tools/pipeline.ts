import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IProjectsRepo } from 'omni-projects-db';
import { z } from 'zod';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

const parseWorkflow = (raw: string | null): unknown | undefined => {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const workflowSchema = z
  .object({
    purpose: z.string().optional(),
    entryCriteria: z.array(z.string()).optional(),
    definitionOfDone: z.array(z.string()).optional(),
    agentInstructions: z.string().optional(),
    recommendedSkills: z.array(z.string()).optional(),
    allowedTransitions: z.array(z.string()).optional(),
    autoDispatch: z.boolean().optional(),
  })
  .passthrough();

const columnSchema = z.object({
  id: z.string().optional().describe('Stable logical column ID. If omitted, derived from the label.'),
  label: z.string().describe('Column label.'),
  description: z.string().optional().describe('Column description.'),
  gate: z.boolean().optional().describe('Whether this column is a human-review gate.'),
  maxConcurrent: z.number().int().positive().optional().describe('Maximum concurrent work items for this column.'),
  workflow: workflowSchema.optional().describe('Workflow contract for agents and humans.'),
});

function logicalIdFor(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'column';
}

export function registerPipelineTools(server: McpServer, repo: IProjectsRepo): void {
  server.tool(
    'get_pipeline',
    'Get the full pipeline definition for a project — columns with labels, descriptions, workflow contracts, max concurrency, and gate status.',
    { project_id: z.string().describe('The project ID to get the pipeline for.') },
    async ({ project_id }) => {
      const cols = await repo.listColumns(project_id);

      if (cols.length === 0) {
        const exists = await repo.getProject(project_id);
        if (!exists) {
          return err(`Project not found: ${project_id}`);
        }
      }

      return json({
        columns: cols.map((c) => ({
          id: c.id,
          label: c.label,
          description: c.description,
          gate: !!c.gate,
          maxConcurrent: c.max_concurrent ?? undefined,
          workflow: parseWorkflow(c.workflow),
        })),
      });
    }
  );

  server.tool(
    'update_pipeline',
    'Replace the pipeline definition for a project. Remaps tickets safely when columns are removed.',
    {
      project_id: z.string().describe('The project ID to update the pipeline for.'),
      columns: z.array(columnSchema).min(1).describe('Ordered pipeline column definitions.'),
    },
    async ({ project_id, columns }) => {
      const exists = await repo.getProject(project_id);
      if (!exists) return err(`Project not found: ${project_id}`);

      const labels = new Set<string>();
      const logicalIds = new Set<string>();
      for (const column of columns) {
        const labelKey = column.label.toLowerCase();
        if (labels.has(labelKey)) return err(`Duplicate column label: ${column.label}`);
        labels.add(labelKey);
        const logicalId = column.id ?? logicalIdFor(column.label);
        if (logicalIds.has(logicalId)) return err(`Duplicate column id: ${logicalId}`);
        logicalIds.add(logicalId);
      }

      const result = await repo.syncColumnsForProject(
        project_id,
        columns.map((column) => ({
          logicalId: column.id ?? logicalIdFor(column.label),
          label: column.label,
          description: column.description ?? null,
          gate: column.gate ?? false,
          maxConcurrent: column.maxConcurrent ?? null,
          workflow: column.workflow,
        }))
      );

      return json({ ok: true, ...result });
    }
  );
}
