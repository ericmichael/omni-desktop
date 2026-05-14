import type { DatabaseSync } from 'node:sqlite';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {ProjectsRepo  } from 'omni-projects-db';
import { DEFAULT_COLUMNS, defaultColumnId, deleteProjectPages, pageId, projectId, tx, writePageContent } from 'omni-projects-db';
import { z } from 'zod';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function registerProjectTools(server: McpServer, db: DatabaseSync, repo: ProjectsRepo, pagesDir: string): void {
  server.tool(
    'list_projects',
    'List all projects with their pipeline columns.',
    {},
    async () => {
      const projects = repo.listProjects();
      const result = projects.map(p => {
        const cols = repo.listColumns(p.id);
        return {
          id: p.id,
          label: p.label,
          slug: p.slug,
          workspace_dir: p.workspace_dir,
          is_personal: !!p.is_personal,
          due_date: p.due_date,
          pinned_at: p.pinned_at,
          columns: cols.map(c => c.label),
          created_at: p.created_at,
        };
      });
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
      const id = projectId();
      const slug = slugify(label);

      if (due_date) {
        const parsed = Date.parse(due_date);
        if (Number.isNaN(parsed)) return err('Invalid due_date. Use an ISO date like 2026-04-30.');
      }

      // Check slug uniqueness
      const existing = repo.getProjectBySlug(slug);
      if (existing) {
return err(`A project with slug "${slug}" already exists.`);
}

      tx(db, () => {
        db.prepare(
          `INSERT INTO projects (id, label, slug, workspace_dir, due_date, pinned_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          label,
          slug,
          workspace_dir ?? null,
          due_date ?? null,
          pinned ? new Date().toISOString() : null
        );

        // Seed default pipeline columns with deterministic prefixed IDs
        for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
          const col = DEFAULT_COLUMNS[i]!;
          db.prepare(
            'INSERT INTO pipeline_columns (id, project_id, label, description, sort_order, gate) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(defaultColumnId(id, col.logicalId), id, col.label, null, i, col.gate ? 1 : 0);
        }

        // Seed root page
        const rootId = pageId();
        db.prepare(
          'INSERT INTO pages (id, project_id, parent_id, title, sort_order, is_root) VALUES (?, ?, NULL, ?, 0, 1)'
        ).run(rootId, id, label);
        writePageContent(pagesDir, id, rootId, `# ${label}\n`);

        repo.bumpChangeSeq();
      });

      const cols = repo.listColumns(id);
      const rootPage = db.prepare(
        'SELECT id FROM pages WHERE project_id = ? AND is_root = 1'
      ).get(id) as { id: string } | undefined;

      return json({
        id,
        label,
        slug,
        workspace_dir: workspace_dir ?? null,
        pipeline: cols.map(c => c.label),
        root_page_id: rootPage?.id ?? null,
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
      const project = repo.getProject(project_id);
      if (!project) {
return err(`Project not found: ${project_id}`);
}

      const sets: string[] = [];
      const params: unknown[] = [];

      if (label !== undefined) {
        const slug = slugify(label);
        // Reject the rename if another project already owns this slug. Matches
        // the create_project uniqueness check above — surfaces a clean error
        // to the agent instead of letting the schema's UNIQUE constraint throw
        // a raw SQLITE_CONSTRAINT mid-update.
        const collision = repo.getProjectBySlug(slug);
        if (collision && collision.id !== project_id) {
          return err(`A project with slug "${slug}" already exists.`);
        }
        sets.push('label = ?', 'slug = ?');
        params.push(label, slug);
      }
      if (workspace_dir !== undefined) {
        sets.push('workspace_dir = ?');
        params.push(workspace_dir || null);
      }
      if (due_date !== undefined) {
        if (due_date === '') {
          sets.push('due_date = NULL');
        } else {
          const parsed = Date.parse(due_date);
          if (Number.isNaN(parsed)) return err('Invalid due_date. Use an ISO date like 2026-04-30.');
          sets.push('due_date = ?');
          params.push(due_date);
        }
      }
      if (pinned !== undefined) {
        if (pinned) {
          sets.push("pinned_at = datetime('now')");
        } else {
          sets.push('pinned_at = NULL');
        }
      }

      if (sets.length === 0) {
return json({ ok: true });
}

      sets.push("updated_at = datetime('now')");
      params.push(project_id);
      db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      repo.bumpChangeSeq();

      return json({ ok: true });
    }
  );

  server.tool(
    'delete_project',
    'Delete a project and all its tickets, pages, and milestones. Cannot delete the Personal project.',
    { project_id: z.string().describe('The project ID to delete') },
    async ({ project_id }) => {
      const project = repo.getProject(project_id);
      if (!project) {
return err(`Project not found: ${project_id}`);
}
      if (project.is_personal) {
return err('Cannot delete the Personal project');
}

      repo.deleteProject(project_id);
      deleteProjectPages(pagesDir, project_id);

      return json({ ok: true });
    }
  );
}
