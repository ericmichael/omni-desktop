/**
 * End-to-end smoke test for the refactored omni-projects MCP tools.
 *
 * Drives the real `createServer(repo)` through a real MCP `Client` over an
 * in-memory transport, backed by a temp SQLite `SqliteProjectsRepo`. This is
 * the local (no-Azure) verification that the async-IProjectsRepo rewrite works:
 * the same tool code runs unchanged behind the HTTP/Postgres path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDatabase, openDatabase, ProjectsRepo, SqliteProjectsRepo } from 'omni-projects-db';
import { createServer } from 'omni-projects-mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
let db: ReturnType<typeof openDatabase>;
let repo: SqliteProjectsRepo;
let client: Client;

/** Call a tool and parse its single JSON text payload. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  return { ...JSON.parse(text), _isError: res.isError ?? false };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'omni-mcp-'));
  db = openDatabase(join(dir, 'projects.db'));
  repo = new SqliteProjectsRepo(new ProjectsRepo(db));
  const server = createServer(repo);

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

afterAll(async () => {
  await client.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('omni-projects MCP tools (async IProjectsRepo, SQLite)', () => {
  let projectId: string;
  let ticketId: string;

  it('creates and lists a project with seeded pipeline + root page', async () => {
    const created = await call('create_project', { label: 'Test Project' });
    expect(created._isError).toBe(false);
    expect(created.id).toMatch(/^proj_/);
    expect(created.pipeline.length).toBeGreaterThan(0);
    expect(created.root_page_id).toMatch(/^pg_/);
    projectId = created.id;

    const listed = await call('list_projects');
    expect(listed.projects.find((p: any) => p.id === projectId)?.label).toBe('Test Project');

    // Root page content was written to the DB (not the filesystem).
    const page = await call('read_page', { page_id: created.root_page_id });
    expect(page.content).toContain('# Test Project');
  });

  it('rejects a duplicate slug', async () => {
    const dup = await call('create_project', { label: 'Test Project' });
    expect(dup._isError).toBe(true);
    expect(dup.error).toMatch(/already exists/);
  });

  it('creates, moves, and lists a ticket', async () => {
    const pipeline = await call('get_pipeline', { project_id: projectId });
    const spec = pipeline.columns.find((column: any) => column.label === 'Spec');
    expect(spec.workflow).toMatchObject({
      purpose: expect.stringContaining('decision-complete'),
      definitionOfDone: expect.arrayContaining([expect.stringContaining('plan')]),
      recommendedSkills: expect.arrayContaining(['software-planning']),
    });
    const lastCol = pipeline.columns[pipeline.columns.length - 1].label;

    const created = await call('create_ticket', { project_id: projectId, title: 'Do the thing', priority: 'high' });
    expect(created._isError).toBe(false);
    ticketId = created.id;

    const moved = await call('move_ticket', { ticket_id: ticketId, column: lastCol });
    expect(moved.column).toBe(lastCol);

    const list = await call('list_tickets', { project_id: projectId, column: lastCol });
    expect(list.tickets.map((t: any) => t.id)).toContain(ticketId);

    const filteredOut = await call('list_tickets', { project_id: projectId, priority: 'low' });
    expect(filteredOut.tickets.map((t: any) => t.id)).not.toContain(ticketId);
  });

  it('returns persisted column workflow edits from get_pipeline', async () => {
    const editedDefinitionOfDone = 'Edited Implementation DoD is exposed through get_pipeline';
    const columns = await repo.listColumns(projectId);
    const implementation = columns.find((column) => column.label === 'Implementation');
    expect(implementation).toBeTruthy();

    const workflow = JSON.parse(implementation!.workflow ?? '{}') as { definitionOfDone?: string[] };
    await repo.upsertColumn({
      ...implementation!,
      workflow: JSON.stringify({
        ...workflow,
        definitionOfDone: [editedDefinitionOfDone],
      }),
    });

    const pipeline = await call('get_pipeline', { project_id: projectId });
    const implementationFromTool = pipeline.columns.find((column: any) => column.label === 'Implementation');
    expect(implementationFromTool.workflow.definitionOfDone).toEqual([editedDefinitionOfDone]);
  });

  it('updates a ticket and tracks blockers', async () => {
    const upd = await call('update_ticket', {
      ticket_id: ticketId,
      description: 'now described',
      add_blocked_by: ['tkt_other'],
    });
    expect(upd.ok).toBe(true);

    const got = await call('get_ticket', { ticket_id: ticketId });
    expect(got.description).toBe('now described');
    expect(got.blocked_by).toEqual(['tkt_other']);
  });

  it('adds and reads comments', async () => {
    await call('add_ticket_comment', { ticket_id: ticketId, content: 'a finding', author: 'agent' });
    const comments = await call('get_ticket_comments', { ticket_id: ticketId });
    expect(comments.comments).toHaveLength(1);
    expect(comments.comments[0].content).toBe('a finding');
  });

  it('searches tickets by keyword', async () => {
    const found = await call('search_tickets', { query: 'the thing' });
    expect(found.tickets.map((t: any) => t.id)).toContain(ticketId);
  });

  it('archives and unarchives a ticket', async () => {
    await call('archive_ticket', { ticket_id: ticketId });
    let list = await call('list_tickets', { project_id: projectId });
    expect(list.tickets.map((t: any) => t.id)).not.toContain(ticketId);

    await call('unarchive_ticket', { ticket_id: ticketId });
    list = await call('list_tickets', { project_id: projectId });
    expect(list.tickets.map((t: any) => t.id)).toContain(ticketId);
  });

  it('manages pages with DB-backed content', async () => {
    const page = await call('create_page', { project_id: projectId, title: 'Spec', content: '## Hello' });
    expect(page.id).toMatch(/^pg_/);

    await call('update_page', { page_id: page.id, content: '## Updated' });
    const read = await call('read_page', { page_id: page.id });
    expect(read.content).toBe('## Updated');

    const pages = await call('list_pages', { project_id: projectId });
    expect(pages.pages.map((p: any) => p.title)).toContain('Spec');
  });

  it('manages milestones', async () => {
    const m = await call('create_milestone', { project_id: projectId, title: 'M1' });
    const upd = await call('update_milestone', { milestone_id: m.id, status: 'completed' });
    expect(upd.ok).toBe(true);
    const list = await call('list_milestones', { project_id: projectId });
    expect(list.milestones.find((x: any) => x.id === m.id)?.completed_at).toBeTruthy();
  });

  it('captures inbox items and promotes them to tickets and projects', async () => {
    const item = await call('create_inbox_item', { title: 'an idea' });
    let inbox = await call('list_inbox');
    expect(inbox.items.map((i: any) => i.id)).toContain(item.id);

    const promoted = await call('inbox_to_tickets', { item_id: item.id, project_id: projectId });
    expect(promoted.ticket_ids).toHaveLength(1);
    // Promoted items drop out of the default inbox listing.
    inbox = await call('list_inbox');
    expect(inbox.items.map((i: any) => i.id)).not.toContain(item.id);

    const item2 = await call('create_inbox_item', { title: 'a bigger idea' });
    const proj = await call('inbox_to_project', { item_id: item2.id, label: 'Spun Off' });
    expect(proj.project_id).toMatch(/^proj_/);
    const projects = await call('list_projects');
    expect(projects.projects.map((p: any) => p.label)).toContain('Spun Off');
  });

  it('deletes a project', async () => {
    const created = await call('create_project', { label: 'Throwaway' });
    const del = await call('delete_project', { project_id: created.id });
    expect(del.ok).toBe(true);
    const projects = await call('list_projects');
    expect(projects.projects.map((p: any) => p.id)).not.toContain(created.id);
  });
});
