/**
 * File-backed project data: schemas, parsers, and serializers.
 *
 * In the file-based model each entity lives as a markdown file with YAML
 * frontmatter for structured metadata and the body for human-written content.
 * Comments and runs are append-only JSONL sidecars. Project configuration is a
 * standalone `.omni/project.yml` with full YAML (nested pipeline, source).
 *
 * Timestamps are ISO 8601 strings on disk and numbers (ms since epoch) in
 * memory. All parsers take the id from the caller (derived from the filename)
 * rather than trusting the file contents, so a rename cannot silently collide.
 *
 * These functions are pure — no I/O. The watcher layer owns reading/writing
 * files and can surface any `Err` from here as a UI toast with the file path.
 */

import yaml from 'yaml';
import { z } from 'zod';

import { Err, Ok } from '@/lib/result';
import type { TicketPhase } from '@/shared/ticket-phase';
import type {
  Milestone,
  MilestoneId,
  Page,
  PageId,
  Pipeline,
  Project,
  ProjectId,
  ProjectSource,
  SandboxConfig,
  ShapingData,
  Ticket,
  TicketComment,
  TicketId,
  TicketRun,
  TokenUsage,
} from '@/shared/types';

// ---------------------------------------------------------------------------
// Constants shared by parsers and tests
// ---------------------------------------------------------------------------

const FRONTMATTER_FENCE = '---';

const TICKET_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
const TICKET_RESOLUTIONS = ['completed', 'wont_do', 'duplicate', 'cancelled'] as const;
const MILESTONE_STATUSES = ['active', 'completed', 'archived'] as const;
const APPETITES = ['small', 'medium', 'large'] as const;
const TICKET_PHASES = [
  'idle',
  'provisioning',
  'connecting',
  'session_creating',
  'ready',
  'running',
  'continuing',
  'awaiting_input',
  'retrying',
  'error',
  'completed',
] as const satisfies readonly TicketPhase[];

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/** Parse an ISO 8601 string to a ms-since-epoch number. Throws on invalid. */
const isoToMs = (iso: string): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
throw new Error(`invalid ISO timestamp: ${iso}`);
}
  return t;
};

/** Serialize a ms-since-epoch number to an ISO 8601 string (UTC, no ms). */
const msToIso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Zod schema for a timestamp that accepts either an ISO string or a number.
 * Outputs a number (ms). Numbers are accepted so we can roundtrip legacy
 * records during migration without an explicit conversion step.
 */
const Timestamp = z.union([z.string(), z.number()]).transform((v, ctx) => {
  if (typeof v === 'number') {
return v;
}
  try {
    return isoToMs(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});

// ---------------------------------------------------------------------------
// Frontmatter split/join (pure string operations)
// ---------------------------------------------------------------------------

/**
 * Split a markdown file with optional YAML frontmatter into `{ meta, body }`.
 * If the file does not begin with `---`, `meta` is null and the entire text
 * is treated as body. Trailing newline between body and end-of-file is
 * preserved so roundtrips are byte-identical.
 */
export function splitFrontmatter(text: string): { meta: string | null; body: string } {
  if (!text.startsWith(FRONTMATTER_FENCE)) {
    return { meta: null, body: text };
  }
  const rest = text.slice(FRONTMATTER_FENCE.length);
  // Opening fence must be followed by a newline; otherwise this is just a
  // markdown file that happens to start with three dashes.
  if (!rest.startsWith('\n') && !rest.startsWith('\r\n')) {
    return { meta: null, body: text };
  }
  const afterOpen = rest.replace(/^\r?\n/, '');
  // Empty frontmatter: close fence sits immediately after the open fence.
  if (afterOpen.startsWith(FRONTMATTER_FENCE)) {
    const afterClose = afterOpen.slice(FRONTMATTER_FENCE.length);
    return { meta: '', body: afterClose.replace(/^\r?\n/, '') };
  }
  // General case: close fence at the start of a subsequent line.
  const closeMatch = afterOpen.match(/\r?\n---\r?\n/);
  if (!closeMatch || closeMatch.index === undefined) {
    return { meta: null, body: text };
  }
  const meta = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return { meta, body };
}

/**
 * Join a meta object and a markdown body into a frontmatter-prefixed file.
 * Empty meta is serialized as an empty frontmatter block so that the presence
 * or absence of frontmatter is explicit. Body is written verbatim; caller is
 * responsible for newline discipline inside the body.
 */
export function joinFrontmatter(meta: Record<string, unknown>, body: string): string {
  const yamlText = yaml.stringify(meta, { lineWidth: 0 }).trimEnd();
  return `${FRONTMATTER_FENCE}\n${yamlText}\n${FRONTMATTER_FENCE}\n${body}`;
}

/**
 * Parse raw frontmatter YAML. Returns `{}` if the YAML is empty or null;
 * returns an `Err` if it does not parse or is not a plain object.
 */
export function parseFrontmatterYaml(text: string | null): Ok<Record<string, unknown>> | Err<Error> {
  if (text === null || text.trim() === '') {
return new Ok({});
}
  let parsed: unknown;
  try {
    parsed = yaml.parse(text);
  } catch (e) {
    return new Err(new Error(`frontmatter YAML parse failed: ${(e as Error).message}`));
  }
  if (parsed === null || parsed === undefined) {
return new Ok({});
}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new Err(new Error(`frontmatter must be a YAML mapping, got ${typeof parsed}`));
  }
  return new Ok(parsed as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Schemas — the runtime shapes below deliberately mirror `src/shared/types.ts`
// so that the watcher can pass parsed entities straight into the existing
// nanostores without an extra conversion step.
// ---------------------------------------------------------------------------

const TokenUsageSchema: z.ZodType<TokenUsage> = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});

const ShapingSchema: z.ZodType<ShapingData> = z.object({
  doneLooksLike: z.string(),
  appetite: z.enum(APPETITES),
  outOfScope: z.string(),
});

const ColumnSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  maxConcurrent: z.number().int().positive().optional(),
  gate: z.boolean().optional(),
});

