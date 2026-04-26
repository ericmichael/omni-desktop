import { describe, expect, it } from 'vitest';

import {
  joinFrontmatter,
  parseFrontmatterYaml,
  parseMilestoneFile,
  parsePageFile,
  parseProjectConfig,
  parseTicketComments,
  parseTicketFile,
  parseTicketRuns,
  ProjectFileError,
  serializeMilestoneFile,
  serializePageFile,
  serializeProjectConfig,
  serializeTicketComment,
  serializeTicketFile,
  serializeTicketRun,
  splitFrontmatter,
} from '@/lib/project-files';
import type {
  Milestone,
  MilestoneId,
  Page,
  PageId,
  Project,
  ProjectId,
  Ticket,
  TicketComment,
  TicketId,
  TicketRun,
} from '@/shared/types';

const ISO = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Fixed timestamps used across roundtrip assertions so serialization is deterministic.
const T1 = Date.UTC(2026, 3, 12, 14, 32, 1); // 2026-04-12T14:32:01Z
const T2 = Date.UTC(2026, 3, 12, 15, 10, 44); // 2026-04-12T15:10:44Z

// ---------------------------------------------------------------------------
// splitFrontmatter / joinFrontmatter
// ---------------------------------------------------------------------------

describe('splitFrontmatter', () => {
  it('splits a normal frontmatter + body file', () => {
    const text = '---\ntitle: Hello\n---\n\nbody here\n';
    const { meta, body } = splitFrontmatter(text);
    expect(meta).toBe('title: Hello');
    expect(body).toBe('\nbody here\n');
  });

  it('returns meta=null for a file without frontmatter', () => {
    const text = 'just a body\n';
    expect(splitFrontmatter(text)).toEqual({ meta: null, body: 'just a body\n' });
  });

  it('returns meta=null for unterminated frontmatter', () => {
    const text = '---\ntitle: Hello\nno close fence';
    expect(splitFrontmatter(text).meta).toBeNull();
  });

  it('handles empty frontmatter block', () => {
    const text = '---\n---\nbody\n';
    const { meta, body } = splitFrontmatter(text);
    expect(meta).toBe('');
    expect(body).toBe('body\n');
  });

  it('handles CRLF line endings', () => {
    const text = '---\r\ntitle: Hello\r\n---\r\nbody\r\n';
    const { meta, body } = splitFrontmatter(text);
    expect(meta).toBe('title: Hello');
    expect(body).toBe('body\r\n');
  });
});

describe('joinFrontmatter', () => {
  it('roundtrips through splitFrontmatter', () => {
    const text = joinFrontmatter({ title: 'Hello', priority: 'high' }, '\nbody\n');
    const { meta, body } = splitFrontmatter(text);
    expect(meta).toContain('title: Hello');
    expect(meta).toContain('priority: high');
    expect(body).toBe('\nbody\n');
  });

  it('produces a file that starts with the fence', () => {
    const text = joinFrontmatter({ a: 1 }, 'body');
    expect(text.startsWith('---\n')).toBe(true);
  });

  it('appends the body verbatim after the closing fence', () => {
    expect(joinFrontmatter({ a: 1 }, 'body')).toMatch(/---\nbody$/);
    expect(joinFrontmatter({ a: 1 }, '\nbody\n')).toMatch(/---\n\nbody\n$/);
    expect(joinFrontmatter({ a: 1 }, '')).toMatch(/---\n$/);
  });
});

describe('parseFrontmatterYaml', () => {
  it('returns empty object for null or whitespace', () => {
    expect(parseFrontmatterYaml(null).isOk() && parseFrontmatterYaml(null)).toMatchObject({ value: {} });
    expect(parseFrontmatterYaml('  \n').isOk()).toBe(true);
  });

  it('rejects arrays', () => {
    const r = parseFrontmatterYaml('- one\n- two');
    expect(r.isErr()).toBe(true);
  });

  it('rejects malformed YAML', () => {
    const r = parseFrontmatterYaml('key: [unclosed');
    expect(r.isErr()).toBe(true);
  });

  it('parses a simple mapping', () => {
    const r = parseFrontmatterYaml('a: 1\nb: hello');
    expect(r.isOk() && r.value).toEqual({ a: 1, b: 'hello' });
  });
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

const makeTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'tkt-1' as TicketId,
  projectId: 'proj-1' as ProjectId,
  title: 'Fix the login redirect',
  description: 'Users land on a blank page after OAuth.',
  priority: 'high',
  blockedBy: [],
  columnId: 'in-progress',
  createdAt: T1,
  updatedAt: T2,
  comments: [],
  runs: [],
  ...overrides,
});

