/**
 * Project seeding shared by `create_project` and `inbox_to_project`.
 *
 * Backend-agnostic: everything goes through {@link IProjectsRepo}, so the
 * same code seeds a local SQLite project (stdio mode) or a tenant-scoped
 * Postgres project (HTTP mode). Mirrors the default-column + root-page setup
 * the launcher's ProjectManager performs.
 */
import {
  DEFAULT_COLUMNS,
  defaultColumnId,
  type IProjectsRepo,
  nowTimestamp,
  pageId,
  projectId,
  type ProjectRow,
} from 'omni-projects-db';

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface SeededProject {
  id: string;
  label: string;
  slug: string;
  rootPageId: string;
  columns: string[];
}

/**
 * Create a project row, its default pipeline columns, and a root page (with
 * `# <label>` content). Caller must have already checked slug uniqueness.
 */
export async function seedProject(
  repo: IProjectsRepo,
  opts: { label: string; workspaceDir?: string | null; dueDate?: string | null; pinned?: boolean }
): Promise<SeededProject> {
  const id = projectId();
  const slug = slugify(opts.label);
  const now = nowTimestamp();

  const project: ProjectRow = {
    id,
    label: opts.label,
    slug,
    workspace_dir: opts.workspaceDir ?? null,
    is_personal: 0,
    auto_dispatch: 0,
    sources: '[]',
    sandbox_profile: null,
    config: null,
    due_date: opts.dueDate ?? null,
    pinned_at: opts.pinned ? now : null,
    created_at: now,
    updated_at: now,
  };
  await repo.upsertProject(project);

  const columns = DEFAULT_COLUMNS.map((col, i) => ({
    id: defaultColumnId(id, col.logicalId),
    project_id: id,
    label: col.label,
    description: null,
    sort_order: i,
    gate: col.gate ? 1 : 0,
  }));
  await repo.replaceColumnsForProject(id, columns);

  const rootPageId = pageId();
  await repo.upsertPage({
    id: rootPageId,
    project_id: id,
    parent_id: null,
    title: opts.label,
    icon: null,
    sort_order: 0,
    is_root: 1,
    kind: 'doc',
    properties: null,
    created_at: now,
    updated_at: now,
  });
  await repo.setPageContent(rootPageId, `# ${opts.label}\n`);

  return { id, label: opts.label, slug, rootPageId, columns: columns.map((c) => c.label) };
}