const PipelineSchema: z.ZodType<Pipeline> = z.object({
  columns: z.array(ColumnSchema),
});

const SandboxConfigSchema: z.ZodType<SandboxConfig> = z.object({
  image: z.string().optional(),
  dockerfile: z.string().optional(),
});

const ProjectSourceSchema: z.ZodType<ProjectSource> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    workspaceDir: z.string(),
    gitDetected: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('git-remote'),
    repoUrl: z.string(),
    defaultBranch: z.string().optional(),
    credentials: z.object({ kind: z.literal('platform-managed'), credentialId: z.string() }).optional(),
  }),
]);

/** Frontmatter schema for a ticket file. Body holds the description. */
const TicketMetaSchema = z.object({
  title: z.string(),
  priority: z.enum(TICKET_PRIORITIES),
  column: z.string(),
  milestone: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
  branch: z.string().optional(),
  useWorktree: z.boolean().optional(),
  worktreePath: z.string().optional(),
  worktreeName: z.string().optional(),
  phase: z.enum(TICKET_PHASES).optional(),
  resolution: z.enum(TICKET_RESOLUTIONS).optional(),
  autopilot: z.boolean().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  shaping: ShapingSchema.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

/** Frontmatter schema for a milestone file. Body holds the brief. */
const MilestoneMetaSchema = z.object({
  title: z.string(),
  description: z.string(),
  status: z.enum(MILESTONE_STATUSES),
  branch: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

const PagePropertiesSchema = z
  .object({
    status: z.string().optional(),
    size: z.string().optional(),
    projectId: z.string().optional(),
    milestoneId: z.string().optional(),
    outcome: z.string().optional(),
    notDoing: z.string().optional(),
    laterAt: z.number().optional(),
  })
  .optional();

/** Frontmatter schema for a page file. Body holds the page content. */
const PageMetaSchema = z.object({
  title: z.string(),
  parentId: z.string().nullable().optional(),
  icon: z.string().optional(),
  sortOrder: z.number(),
  isRoot: z.boolean().optional(),
  properties: PagePropertiesSchema,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

/** Schema for `.omni/project.yml`. */
const ProjectConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  slug: z.string(),
  isPersonal: z.boolean().optional(),
  source: ProjectSourceSchema.optional(),
  pipeline: PipelineSchema.optional(),
  sandbox: SandboxConfigSchema.nullable().optional(),
  autoDispatch: z.boolean().optional(),
  createdAt: Timestamp,
});

/** One line of `<id>.comments.jsonl`. */
const TicketCommentLineSchema: z.ZodType<TicketComment> = z.object({
  id: z.string(),
  author: z.enum(['agent', 'human']),
  content: z.string(),
  createdAt: Timestamp,
});

/** One line of `<id>.runs.jsonl`. */
const TicketRunLineSchema: z.ZodType<TicketRun> = z.object({
  id: z.string(),
  startedAt: Timestamp,
  endedAt: Timestamp,
  endReason: z.string(),
  tokenUsage: TokenUsageSchema.optional(),
});

// ---------------------------------------------------------------------------
// Parse functions — text + context in, runtime entity out
// ---------------------------------------------------------------------------

/** A parse error carrying an optional field path for richer UI surfacing. */
export class ProjectFileError extends Error {
  readonly path: string | undefined;
  constructor(message: string, path?: string) {
    super(message);
    this.name = 'ProjectFileError';
    this.path = path;
  }
}

const fail = (message: string, path?: string) => new Err(new ProjectFileError(message, path));

const parseWith = <T>(
  schema: z.ZodType<T>,
  meta: Record<string, unknown>
): Ok<T> | Err<ProjectFileError> => {
  const result = schema.safeParse(meta);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join('.') || undefined;
    return fail(issue?.message ?? 'schema validation failed', path);
  }
  return new Ok(result.data);
};

/**
 * Parse a ticket file. Comments and runs come from sidecar JSONL and are
 * populated as empty arrays here — the caller merges them separately.
 */
export function parseTicketFile(
  text: string,
  id: TicketId,
  projectId: ProjectId
): Ok<Ticket> | Err<ProjectFileError> {
  const { meta, body } = splitFrontmatter(text);
  const yamlResult = parseFrontmatterYaml(meta);
  if (yamlResult.isErr()) {
return fail(yamlResult.error.message);
}
  const parsed = parseWith(TicketMetaSchema, yamlResult.value);
  if (parsed.isErr()) {
return parsed;
}
  const m = parsed.value;
  return new Ok({
    id,
    projectId,
    milestoneId: m.milestone as MilestoneId | undefined,
    title: m.title,
    description: body.replace(/^\n+/, '').replace(/\n+$/, ''),
    priority: m.priority,
    blockedBy: (m.blockedBy ?? []) as TicketId[],
    columnId: m.column,
    branch: m.branch,
    useWorktree: m.useWorktree,
    worktreePath: m.worktreePath,
    worktreeName: m.worktreeName,
    phase: m.phase,
    resolution: m.resolution,
    autopilot: m.autopilot,
    tokenUsage: m.tokenUsage,
    shaping: m.shaping,
    comments: [],
    runs: [],
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  });
}

export function parseMilestoneFile(
  text: string,
  id: MilestoneId,
  projectId: ProjectId
): Ok<Milestone> | Err<ProjectFileError> {
  const { meta, body } = splitFrontmatter(text);
  const yamlResult = parseFrontmatterYaml(meta);
  if (yamlResult.isErr()) {
return fail(yamlResult.error.message);
}
  const parsed = parseWith(MilestoneMetaSchema, yamlResult.value);
  if (parsed.isErr()) {
return parsed;
}
  const m = parsed.value;
  const brief = body.replace(/^\n+/, '').replace(/\n+$/, '');
  return new Ok({
    id,
    projectId,
    title: m.title,
    description: m.description,
    status: m.status,
    branch: m.branch,
    brief: brief.length > 0 ? brief : undefined,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  });
}

export function parsePageFile(
  text: string,
  id: PageId,
  projectId: ProjectId
): Ok<{ page: Page; body: string }> | Err<ProjectFileError> {
  const { meta, body } = splitFrontmatter(text);
  const yamlResult = parseFrontmatterYaml(meta);
  if (yamlResult.isErr()) {
return fail(yamlResult.error.message);
}
  const parsed = parseWith(PageMetaSchema, yamlResult.value);
  if (parsed.isErr()) {
return parsed;
}
  const m = parsed.value;
  // Only include properties if defined and has at least one non-undefined value.
  const rawProps = m.properties;
  const hasProps =
    rawProps !== undefined &&
    Object.values(rawProps).some((v) => v !== undefined);
  const page: Page = {
    id,
    projectId,
    parentId: (m.parentId ?? null) as PageId | null,
    title: m.title,
    icon: m.icon,
    sortOrder: m.sortOrder,
    isRoot: m.isRoot,
    ...(hasProps ? { properties: rawProps } : {}),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
  return new Ok({ page, body });
}

export function parseProjectConfig(text: string): Ok<Project> | Err<ProjectFileError> {
  let raw: unknown;
  try {
    raw = yaml.parse(text);
  } catch (e) {
    return fail(`project.yml YAML parse failed: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('project.yml must be a YAML mapping');
  }
  const parsed = parseWith(ProjectConfigSchema, raw as Record<string, unknown>);
  if (parsed.isErr()) {
return parsed;
}
  const c = parsed.value;
  return new Ok({
    id: c.id as ProjectId,
    label: c.label,
    slug: c.slug,
    isPersonal: c.isPersonal,
    source: c.source,
    pipeline: c.pipeline,
    sandbox: c.sandbox,
    autoDispatch: c.autoDispatch,
    createdAt: c.createdAt,
  });
}

/**
 * Parse a JSONL stream. Returns all successfully-parsed lines and collects
 * the line numbers + error messages for the failures so the watcher can
 * report them without dropping the whole file.
 */
export function parseJsonl<T>(
  text: string,
  schema: z.ZodType<T>
): { items: T[]; errors: Array<{ line: number; message: string }> } {
  const items: T[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') {
continue;
}
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      errors.push({ line: i + 1, message: `JSON parse: ${(e as Error).message}` });
      continue;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      errors.push({ line: i + 1, message: result.error.issues[0]?.message ?? 'schema' });
      continue;
    }
    items.push(result.data);
  }
  return { items, errors };
}

export const parseTicketComments = (text: string) => parseJsonl(text, TicketCommentLineSchema);
export const parseTicketRuns = (text: string) => parseJsonl(text, TicketRunLineSchema);

// ---------------------------------------------------------------------------
// Serialize functions — runtime entity in, text out
// ---------------------------------------------------------------------------

/**
 * Drop keys whose value is `undefined`. Kept literal over a generic `omit`
 * helper because we want YAML output to be free of `~` placeholders for
 * missing optional fields.
 */
const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
out[k] = v;
}
  }
  return out as Partial<T>;
};

export function serializeTicketFile(ticket: Ticket): string {
  const meta = compact({
    title: ticket.title,
    priority: ticket.priority,
    column: ticket.columnId,
    milestone: ticket.milestoneId,
    blockedBy: ticket.blockedBy.length > 0 ? ticket.blockedBy : undefined,
    branch: ticket.branch,
    useWorktree: ticket.useWorktree,
    worktreePath: ticket.worktreePath,
    worktreeName: ticket.worktreeName,
    phase: ticket.phase,
    resolution: ticket.resolution,
    autopilot: ticket.autopilot,
    tokenUsage: ticket.tokenUsage,
    shaping: ticket.shaping,
    createdAt: msToIso(ticket.createdAt),
    updatedAt: msToIso(ticket.updatedAt),
  });
  return joinFrontmatter(meta, ticket.description ? `\n${ticket.description}\n` : '\n');
}

export function serializeMilestoneFile(milestone: Milestone): string {
  const meta = compact({
    title: milestone.title,
    description: milestone.description,
    status: milestone.status,
    branch: milestone.branch,
    createdAt: msToIso(milestone.createdAt),
    updatedAt: msToIso(milestone.updatedAt),
  });
  return joinFrontmatter(meta, milestone.brief ? `\n${milestone.brief}\n` : '\n');
}

export function serializePageFile(page: Page, body: string): string {
  // Only include properties when defined and has at least one non-undefined value.
  const rawProps = page.properties;
  const hasProps =
    rawProps !== undefined &&
    Object.values(rawProps).some((v) => v !== undefined);
  const meta = compact({
    title: page.title,
    parentId: page.parentId,
    icon: page.icon,
    sortOrder: page.sortOrder,
    isRoot: page.isRoot,
    ...(hasProps ? { properties: compact(rawProps as Record<string, unknown>) } : {}),
    createdAt: msToIso(page.createdAt),
    updatedAt: msToIso(page.updatedAt),
  });
  return joinFrontmatter(meta, body);
}

export function serializeProjectConfig(project: Project): string {
  const meta = compact({
    id: project.id,
    label: project.label,
    slug: project.slug,
    isPersonal: project.isPersonal,
    source: project.source,
    pipeline: project.pipeline,
    sandbox: project.sandbox,
    autoDispatch: project.autoDispatch,
    createdAt: msToIso(project.createdAt),
  });
  return yaml.stringify(meta, { lineWidth: 0 });
}

const jsonlLine = (obj: Record<string, unknown>): string => `${JSON.stringify(obj)  }\n`;

export const serializeTicketComment = (c: TicketComment): string =>
  jsonlLine({
    id: c.id,
    author: c.author,
    content: c.content,
    createdAt: msToIso(c.createdAt),
  });

export const serializeTicketRun = (r: TicketRun): string =>
  jsonlLine(
    compact({
      id: r.id,
      startedAt: msToIso(r.startedAt),
      endedAt: msToIso(r.endedAt),
      endReason: r.endReason,
      tokenUsage: r.tokenUsage,
    })
  );