describe('ticket file roundtrip', () => {
  it('roundtrips a minimal ticket', () => {
    const t = makeTicket();
    const text = serializeTicketFile(t);
    const parsed = parseTicketFile(text, t.id, t.projectId);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value).toEqual(t);
    }
  });

  it('roundtrips a ticket with all optional fields', () => {
    const t = makeTicket({
      milestoneId: 'mile-1' as MilestoneId,
      blockedBy: ['tkt-2' as TicketId, 'tkt-3' as TicketId],
      branch: 'fix/login',
      useWorktree: true,
      worktreePath: '/tmp/worktree',
      worktreeName: 'login-fix',
      phase: 'running',
      resolution: 'completed',
      autopilot: true,
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      shaping: { doneLooksLike: 'redirect works', appetite: 'medium', outOfScope: 'password reset' },
    });
    const text = serializeTicketFile(t);
    const parsed = parseTicketFile(text, t.id, t.projectId);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
expect(parsed.value).toEqual(t);
}
  });

  it('uses ISO strings for timestamps in the file', () => {
    const text = serializeTicketFile(makeTicket());
    expect(text).toContain(`createdAt: ${ISO(T1)}`);
    expect(text).toContain(`updatedAt: ${ISO(T2)}`);
  });

  it('stores description as body, not frontmatter', () => {
    const text = serializeTicketFile(makeTicket({ description: 'Multi-line\n\ndescription.' }));
    expect(text).not.toContain('description:');
    expect(text).toContain('Multi-line\n\ndescription.');
  });

  it('honors the id and projectId supplied by the caller (not from file)', () => {
    const text = serializeTicketFile(makeTicket({ id: 'wrong' as TicketId }));
    const parsed = parseTicketFile(text, 'tkt-real' as TicketId, 'proj-real' as ProjectId);
    expect(parsed.isOk() && parsed.value.id).toBe('tkt-real');
    expect(parsed.isOk() && parsed.value.projectId).toBe('proj-real');
  });

  it('returns ProjectFileError with a field path on missing required fields', () => {
    const text = '---\ntitle: Partial\n---\n\nbody\n';
    const parsed = parseTicketFile(text, 'tkt-1' as TicketId, 'proj-1' as ProjectId);
    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr()) {
      expect(parsed.error).toBeInstanceOf(ProjectFileError);
      expect(parsed.error.path).toBeDefined();
    }
  });

  it('returns ProjectFileError on invalid enum value', () => {
    const text = serializeTicketFile(makeTicket()).replace('priority: high', 'priority: urgent');
    const parsed = parseTicketFile(text, 'tkt-1' as TicketId, 'proj-1' as ProjectId);
    expect(parsed.isErr()).toBe(true);
  });

  it('returns ProjectFileError on invalid timestamp', () => {
    const text = serializeTicketFile(makeTicket()).replace(ISO(T1), 'not-a-date');
    const parsed = parseTicketFile(text, 'tkt-1' as TicketId, 'proj-1' as ProjectId);
    expect(parsed.isErr()).toBe(true);
  });

  it('accepts numeric timestamps for migration roundtrips', () => {
    const text = '---\ntitle: T\npriority: low\ncolumn: backlog\ncreatedAt: 1000\nupdatedAt: 2000\n---\n';
    const parsed = parseTicketFile(text, 'tkt-1' as TicketId, 'proj-1' as ProjectId);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.createdAt).toBe(1000);
      expect(parsed.value.updatedAt).toBe(2000);
    }
  });
});

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

const makeMilestone = (overrides: Partial<Milestone> = {}): Milestone => ({
  id: 'mile-1' as MilestoneId,
  projectId: 'proj-1' as ProjectId,
  title: 'Auth overhaul',
  description: 'Replace legacy session auth with JWT.',
  status: 'active',
  createdAt: T1,
  updatedAt: T2,
  ...overrides,
});

describe('milestone file roundtrip', () => {
  it('roundtrips a milestone without brief', () => {
    const m = makeMilestone();
    const text = serializeMilestoneFile(m);
    const parsed = parseMilestoneFile(text, m.id, m.projectId);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
expect(parsed.value).toEqual(m);
}
  });

  it('roundtrips a milestone with a brief body', () => {
    const m = makeMilestone({ brief: '## Goals\n\nReplace sessions.', branch: 'feature/auth' });
    const text = serializeMilestoneFile(m);
    const parsed = parseMilestoneFile(text, m.id, m.projectId);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
expect(parsed.value).toEqual(m);
}
  });

  it('rejects invalid status', () => {
    const text = serializeMilestoneFile(makeMilestone()).replace('status: active', 'status: draft');
    const parsed = parseMilestoneFile(text, 'mile-1' as MilestoneId, 'proj-1' as ProjectId);
    expect(parsed.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const makePage = (overrides: Partial<Page> = {}): Page => ({
  id: 'page-1' as PageId,
  projectId: 'proj-1' as ProjectId,
  parentId: null,
  title: 'Onboarding plan',
  sortOrder: 1,
  createdAt: T1,
  updatedAt: T2,
  ...overrides,
});

describe('page file roundtrip', () => {
  it('roundtrips a minimal page', () => {
    const p = makePage();
    const text = serializePageFile(p, '\nbody content\n');
    const parsed = parsePageFile(text, p.id, p.projectId);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.page).toEqual(p);
      expect(parsed.value.body).toBe('\nbody content\n');
    }
  });

  it('roundtrips a page with full properties and body', () => {
    const p = makePage({
      icon: '📋',
      parentId: 'page-root' as PageId,
      isRoot: false,
      properties: {
        status: 'ready',
        size: 'medium',
        projectId: 'proj-2' as ProjectId,
        milestoneId: 'mile-1' as MilestoneId,
        outcome: 'Users can sign up without help',
        notDoing: 'Email verification',
        laterAt: T1,
      },
    });
    const text = serializePageFile(p, 'hello\n');
    const parsed = parsePageFile(text, p.id, p.projectId);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.page).toEqual(p);
      expect(parsed.value.body).toBe('hello\n');
    }
  });

  it('omits properties entirely when none set', () => {
    const text = serializePageFile(makePage(), 'body');
    expect(text).not.toContain('status:');
    expect(text).not.toContain('size:');
  });

  it('elides projectId relation when absent, preserves it when present', () => {
    const p1 = makePage();
    const p2 = makePage({ properties: { projectId: 'proj-rel' as ProjectId } });
    const parsed1 = parsePageFile(serializePageFile(p1, 'x'), p1.id, p1.projectId);
    const parsed2 = parsePageFile(serializePageFile(p2, 'x'), p2.id, p2.projectId);
    expect(parsed1.isOk() && parsed1.value.page.properties).toBeUndefined();
    expect(parsed2.isOk() && parsed2.value.page.properties?.projectId).toBe('proj-rel');
  });
});

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'proj-1' as ProjectId,
  label: 'Launcher',
  slug: 'launcher',
  createdAt: T1,
  ...overrides,
});

