import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectsRepo } from 'omni-projects-db';
import { DEFAULT_COLUMNS, columnId, deleteProjectPages, pageId, projectId, tx, writePageContent } from 'omni-projects-db';
import type { ProjectRow, ColumnRow } from 'omni-projects-db';
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
    },
    async ({ label, workspace_dir }) => {
      const id = projectId();
      const slug = slugify(label);

      // Check slug uniqueness
      const existing = repo.getProjectBySlug(slug);
      if (existing) return err(`A project with slug "${slug}" already exists.`);

      tx(db, () => {
        db.prepare(
          'INSERT INTO projects (id, label, slug, workspace_dir) VALUES (?, ?, ?, ?)'
        ).run(id, label, slug, workspace_dir ?? null);

        // Seed default pipeline columns
        for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
          const col = DEFAULT_COLUMNS[i]!;
          db.prepare(
            'INSERT INTO pipeline_columns (id, project_id, label, description, sort_order, gate) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(columnId(), id, col.label, col.description, i, col.gate ? 1 : 0);
        }

        // Seed root page
        const rootId = pageId();
        db.prepare(
          'INSERT INTO pages (id, project_id, parent_id, title, sort_order, is_root) VALUES (?, ?, NULL, ?, 0, 1)'
        ).run(rootId, id, label);
        writePageContent(pagesDir, slug, rootId, `# ${label}\n`);

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
    "Update a project's label or linked workspace directory.",
    {
      project_id: z.string().describe('The project ID to update'),
      label: z.string().optional().describe('New project name'),
      workspace_dir: z.string().optional().describe('Set the linked local directory. Pass empty string to unlink.'),
    },
    async ({ project_id, label, workspace_dir }) => {
      const project = repo.getProject(project_id);
      if (!project) return err(`Project not found: ${project_id}`);

      const sets: string[] = [];
      const params: unknown[] = [];

      if (label !== undefined) {
        const slug = slugify(label);
        sets.push('label = ?', 'slug = ?');
        params.push(label, slug);
      }
      if (workspace_dir !== undefined) {
        sets.push('workspace_dir = ?');
        params.push(workspace_dir || null);
      }

      if (sets.length === 0) return json({ ok: true });

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
      if (!project) return err(`Project not found: ${project_id}`);
      if (project.is_personal) return err('Cannot delete the Personal project');

      repo.deleteProject(project_id);
      deleteProjectPages(pagesDir, project.slug);

      return json({ ok: true });
    }
  );
}
