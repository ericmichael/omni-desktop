import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectsRepo } from 'omni-projects-db';
import { pageId, readPageContent, writePageContent } from 'omni-projects-db';
import type { PageRow } from 'omni-projects-db';
import { z } from 'zod';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

function getProjectSlug(repo: ProjectsRepo, projectId: string): string | null {
  const row = repo.getProject(projectId);
  return row?.slug ?? null;
}

export function registerPageTools(server: McpServer, db: DatabaseSync, repo: ProjectsRepo, pagesDir: string): void {
  server.tool(
    'list_pages',
    'List omni-projects documentation pages (markdown notes/specs/plans tied to a project) as a flat list with parent/child relationships. NOT for filesystem files — use list_directory / glob_files / grep_files for those.',
    { project_id: z.string().describe('The omni-projects project ID (proj_*). NOT a filesystem path.') },
    async ({ project_id }) => {
      const exists = repo.getProject(project_id);
      if (!exists) return err(`Project not found: ${project_id}`);

      const pages = repo.listPagesByProject(project_id);

      return json({
        pages: pages.map(p => ({
          id: p.id,
          title: p.title,
          icon: p.icon,
          parent_id: p.parent_id,
          sort_order: p.sort_order,
          is_root: !!p.is_root,
          kind: p.kind,
          properties: p.properties ? JSON.parse(p.properties) : null,
          created_at: p.created_at,
          updated_at: p.updated_at,
        })),
      });
    }
  );

  server.tool(
    'read_page',
    "Read an omni-projects documentation page (markdown note/spec/plan tied to a project) by its page_id (pg_*). NOT for filesystem files — use read_file with a path like AGENTS.md or src/foo.py for workspace source.",
    { page_id: z.string().describe('The omni-projects page ID (pg_*), as returned by list_pages or create_page. NOT a filesystem path.') },
    async ({ page_id }) => {
      // Path-shaped inputs (start with / or contain a /) are almost
      // always agents reaching for the wrong tool — surface the right
      // one in the error rather than a bare "not found".
      if (page_id.startsWith('/') || page_id.includes('/')) {
        return err(
          `Page not found: ${page_id}. This looks like a filesystem path. ` +
            `read_page reads omni-projects documentation pages by ID (pg_*), ` +
            `not workspace files. Use read_file for source files.`
        );
      }
      const page = repo.getPage(page_id);
      if (!page) return err(`Page not found: ${page_id}`);

      const slug = getProjectSlug(repo, page.project_id);
      const content = slug ? readPageContent(pagesDir, slug, page.id) : null;

      return json({
        id: page.id,
        title: page.title,
        icon: page.icon,
        parent_id: page.parent_id,
        is_root: !!page.is_root,
        kind: page.kind,
        properties: page.properties ? JSON.parse(page.properties) : null,
        content: content ?? '',
      });
    }
  );

  server.tool(
    'create_page',
    'Create a new omni-projects documentation page in a project (markdown note/spec/plan, organized in a tree alongside the project root). NOT for filesystem files — use write_file to create source files in the workspace.',
    {
      project_id: z.string().describe('The project to create the page in.'),
      title: z.string().describe('Page title.'),
      parent_id: z.string().optional().describe('Optional parent page ID. Omit for a root-level page.'),
      content: z.string().optional().describe('Optional markdown body content.'),
      icon: z.string().optional().describe('Optional emoji icon for sidebar display.'),
    },
    async ({ project_id, title, parent_id, content, icon }) => {
      const slug = getProjectSlug(repo, project_id);
      if (!slug) return err(`Project not found: ${project_id}`);

      const id = pageId();
      const sortOrder = Date.now();

      db.prepare(`
        INSERT INTO pages (id, project_id, parent_id, title, icon, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, project_id, parent_id ?? null, title, icon ?? null, sortOrder);
      repo.bumpChangeSeq();

      writePageContent(pagesDir, slug, id, content?.trim() ? content : `# ${title}\n`);

      return json({ id, title, parent_id: parent_id ?? null });
    }
  );

  server.tool(
    'update_page',
    "Update an omni-projects documentation page's title, content, icon, or structured properties. NOT for filesystem files — use write_file or apply_patch on workspace source.",
    {
      page_id: z.string().describe('The page ID to update.'),
      title: z.string().optional().describe('New title.'),
      content: z.string().optional().describe('New markdown body content (replaces the full body).'),
      icon: z.string().optional().describe('New emoji icon.'),
    },
    async ({ page_id, title, content, icon }) => {
      const page = repo.getPage(page_id);
      if (!page) return err(`Page not found: ${page_id}`);

      const sets: string[] = [];
      const params: unknown[] = [];

      if (title !== undefined) { sets.push('title = ?'); params.push(title); }
      if (icon !== undefined) { sets.push('icon = ?'); params.push(icon || null); }

      if (sets.length > 0) {
        sets.push("updated_at = datetime('now')");
        params.push(page_id);
        db.prepare(`UPDATE pages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        repo.bumpChangeSeq();
      }

      if (content !== undefined) {
        const slug = getProjectSlug(repo, page.project_id);
        if (slug) writePageContent(pagesDir, slug, page.id, content);
      }

      return json({ ok: true });
    }
  );
}