describe('project config roundtrip', () => {
  it('roundtrips a minimal project', () => {
    const p = makeProject();
    const text = serializeProjectConfig(p);
    const parsed = parseProjectConfig(text);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
expect(parsed.value).toEqual(p);
}
  });

  it('roundtrips a project with local source and pipeline', () => {
    const p = makeProject({
      source: { kind: 'local', workspaceDir: '/home/user/code', gitDetected: true },
      pipeline: {
        columns: [
          { id: 'backlog', label: 'Backlog' },
          { id: 'in-progress', label: 'In Progress', maxConcurrent: 3 },
          { id: 'review', label: 'Review', gate: true, description: 'Human approval' },
          { id: 'done', label: 'Done' },
        ],
      },
      autoDispatch: true,
    });
    const text = serializeProjectConfig(p);
    const parsed = parseProjectConfig(text);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
expect(parsed.value).toEqual(p);
}
  });

  it('roundtrips a project with git-remote source', () => {
    const p = makeProject({
      source: { kind: 'git-remote', repoUrl: 'git@github.com:user/repo.git', defaultBranch: 'main' },
    });
    const text = serializeProjectConfig(p);
    const parsed = parseProjectConfig(text);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
expect(parsed.value).toEqual(p);
}
  });

  it('rejects an unknown source kind', () => {
    const text = 'id: p1\nlabel: X\nslug: x\ncreatedAt: 2026-04-12T00:00:00Z\nsource:\n  kind: carrier-pigeon\n  address: home\n';
    const parsed = parseProjectConfig(text);
    expect(parsed.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JSONL comments and runs
// ---------------------------------------------------------------------------

describe('ticket comments JSONL', () => {
  const comment: TicketComment = {
    id: 'c1',
    author: 'agent',
    content: 'Found the root cause.',
    createdAt: T1,
  };

  it('roundtrips a single comment', () => {
    const line = serializeTicketComment(comment);
    const { items, errors } = parseTicketComments(line);
    expect(errors).toEqual([]);
    expect(items).toEqual([comment]);
  });

  it('appends multiple comments and parses them', () => {
    const text = serializeTicketComment(comment) + serializeTicketComment({ ...comment, id: 'c2' });
    const { items, errors } = parseTicketComments(text);
    expect(errors).toEqual([]);
    expect(items).toHaveLength(2);
  });

  it('collects errors for bad lines without dropping good ones', () => {
    const text = `${serializeTicketComment(comment)  }not-json\n${  serializeTicketComment({ ...comment, id: 'c2' })}`;
    const { items, errors } = parseTicketComments(text);
    expect(items).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(2);
  });

  it('tolerates trailing blank lines', () => {
    const text = `${serializeTicketComment(comment)  }\n\n`;
    const { items, errors } = parseTicketComments(text);
    expect(items).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

describe('ticket runs JSONL', () => {
  const run: TicketRun = {
    id: 'r1',
    startedAt: T1,
    endedAt: T2,
    endReason: 'completed',
    tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  };

  it('roundtrips a run with token usage', () => {
    const line = serializeTicketRun(run);
    const { items, errors } = parseTicketRuns(line);
    expect(errors).toEqual([]);
    expect(items).toEqual([run]);
  });

  it('roundtrips a run without token usage', () => {
    const bare: TicketRun = { id: 'r2', startedAt: T1, endedAt: T2, endReason: 'failed' };
    const { items } = parseTicketRuns(serializeTicketRun(bare));
    expect(items).toEqual([bare]);
  });
});
