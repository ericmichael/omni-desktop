import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type IProjectsRepo, nowTimestamp } from 'omni-projects-db';
import { z } from 'zod';

import { seedProject, slugify } from '../seed.js';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

export function registerProjectTools(server: McpServer, repo: IProjectsRepo): void {
  server.tool(
    'list_projects',
    'List all projects with their pipeline columns.',
    {},
    async () => {
      const projects = await repo.listProjects();
      const result = await Promise.all(
        projects.map(async (p) => {
          const cols = await repo.listColumns(p.id);
          return {
            id: p.id,
            label: p.label,
            slug: p.slug,
            workspace_dir: p.workspace_dir,
            is_personal: !!p.is_personal,
            due_date: p.due_date,
            pinned_at: p.pinned_at,
            columns: cols.map((c) => c.label),
            created_at: p.created_at,
          };
        })
      );
      return json({ projects: result });
    }
  );

  server.tool(
    'create_project',
    'Create a new project. Optionally link a local directory as the workspace.',
    {
      label: z.string().describe('Human-readable project name'),
      workspace_dir: z.string().optional().describe('Local directory to link as the project workspace.'),
      due_date: z.string().optional().describe('Optional due date in ISO format (e.g. 2026-04-30).'),
      pinned: z.boolean().optional().describe('Pin the project to Home on creation.'),
    },
    async ({ label, workspace_dir, due_date, pinned }) => {
      if (due_date) {
        const parsed = Date.parse(due_date);
        if (Number.isNaN(parsed)) return err('Invalid due_date. Use an ISO date like 2026-04-30.');
      }

      const slug = slugify(label);
      const existing = await repo.getProjectBySlug(slug);
      if (existing) return err(`A project with slug "${slug}" already exists.`);

      const seeded = await seedProject(repo, {
        label,
        workspaceDir: workspace_dir ?? null,
        dueDate: due_date ?? null,
        pinned: pinned ?? false,
      });

      return json({
        id: seeded.id,
        label: seeded.label,
        slug: seeded.slug,
        workspace_dir: workspace_dir ?? null,
        pipeline: seeded.columns,
        root_page_id: seeded.rootPageId,
      });
    }
  );

  server.tool(
    'update_project',
    "Update a project's label, linked workspace, deadline, or pin state.",
    {
      project_id: z.string().describe('The project ID to update'),
      label: z.string().optional().describe('New project name'),
      workspace_dir: z.string().optional().describe('Set the linked local directory. Pass empty string to unlink.'),
      due_date: z.string().optional().describe('Due date in ISO format. Pass empty string to clear.'),
      pinned: z.boolean().optional().describe('true pins the project to Home, false unpins it.'),
    },
    async ({ project_id, label, workspace_dir, due_date, pinned }) => {
      const project = await repo.getProject(project_id);
      if (!project) return err(`Project not found: ${project_id}`);

      const next = { ...project };

      if (label !== undefined) {
        const slug = slugify(label);
        // Reject the rename if another project already owns this slug — matches
        // create_project, surfacing a clean error instead of a UNIQUE violation.
        const collision = await repo.getProjectBySlug(slug);
        if (collision && collision.id !== project_id) {
          return err(`A project with slug "${slug}" already exists.`);
        }
        next.label = label;
        next.slug = slug;
      }
      if (workspace_dir !== undefined) {
        next.workspace_dir = workspace_dir || null;
      }
      if (due_date !== undefined) {
        if (due_date === '') {
          next.due_date = null;
        } else {
          const parsed = Date.parse(due_date);
          if (Number.isNaN(parsed)) return err('Invalid due_date. Use an ISO date like 2026-04-30.');
          next.due_date = due_date;
        }
      }
      if (pinned !== undefined) {
        next.pinned_at = pinned ? nowTimestamp() : null;
      }

      next.updated_at = nowTimestamp();
      await repo.upsertProject(next);

      return json({ ok: true });
    }
  );

  server.tool(
    'delete_project',
    'Delete a project and all its tickets, pages, and milestones. Cannot delete the Personal project.',
    { project_id: z.string().describe('The project ID to delete') },
    async ({ project_id }) => {
      const project = await repo.getProject(project_id);
      if (!project) return err(`Project not found: ${project_id}`);
      if (project.is_personal) return err('Cannot delete the Personal project');

      // Pages, columns, tickets, and page content all cascade in both backends.
      await repo.deleteProject(project_id);

      return json({ ok: true });
    }
  );
}
