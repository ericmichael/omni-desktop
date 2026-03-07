import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FleetPipeline, FleetTicket } from '@/shared/types';

import { FleetTicketFileSync } from '@/main/fleet-ticket-file-sync';

const makePipeline = (): FleetPipeline => ({
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'done', label: 'Done' },
  ],
});

const makeTicket = (overrides: Partial<FleetTicket> = {}): FleetTicket => ({
  id: 'tkt-1',
  projectId: 'proj-1',
  title: 'Test ticket',
  description: 'A test',
  priority: 'medium',
  columnId: 'backlog',
  blockedBy: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

describe('FleetTicketFileSync', () => {
  let tmpDir: string;
  let sync: FleetTicketFileSync;
  let onColumnChange: ReturnType<typeof vi.fn>;
  let onEscalation: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-sync-test-'));
    onColumnChange = vi.fn();
    onEscalation = vi.fn();
    sync = new FleetTicketFileSync(tmpDir, { onColumnChange, onEscalation });
  });

  afterEach(async () => {
    sync.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- writeAndWatch ---

  it('creates TICKET.yaml with correct content', async () => {
    const ticket = makeTicket({ columnId: 'in_progress' });
    await sync.writeAndWatch(ticket, makePipeline());

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('column: "In Progress"');
    expect(content).toContain('Backlog → In Progress → Done');
  });

  it('creates directory structure if it does not exist', async () => {
    const ticket = makeTicket();
    await sync.writeAndWatch(ticket, makePipeline());

    const dir = path.join(tmpDir, 'fleet/tickets', ticket.id);
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('does not throw (no require() in ESM)', async () => {
    const ticket = makeTicket();
    await expect(sync.writeAndWatch(ticket, makePipeline())).resolves.toBeUndefined();
  });

  // --- handleFileChange: column detection ---

  it('fires onColumnChange when file has a different column', async () => {
    const ticket = makeTicket({ columnId: 'backlog' });
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline);

    // Write agent content and call handleFileChange directly
    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');
    await fs.writeFile(filePath, 'column: "Done"\n', 'utf-8');

    // Drain the initial pendingIgnores first
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onColumnChange).not.toHaveBeenCalled(); // consumed pendingIgnores

    // Now simulate the real agent change
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onColumnChange).toHaveBeenCalledWith('tkt-1', 'done');
  });

  it('matches column labels case-insensitively', async () => {
    const ticket = makeTicket();
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline);

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');
    await fs.writeFile(filePath, 'column: "in progress"\n', 'utf-8');

    // Drain pendingIgnores
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    // Actual change
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onColumnChange).toHaveBeenCalledWith('tkt-1', 'in_progress');
  });

  it('warns on unknown column label', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ticket = makeTicket();
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline);

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');
    await fs.writeFile(filePath, 'column: "Nonexistent"\n', 'utf-8');

    await sync.handleFileChange(ticket.id, filePath, pipeline); // drain
    await sync.handleFileChange(ticket.id, filePath, pipeline);

    expect(onColumnChange).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown column label'));
    warnSpy.mockRestore();
  });

  // --- handleFileChange: escalation ---

  it('fires onEscalation when file has escalation field', async () => {
    const ticket = makeTicket();
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline);

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');
    await fs.writeFile(filePath, 'column: "Backlog"\nescalation: "Need API key"\n', 'utf-8');

    await sync.handleFileChange(ticket.id, filePath, pipeline); // drain
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onEscalation).toHaveBeenCalledWith('tkt-1', 'Need API key');
  });

  it('does not fire duplicate escalation for same message', async () => {
    const ticket = makeTicket();
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline);

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');
    await fs.writeFile(filePath, 'column: "Backlog"\nescalation: "Help"\n', 'utf-8');

    await sync.handleFileChange(ticket.id, filePath, pipeline); // drain
    await sync.handleFileChange(ticket.id, filePath, pipeline); // first escalation
    await sync.handleFileChange(ticket.id, filePath, pipeline); // same message again

    expect(onEscalation).toHaveBeenCalledTimes(1);
  });

  it('fires escalation again if message changes', async () => {
    const ticket = makeTicket();
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline);

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');

    await fs.writeFile(filePath, 'column: "Backlog"\nescalation: "Help 1"\n', 'utf-8');
    await sync.handleFileChange(ticket.id, filePath, pipeline); // drain
    await sync.handleFileChange(ticket.id, filePath, pipeline);

    await fs.writeFile(filePath, 'column: "Backlog"\nescalation: "Help 2"\n', 'utf-8');
    await sync.handleFileChange(ticket.id, filePath, pipeline);

    expect(onEscalation).toHaveBeenCalledTimes(2);
    expect(onEscalation).toHaveBeenCalledWith('tkt-1', 'Help 1');
    expect(onEscalation).toHaveBeenCalledWith('tkt-1', 'Help 2');
  });

  // --- Self-write ignore (pendingIgnores) ---

  it('ignores changes consumed by pendingIgnores', async () => {
    const ticket = makeTicket();
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline); // pendingIgnores = 1

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');
    await fs.writeFile(filePath, 'column: "Done"\n', 'utf-8');

    // First call consumed by pendingIgnores
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onColumnChange).not.toHaveBeenCalled();

    // Second call fires callback
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onColumnChange).toHaveBeenCalledWith('tkt-1', 'done');
  });

  it('updateColumn increments pendingIgnores', async () => {
    const ticket = makeTicket({ columnId: 'backlog' });
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline); // pendingIgnores = 1

    const updated = makeTicket({ columnId: 'in_progress' });
    await sync.updateColumn(updated, pipeline); // pendingIgnores = 2

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');
    await fs.writeFile(filePath, 'column: "Done"\n', 'utf-8');

    // Two calls consumed by pendingIgnores
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onColumnChange).not.toHaveBeenCalled();

    // Third call fires
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onColumnChange).toHaveBeenCalledWith('tkt-1', 'done');
  });

  // --- updateColumn ---

  it('updateColumn writes new content', async () => {
    const ticket = makeTicket({ columnId: 'backlog' });
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline);

    const updated = makeTicket({ columnId: 'in_progress' });
    await sync.updateColumn(updated, pipeline);

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('column: "In Progress"');
  });

  it('updateColumn clears lastEscalation tracking', async () => {
    const ticket = makeTicket();
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline);

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');

    // Agent escalates
    await fs.writeFile(filePath, 'column: "Backlog"\nescalation: "Help"\n', 'utf-8');
    await sync.handleFileChange(ticket.id, filePath, pipeline); // drain
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onEscalation).toHaveBeenCalledTimes(1);

    // Orchestrator updates column (clears lastEscalation)
    await sync.updateColumn(ticket, pipeline);

    // Same escalation message now fires again because tracking was cleared
    await fs.writeFile(filePath, 'column: "Backlog"\nescalation: "Help"\n', 'utf-8');
    await sync.handleFileChange(ticket.id, filePath, pipeline); // drain updateColumn's pendingIgnore
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onEscalation).toHaveBeenCalledTimes(2);
  });

  // --- stopWatching / dispose ---

  it('stopWatching removes the entry so handleFileChange is a no-op', async () => {
    const ticket = makeTicket();
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline);

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');
    sync.stopWatching(ticket.id);

    await fs.writeFile(filePath, 'column: "Done"\n', 'utf-8');
    await sync.handleFileChange(ticket.id, filePath, pipeline);

    expect(onColumnChange).not.toHaveBeenCalled();
  });

  it('dispose clears all entries', async () => {
    const t1 = makeTicket({ id: 'tkt-1' });
    const t2 = makeTicket({ id: 'tkt-2' });
    const pipeline = makePipeline();
    await sync.writeAndWatch(t1, pipeline);
    await sync.writeAndWatch(t2, pipeline);

    sync.dispose();

    const f1 = path.join(tmpDir, 'fleet/tickets', t1.id, 'TICKET.yaml');
    await fs.writeFile(f1, 'column: "Done"\n', 'utf-8');
    await sync.handleFileChange(t1.id, f1, pipeline);
    await sync.handleFileChange(t2.id, f1, pipeline);

    expect(onColumnChange).not.toHaveBeenCalled();
  });

  // --- No entry ---

  it('handleFileChange is a no-op for unknown ticket', async () => {
    const pipeline = makePipeline();
    await sync.handleFileChange('unknown-id', '/tmp/nonexistent', pipeline);
    expect(onColumnChange).not.toHaveBeenCalled();
    expect(onEscalation).not.toHaveBeenCalled();
  });

  // --- Second writeAndWatch reuses watcher ---

  it('second writeAndWatch increments pendingIgnores on existing entry', async () => {
    const ticket = makeTicket();
    const pipeline = makePipeline();
    await sync.writeAndWatch(ticket, pipeline); // pendingIgnores = 1
    await sync.writeAndWatch(ticket, pipeline); // pendingIgnores = 2

    const filePath = path.join(tmpDir, 'fleet/tickets', ticket.id, 'TICKET.yaml');
    await fs.writeFile(filePath, 'column: "Done"\n', 'utf-8');

    // First two calls consumed
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onColumnChange).not.toHaveBeenCalled();

    // Third fires
    await sync.handleFileChange(ticket.id, filePath, pipeline);
    expect(onColumnChange).toHaveBeenCalledWith('tkt-1', 'done');
  });
});
