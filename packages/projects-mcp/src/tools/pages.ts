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
    'List all pages in a project as a flat list with parent/child relationships.',
    { project_id: z.string().describe('The project ID to list pages for.') },
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
    "Read a page's markdown content and metadata.",
    { page_id: z.string().describe('The page ID to read.') },
    async ({ page_id }) => {
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
    'Create a new page in a project. Pages are markdown documents organized in a tree.',
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
    "Update a page's title, content, icon, or structured properties.",
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
