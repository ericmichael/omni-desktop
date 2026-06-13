import { randomBytes } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type IProjectsRepo, nowTimestamp } from 'omni-projects-db';
import { z } from 'zod';

import { type ProjectSource, seedProject, slugify } from '../seed.js';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const });

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    id: z.string().optional(),
    mountName: z.string(),
    workspaceDir: z.string(),
    gitDetected: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('git-remote'),
    id: z.string().optional(),
    mountName: z.string(),
    repoUrl: z.string(),
    defaultBranch: z.string().optional(),
  }),
]);

function normalizeSources(sources: z.infer<typeof sourceSchema>[] | undefined): ProjectSource[] {
  return (sources ?? []).map((source) => ({ ...source, id: source.id ?? randomBytes(8).toString('hex') }));
}

const trimTrailingSlashes = (value: string): string => value.replace(/[\\/]+$/, '');

function normalizeLocalSourcePath(workspaceDir: string): string {
  const normalized = trimTrailingSlashes(workspaceDir.trim().replace(/\\+/g, '/'));
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function normalizeGitRemoteUrl(repoUrl: string): string {
  const trimmed = trimTrailingSlashes(repoUrl.trim()).replace(/\.git$/i, '');
  const scpLike = trimmed.match(/^([^@\s]+)@([^:\s]+):(.+)$/);
  const parseTarget = scpLike ? `ssh://${scpLike[1]}@${scpLike[2]}/${scpLike[3]}` : trimmed;

  try {
    const parsed = new URL(parseTarget);
    const host = parsed.hostname.toLowerCase();
    const pathname = trimTrailingSlashes(decodeURIComponent(parsed.pathname)).replace(/^\/+/, '').replace(/\.git$/i, '');
    return `${host}/${pathname.toLowerCase()}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function sourceIdentityKey(source: ProjectSource): string {
  return source.kind === 'local'
    ? `local:${normalizeLocalSourcePath(source.workspaceDir)}`
    : `git-remote:${normalizeGitRemoteUrl(source.repoUrl)}`;
}

function validateSources(sources: ProjectSource[]): string | null {
  const mountNames = new Set<string>();
  const identities = new Set<string>();
  for (const source of sources) {
    if (mountNames.has(source.mountName)) return `Duplicate mount name: "${source.mountName}". Each source needs a unique name.`;
    mountNames.add(source.mountName);
    const identity = sourceIdentityKey(source);
    if (identities.has(identity)) {
      return source.kind === 'local' ? 'This project already includes that local folder.' : 'This project already includes that repository.';
    }
    identities.add(identity);
  }
  return null;
}

function parseSources(raw: string): ProjectSource[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as ProjectSource[]) : [];
}

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
            sources: parseSources(p.sources),
            is_personal: !!p.is_personal,
            auto_dispatch: !!p.auto_dispatch,
            sandbox_profile: p.sandbox_profile,
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
    'Create a new project. Optionally attach local or git-remote sources.',
    {
      label: z.string().describe('Human-readable project name'),
      sources: z.array(sourceSchema).optional().describe('Sources to attach to the project.'),
      auto_dispatch: z.boolean().optional().describe('Enable automatic dispatch for ready tickets.'),
      sandbox_profile: z.string().optional().describe('Per-project sandbox profile name. Omit or pass empty string to inherit the default.'),
      due_date: z.string().optional().describe('Optional due date in ISO format (e.g. 2026-04-30).'),
      pinned: z.boolean().optional().describe('Pin the project to Home on creation.'),
    },
    async ({ label, sources, auto_dispatch, sandbox_profile, due_date, pinned }) => {
      if (due_date) {
        const parsed = Date.parse(due_date);
        if (Number.isNaN(parsed)) return err('Invalid due_date. Use an ISO date like 2026-04-30.');
      }

      const slug = slugify(label);
      const existing = await repo.getProjectBySlug(slug);
      if (existing) return err(`A project with slug "${slug}" already exists.`);

      const normalizedSources = normalizeSources(sources);
      const sourceError = validateSources(normalizedSources);
      if (sourceError) return err(sourceError);

      const seeded = await seedProject(repo, {
        label,
        sources: normalizedSources,
        autoDispatch: auto_dispatch ?? false,
        sandboxProfile: sandbox_profile || null,
        dueDate: due_date ?? null,
        pinned: pinned ?? false,
      });

      return json({
        id: seeded.id,
        label: seeded.label,
        slug: seeded.slug,
        sources: normalizedSources,
        auto_dispatch: auto_dispatch ?? false,
        sandbox_profile: sandbox_profile || null,
        pipeline: seeded.columns,
        root_page_id: seeded.rootPageId,
      });
    }
  );

  server.tool(
    'update_project',
    "Update a project's label, sources, auto-dispatch, sandbox profile, deadline, or pin state.",
    {
      project_id: z.string().describe('The project ID to update'),
      label: z.string().optional().describe('New project name'),
      sources: z.array(sourceSchema).optional().describe('Replace the project source list.'),
      auto_dispatch: z.boolean().optional().describe('Enable or disable automatic dispatch for ready tickets.'),
      sandbox_profile: z.string().optional().describe('Per-project sandbox profile name. Pass empty string to inherit the default.'),
      due_date: z.string().optional().describe('Due date in ISO format. Pass empty string to clear.'),
      pinned: z.boolean().optional().describe('true pins the project to Home, false unpins it.'),
    },
    async ({ project_id, label, sources, auto_dispatch, sandbox_profile, due_date, pinned }) => {
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
      if (sources !== undefined) {
        const normalizedSources = normalizeSources(sources);
        const sourceError = validateSources(normalizedSources);
        if (sourceError) return err(sourceError);
        next.sources = JSON.stringify(normalizedSources);
      }
      if (auto_dispatch !== undefined) {
        next.auto_dispatch = auto_dispatch ? 1 : 0;
      }
      if (sandbox_profile !== undefined) {
        next.sandbox_profile = sandbox_profile || null;
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
