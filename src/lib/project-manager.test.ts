/**
 * Tests for `ProjectManager`'s remaining responsibilities — project / ticket /
 * milestone / page CRUD, getNextTicket priority queue, getFilesChanged git
 * adapter, and processManager wiring.
 *
 * Supervisor-lifecycle behavior (machines, retries, stall detection,
 * auto-dispatch, prompt assembly, tool dispatch) lives in
 * `supervisor-orchestrator.test.ts` since Sprint C2c.9.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePm, type PmCtx } from '@/lib/project-manager-test-helpers';
import type { Project, Ticket, TicketId } from '@/shared/types';

describe('ProjectManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('getNextTicket', () => {
    it('returns null when no tickets are in the first column', () => {
      const { pm } = makePm({
        tickets: [{ id: 't1', columnId: 'in_progress' }],
      });
      expect(pm.getNextTicket('proj-1')).toBeNull();
    });

    it('picks the highest-priority ticket first', () => {
      const { pm } = makePm({
        tickets: [
          { id: 'low', priority: 'low', createdAt: 1000 },
          { id: 'crit', priority: 'critical', createdAt: 2000 },
          { id: 'med', priority: 'medium', createdAt: 500 },
        ],
      });
      expect(pm.getNextTicket('proj-1')?.id).toBe('crit');
    });

    it('breaks priority ties by createdAt ascending (oldest first)', () => {
      const { pm } = makePm({
        tickets: [
          { id: 'newer', priority: 'medium', createdAt: 2000 },
          { id: 'older', priority: 'medium', createdAt: 1000 },
        ],
      });
      expect(pm.getNextTicket('proj-1')?.id).toBe('older');
    });

    it('skips tickets blocked by a non-terminal blocker', () => {
      const { pm } = makePm({
        tickets: [
          { id: 'blocker', columnId: 'in_progress' },
          { id: 'blocked', blockedBy: ['blocker' as TicketId] },
          { id: 'free' },
        ],
      });
      expect(pm.getNextTicket('proj-1')?.id).toBe('free');
    });

    it('ignores blocked-by when the blocker is already terminal', () => {
      const { pm } = makePm({
        tickets: [
          { id: 'blocker', columnId: 'done' },
          { id: 'blocked', blockedBy: ['blocker' as TicketId] },
        ],
      });
      expect(pm.getNextTicket('proj-1')?.id).toBe('blocked');
    });

    it('ignores unknown blocker ids', () => {
      const { pm } = makePm({
        tickets: [{ id: 't1', blockedBy: ['does-not-exist' as TicketId] }],
      });
      expect(pm.getNextTicket('proj-1')?.id).toBe('t1');
    });
  });

  // -------------------------------------------------------------------------
  // T9 — Milestone CRUD (in-memory only, no fs)
  // -------------------------------------------------------------------------
  describe('milestone CRUD', () => {
    it('addMilestone persists the new milestone', () => {
      const { pm, store } = makePm({ tickets: [] });
      const ms = pm.milestones.add({
        projectId: 'proj-1',
        title: 'Sprint 1',
        description: '',
        status: 'active',
      } as Parameters<typeof pm.milestones.add>[0]);

      const stored = store.get('milestones', []);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.id).toBe(ms.id);
    });

    it('getByProject filters by projectId', () => {
      const { pm, store } = makePm({ tickets: [] });
      store.set('milestones', [
        { id: 'm1', projectId: 'proj-1', title: 'A', description: '', status: 'active', createdAt: 0, updatedAt: 0 },
        { id: 'm2', projectId: 'other', title: 'B', description: '', status: 'active', createdAt: 0, updatedAt: 0 },
      ] as never);
      expect(pm.milestones.getByProject('proj-1').map((m) => m.id)).toEqual(['m1']);
    });

    it('updateMilestone stamps completedAt when transitioning into completed', () => {
      const { pm, store } = makePm({ tickets: [] });
      store.set('milestones', [
        { id: 'm1', projectId: 'proj-1', title: 'A', description: '', status: 'active', createdAt: 0, updatedAt: 0 },
      ] as never);

      pm.milestones.update('m1' as never, { status: 'completed' });

      const ms = store.get('milestones', [])[0]!;
      expect(ms.status).toBe('completed');
      expect(ms.completedAt).toBeGreaterThan(0);
    });

    it('updateMilestone clears completedAt when transitioning out of completed', () => {
      const { pm, store } = makePm({ tickets: [] });
      store.set('milestones', [
        {
          id: 'm1',
          projectId: 'proj-1',
          title: 'A',
          description: '',
          status: 'completed',
          completedAt: 12345,
          createdAt: 0,
          updatedAt: 0,
        },
      ] as never);

      pm.milestones.update('m1' as never, { status: 'active' });

      const ms = store.get('milestones', [])[0]!;
      expect(ms.status).toBe('active');
      expect(ms.completedAt).toBeUndefined();
    });

    it('removeMilestone clears milestoneId on orphaned tickets', () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't-orphan' }, { id: 't-other' }],
      });
      // Attach milestoneId to t-orphan.
      const tickets = store.get('tickets', []);
      tickets[0]!.milestoneId = 'm1' as never;
      store.set('tickets', tickets);
      store.set('milestones', [
        { id: 'm1', projectId: 'proj-1', title: 'A', description: '', status: 'active', createdAt: 0, updatedAt: 0 },
      ] as never);

      pm.milestones.remove('m1' as never);

      const t = store.get('tickets', []).find((x: Ticket) => x.id === 't-orphan')!;
      expect(t.milestoneId).toBeUndefined();
      expect(store.get('milestones', [])).toHaveLength(0);
    });

    it('removeMilestone is a no-op for unknown id', () => {
      const { pm, store } = makePm({ tickets: [] });
      store.set('milestones', [] as never);
      expect(() => pm.milestones.remove('nope' as never)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // T9 — Project + Page CRUD (fs-touching paths against tmpdir $HOME)
  // -------------------------------------------------------------------------
  describe('project + page CRUD (tmpdir)', () => {
    let originalHome: string | undefined;
    let homeDir: string;

    beforeEach(() => {
      // electron-shim uses os.homedir() which on Linux resolves $HOME.
      // Point $HOME at a tmpdir so ensureProjectDir / addPage don't write
      // into the operator's real home.
      originalHome = process.env['HOME'];
      homeDir = mkdtempSync(join(tmpdir(), 'pm-test-'));
      process.env['HOME'] = homeDir;
      // addProject fires-and-forgets ensureProjectDir(); real I/O runs async.
      // The outer describe uses fake timers, but fs I/O doesn't schedule on
      // the timer queue — it resolves through libuv. Swap to real timers for
      // this block so we can flush pending microtasks before rmSync.
      vi.useRealTimers();
    });

    afterEach(async () => {
      // Let any pending void-chained fs writes from addProject complete
      // before we rm the tmpdir, otherwise mkdir(recursive:true) re-creates
      // the directory tree after cleanup. 50ms is generous for local fs.
      await new Promise((resolve) => setTimeout(resolve, 50));

      if (originalHome !== undefined) {
        process.env['HOME'] = originalHome;
      } else {
        delete process.env['HOME'];
      }
      rmSync(homeDir, { recursive: true, force: true });
      vi.useFakeTimers();
    });

    it('addProject seeds a root page for the new project', () => {
      const { pm, store } = makePm({ tickets: [] });
      // Wipe the seeded project so addProject starts clean.
      store.set('projects', []);

      const project = pm.addProject({
        label: 'New Project',
        slug: 'new-project',
        source: { kind: 'local', workspaceDir: join(homeDir, 'work') },
      } as unknown as Parameters<typeof pm.addProject>[0]);

      const pages = store.get('pages', []);
      const rootPage = pages.find((p) => p.projectId === project.id && p.isRoot);
      expect(rootPage).toBeDefined();
      expect(rootPage!.parentId).toBeNull();
    });

    it('removeProject cascades to tickets, milestones, and pages', async () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't-target' }, { id: 't-unrelated' }],
      });
      // Seed a second project so we can verify the cascade doesn't overreach.
      const projects = store.get('projects', []);
      projects.push({
        id: 'other-proj',
        label: 'Other',
        slug: 'other',
        createdAt: Date.now(),
      } as unknown as Project);
      store.set('projects', projects);

      // Move t-unrelated to the other project.
      const tickets = store.get('tickets', []);
      tickets.find((t: Ticket) => t.id === 't-unrelated')!.projectId = 'other-proj' as never;
      store.set('tickets', tickets);

      store.set('milestones', [
        { id: 'm1', projectId: 'proj-1', title: 'A', description: '', status: 'active', createdAt: 0, updatedAt: 0 },
        {
          id: 'm2',
          projectId: 'other-proj',
          title: 'B',
          description: '',
          status: 'active',
          createdAt: 0,
          updatedAt: 0,
        },
      ] as never);
      store.set('pages', [
        {
          id: 'p1',
          projectId: 'proj-1',
          parentId: null,
          title: 'root1',
          sortOrder: 0,
          isRoot: true,
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 'p2',
          projectId: 'other-proj',
          parentId: null,
          title: 'root2',
          sortOrder: 0,
          isRoot: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ] as never);

      await pm.removeProject('proj-1');

      expect(store.get('projects', []).map((p) => p.id)).toEqual(['other-proj']);
      expect(store.get('tickets', []).map((t) => t.id)).toEqual(['t-unrelated']);
      expect(store.get('milestones', []).map((m) => m.id)).toEqual(['m2']);
      expect(store.get('pages', []).map((p) => p.id)).toEqual(['p2']);
    });
  });

  // -------------------------------------------------------------------------
  // T8 — getFilesChanged against a real git tmpdir repo
  // -------------------------------------------------------------------------
  describe('getFilesChanged (real git tmpdir)', () => {
    let repoDir: string;

    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8' }).trim();

    beforeEach(() => {
      // Tests in this block need real wall-clock time for exec() callbacks.
      vi.useRealTimers();
      repoDir = mkdtempSync(join(tmpdir(), 'pm-git-'));
      execFileSync('git', ['init', '-q', repoDir]);
      execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User']);
      execFileSync('git', ['-C', repoDir, 'config', 'commit.gpgsign', 'false']);
    });

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true });
      vi.useFakeTimers();
    });

    const makePmForRepo = (): PmCtx =>
      makePm({
        source: { kind: 'local', workspaceDir: repoDir },
        tickets: [{ id: 't1' }],
      });

    it('returns empty result for a fresh repo with no files', async () => {
      const { pm } = makePmForRepo();
      const result = await pm.getFilesChanged('t1');
      expect(result.hasChanges).toBe(false);
      expect(result.files).toEqual([]);
    });

    it('detects untracked files in a zero-commit repo as untracked + synthesizes a patch', async () => {
      const { pm } = makePmForRepo();
      writeFileSync(join(repoDir, 'new.txt'), 'hello\nworld\n');

      const result = await pm.getFilesChanged('t1');

      expect(result.hasChanges).toBe(true);
      expect(result.files).toHaveLength(1);
      const file = result.files[0]!;
      expect(file.path).toBe('new.txt');
      expect(file.status).toBe('untracked');
      // Synthesized patch should include the added lines.
      expect(file.patch).toContain('+hello');
      expect(file.patch).toContain('+world');
      expect(file.additions).toBe(2);
    });

    it('reports uncommitted modifications when HEAD exists but there is no upstream', async () => {
      writeFileSync(join(repoDir, 'a.txt'), 'original\n');
      git('add', 'a.txt');
      git('commit', '-q', '-m', 'init');

      // Modify it
      writeFileSync(join(repoDir, 'a.txt'), 'modified\n');

      const { pm } = makePmForRepo();
      const result = await pm.getFilesChanged('t1');

      expect(result.hasChanges).toBe(true);
      const file = result.files.find((f) => f.path === 'a.txt')!;
      expect(file.status).toBe('modified');
      expect(file.additions).toBeGreaterThan(0);
      expect(file.deletions).toBeGreaterThan(0);
    });

    it('reports staged additions alongside modifications', async () => {
      writeFileSync(join(repoDir, 'a.txt'), 'a\n');
      git('add', 'a.txt');
      git('commit', '-q', '-m', 'init');

      writeFileSync(join(repoDir, 'b.txt'), 'b\n');
      git('add', 'b.txt');

      const { pm } = makePmForRepo();
      const result = await pm.getFilesChanged('t1');

      const b = result.files.find((f) => f.path === 'b.txt')!;
      expect(b.status).toBe('added');
    });

    it('reports staged deletions', async () => {
      writeFileSync(join(repoDir, 'a.txt'), 'a\n');
      git('add', 'a.txt');
      git('commit', '-q', '-m', 'init');
      git('rm', '-q', 'a.txt');

      const { pm } = makePmForRepo();
      const result = await pm.getFilesChanged('t1');

      const a = result.files.find((f) => f.path === 'a.txt')!;
      expect(a.status).toBe('deleted');
    });

    it('marks binary files as isBinary and does not produce a patch', async () => {
      git('commit', '-q', '--allow-empty', '-m', 'init');
      // Write a file with NUL bytes — the binary-detection heuristic checks
      // the first 8KB for a 0x00 byte.
      const buf = Buffer.concat([Buffer.from('header\0'), Buffer.alloc(100, 0xff)]);
      writeFileSync(join(repoDir, 'bin.dat'), buf);

      const { pm } = makePmForRepo();
      const result = await pm.getFilesChanged('t1');

      const bin = result.files.find((f) => f.path === 'bin.dat')!;
      expect(bin.isBinary).toBe(true);
      expect(bin.patch).toBeUndefined();
    });

    it('returns empty when the ticket does not exist', async () => {
      const { pm } = makePmForRepo();
      const result = await pm.getFilesChanged('nope' as TicketId);
      expect(result.hasChanges).toBe(false);
    });

    it('returns empty when the project workspaceDir no longer exists on disk', async () => {
      const { pm } = makePmForRepo();
      rmSync(repoDir, { recursive: true, force: true });
      const result = await pm.getFilesChanged('t1');
      expect(result.hasChanges).toBe(false);
    });

    it('shows committed diff for a ticket on a feature branch with no worktree', async () => {
      // Reproduces the bug: ticket has a branch but no worktree, workspace
      // is checked out on that branch. Old code resolved against @{upstream}
      // and showed nothing; new code diffs against trunk (main) and surfaces
      // the actual ticket diff.
      writeFileSync(join(repoDir, 'a.txt'), 'a\n');
      git('add', 'a.txt');
      git('commit', '-q', '-m', 'init on main');
      git('checkout', '-q', '-b', 'feat/foo');
      writeFileSync(join(repoDir, 'b.txt'), 'b\n');
      git('add', 'b.txt');
      git('commit', '-q', '-m', 'add b on feat/foo');

      const { pm, store } = makePm({
        source: { kind: 'local', workspaceDir: repoDir },
        tickets: [{ id: 't1' }],
      });
      // Record the ticket's branch — mirrors how the supervisor sets it.
      const tickets = store.get('tickets', []);
      tickets[0]!.branch = 'feat/foo';
      store.set('tickets', tickets);

      const result = await pm.getFilesChanged('t1');

      expect(result.hasChanges).toBe(true);
      const committed = result.files.filter((f) => f.group === 'committed');
      expect(committed.map((f) => f.path)).toEqual(['b.txt']);
    });
  });

  // -------------------------------------------------------------------------
  // T-new — addTicket / updateTicket basics
  // -------------------------------------------------------------------------
  describe('addTicket / updateTicket', () => {
    it('addTicket assigns the first column as default columnId', () => {
      const { pm, store } = makePm({ tickets: [] });
      const ticket = pm.addTicket({
        projectId: 'proj-1',
        title: 'New ticket',
        description: '',
        priority: 'medium',
        blockedBy: [],
        comments: [],
        runs: [],
      } as Parameters<typeof pm.addTicket>[0]);

      expect(ticket.columnId).toBe('backlog'); // first column of TEST_PIPELINE
      expect(ticket.id).toBeDefined();
      expect(store.get('tickets', [])).toHaveLength(1);
    });

    it('updateTicket stamps updatedAt', () => {
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      const { pm, store } = makePm({
        tickets: [{ id: 't1' }],
      });
      const before = store.get('tickets', [])[0]!.updatedAt;

      vi.setSystemTime(new Date('2025-06-01T00:00:00Z'));
      pm.updateTicket('t1', { title: 'Updated' });

      const after = store.get('tickets', [])[0]!.updatedAt;
      expect(after).toBeGreaterThan(before);
      expect(store.get('tickets', [])[0]!.title).toBe('Updated');
    });

    it('updateTicket is a no-op for unknown id', () => {
      const { pm, store } = makePm({ tickets: [{ id: 't1' }] });
      pm.updateTicket('nope' as never, { title: 'X' });
      expect(store.get('tickets', [])[0]!.title).toBe('Ticket t1');
    });
  });

  // -------------------------------------------------------------------------
  // T-new — getPipeline cascade
  // -------------------------------------------------------------------------
  describe('getPipeline', () => {
    it('returns project.pipeline when no FLEET.md workflow is loaded', () => {
      const { pm } = makePm({
        pipeline: {
          columns: [
            { id: 'todo', label: 'To Do' },
            { id: 'done', label: 'Done' },
          ],
        },
        tickets: [],
      });
      const pipeline = pm.getPipeline('proj-1');
      expect(pipeline.columns.map((c) => c.id)).toEqual(['todo', 'done']);
    });

    it('returns FLEET.md pipeline when workflow has one', () => {
      const { pm } = makePm(
        { tickets: [] },
        {
          workflowConfig: {
            pipeline: {
              columns: [
                { id: 'inbox', label: 'Inbox' },
                { id: 'shipped', label: 'Shipped' },
              ],
            },
          },
        }
      );
      const pipeline = pm.getPipeline('proj-1');
      expect(pipeline.columns.map((c) => c.id)).toEqual(['inbox', 'shipped']);
    });

    it('falls back to SIMPLE_PIPELINE for projects without a source', () => {
      const { pm, store } = makePm({ tickets: [] });
      // Remove source from the project to simulate a "no source" project
      const projects = store.get('projects', []);
      delete (projects[0] as Record<string, unknown>).source;
      // Also clear pipeline so we hit the final fallback
      delete (projects[0] as Record<string, unknown>).pipeline;
      store.set('projects', projects);

      const pipeline = pm.getPipeline('proj-1');
      // SIMPLE_PIPELINE has 3 columns: backlog, in_progress, done
      expect(pipeline.columns).toHaveLength(3);
      expect(pipeline.columns[0]!.id).toBe('backlog');
      expect(pipeline.columns[2]!.id).toBe('done');
    });

    it('falls back to DEFAULT_PIPELINE for projects with a source but no pipeline', () => {
      const { pm, store } = makePm({
        tickets: [],
        source: { kind: 'local', workspaceDir: '/tmp/work' },
      });
      // Remove pipeline from the project
      const projects = store.get('projects', []);
      delete (projects[0] as Record<string, unknown>).pipeline;
      store.set('projects', projects);

      const pipeline = pm.getPipeline('proj-1');
      // DEFAULT_PIPELINE has ≥ 2 columns, starts with backlog, ends with completed
      expect(pipeline.columns.length).toBeGreaterThanOrEqual(2);
      expect(pipeline.columns[0]!.id).toBe('backlog');
      expect(pipeline.columns[pipeline.columns.length - 1]!.id).toBe('completed');
    });
  });

  // -------------------------------------------------------------------------
  // T-new — moveTicketToColumn
  // -------------------------------------------------------------------------
  describe('moveTicketToColumn', () => {
    it('updates columnId and columnChangedAt', () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't1', columnId: 'backlog' }],
      });
      pm.moveTicketToColumn('t1', 'in_progress');

      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.columnId).toBe('in_progress');
      expect(ticket.columnChangedAt).toBeGreaterThan(0);
    });

    it('auto-resolves as completed when moving to terminal column', () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't1', columnId: 'in_progress' }],
      });
      pm.moveTicketToColumn('t1', 'done'); // terminal column of TEST_PIPELINE

      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.resolution).toBe('completed');
      expect(ticket.resolvedAt).toBeGreaterThan(0);
    });

    it('preserves existing resolution when moving to terminal column', () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't1', columnId: 'in_progress' }],
      });
      // Pre-set a different resolution
      pm.updateTicket('t1', { resolution: 'wont-do' as never });

      pm.moveTicketToColumn('t1', 'done');

      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      // Should keep 'wont-do', not override with 'completed'
      expect(ticket.resolution).toBe('wont-do');
    });

    it('clears resolution when moving away from terminal column (reopen)', () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't1', columnId: 'done' }],
      });
      // Set resolution as if ticket was completed
      pm.updateTicket('t1', { resolution: 'completed' as never, resolvedAt: Date.now() });

      pm.moveTicketToColumn('t1', 'in_progress');

      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.resolution).toBeUndefined();
      expect(ticket.resolvedAt).toBeUndefined();
    });

    it('is a no-op for unknown ticketId', () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't1', columnId: 'backlog' }],
      });
      pm.moveTicketToColumn('nope' as never, 'in_progress');
      // t1 should be unchanged
      expect(store.get('tickets', [])[0]!.columnId).toBe('backlog');
    });

    it('is a no-op for unknown columnId', () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't1', columnId: 'backlog' }],
      });
      pm.moveTicketToColumn('t1', 'nonexistent' as never);
      expect(store.get('tickets', [])[0]!.columnId).toBe('backlog');
    });
  });

  // -------------------------------------------------------------------------
  // T-new — resolveTicket
  // -------------------------------------------------------------------------
  describe('resolveTicket', () => {
    it('sets resolution and moves to terminal column', () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't1', columnId: 'in_progress' }],
      });
      pm.resolveTicket('t1', 'completed' as never);

      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.resolution).toBe('completed');
      expect(ticket.columnId).toBe('done'); // terminal column
      expect(ticket.resolvedAt).toBeGreaterThan(0);
    });

    it('does not overwrite resolvedAt if already set', () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't1', columnId: 'in_progress' }],
      });
      // Pre-set resolvedAt
      pm.updateTicket('t1', { resolvedAt: 12345 });

      pm.resolveTicket('t1', 'wont-do' as never);

      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.resolvedAt).toBe(12345);
    });

    it('is a no-op for unknown ticketId', () => {
      const { pm } = makePm({ tickets: [{ id: 't1' }] });
      expect(() => pm.resolveTicket('nope' as never, 'completed' as never)).not.toThrow();
    });

    it('does not move if ticket is already in terminal column', () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't1', columnId: 'done' }],
      });
      // Spy on updateTicket calls indirectly through store changes
      const before = store.get('tickets', [])[0]!.updatedAt;
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

      pm.resolveTicket('t1', 'completed' as never);

      const ticket = store.get('tickets', []).find((t: Ticket) => t.id === 't1')!;
      expect(ticket.columnId).toBe('done'); // unchanged
      expect(ticket.resolution).toBe('completed');
    });
  });

  // migrateOrphanedTickets was removed — its replacement (repo.syncColumnsForProject)
  // is exercised by packages/projects-db/src/repo.test.ts.

  // -------------------------------------------------------------------------
  // T-new — removeTicket
  // -------------------------------------------------------------------------
  describe('removeTicket', () => {
    it('removes the ticket from the store', () => {
      const { pm, store } = makePm({
        tickets: [{ id: 't1' }, { id: 't2' }],
      });
      pm.removeTicket('t1');
      expect(store.get('tickets', []).map((t: Ticket) => t.id)).toEqual(['t2']);
    });

    it('is a no-op for unknown ticketId', () => {
      const { pm, store } = makePm({ tickets: [{ id: 't1' }] });
      pm.removeTicket('nope' as never);
      expect(store.get('tickets', [])).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // processManager wiring
  // -------------------------------------------------------------------------
  describe('processManager integration', () => {
    // `statusFallback` was removed along with the main-process WS client —
    // the Code tab's ProcessManager entry is now authoritative for sandbox
    // status, so the orchestrator has nothing to inject.
    it('does not fail when no processManager is provided', () => {
      expect(() => makePm({ tickets: [{ id: 't1' }] })).not.toThrow();
    });
  });
});
