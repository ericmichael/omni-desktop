// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ call: vi.fn(), close: vi.fn() }));
vi.mock('./agent-host-control-client', () => ({
  AgentHostControlClient: class {
    call = mocks.call;
    close = mocks.close;
  },
}));
import { ChatRuntimeJournal } from './chat-runtime-journal';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-runtime-journal-'));
  dirs.push(dir);
  const journal = new ChatRuntimeJournal(dir);
  const claim = {
    consumerId: 'tab-a',
    workspaceId: 'workspace-a',
    snapshotRef: 'snapshot-a',
    hostId: 'host-a',
    wsUrl: 'ws://localhost:1/ws',
    controlToken: 'test-only-secret',
    pid: process.pid,
  };
  journal.record(claim);
  return { dir, journal, claim };
}
const resources = (state = 'ready', host = 'host-a') => ({
  agent_host_id: host,
  profiles: {},
  workspaces: [{ workspace_id: 'workspace-a', snapshot_ref: 'snapshot-a', sources: [] }],
  environments: [
    { environment_id: 'environment-a', workspace_id: 'workspace-a', generation: 7, state },
    { environment_id: 'environment-b', workspace_id: 'workspace-b', generation: 1, state: 'ready' },
  ],
});

it('recovers the exact workspace through a new journal instance and never stops its neighbor', async () => {
  const f = fixture();
  mocks.call.mockResolvedValueOnce(resources()).mockResolvedValueOnce({}).mockResolvedValueOnce(resources('stopped'));
  await new ChatRuntimeJournal(f.dir).retire('tab-a');
  expect(mocks.call).toHaveBeenCalledWith('agent_host_stop_environment', { environment_id: 'environment-a' });
  expect(mocks.call).not.toHaveBeenCalledWith('agent_host_stop_environment', { environment_id: 'environment-b' });
  expect(readdirSync(f.dir)).toEqual([]);
});

it('persists private credentials with restricted permissions before recovery and retains them on failure', async () => {
  const f = fixture();
  const file = path.join(f.dir, readdirSync(f.dir)[0]!);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, 'utf8'))[0].controlToken).toBe('test-only-secret');
  mocks.call.mockRejectedValueOnce(new Error('offline'));
  await expect(f.journal.retire('tab-a')).rejects.toThrow('offline');
  expect(readdirSync(f.dir)).toHaveLength(1);
});

it('refuses a recycled endpoint serving a different host', async () => {
  const f = fixture();
  mocks.call.mockResolvedValueOnce(resources('ready', 'replacement-host'));
  await expect(f.journal.retire('tab-a')).rejects.toThrow('identity changed');
  expect(mocks.call).toHaveBeenCalledTimes(1);
  expect(readdirSync(f.dir)).toHaveLength(1);
});

it('retains the claim while a stop is still in progress', async () => {
  const f = fixture();
  mocks.call.mockResolvedValueOnce(resources()).mockResolvedValueOnce({}).mockResolvedValueOnce(resources('stopping'));
  await expect(f.journal.retire('tab-a')).rejects.toThrow('not yet confirmed');
  expect(readdirSync(f.dir)).toHaveLength(1);
});

it('recovers a delegated session identity and retains it when its provider rejects shutdown', async () => {
  const f = fixture();
  const stopSession = vi.fn(async () => {}).mockRejectedValueOnce(new Error('provider unavailable'));
  const journal = new ChatRuntimeJournal(
    f.dir,
    () => ({ stopSession }) as unknown as import('./platform-client').IComputeClient
  );
  journal.recordCompute('remote-tab', 'platform', 'remote-session');
  await expect(journal.retire('remote-tab')).rejects.toThrow('provider unavailable');
  expect(readdirSync(f.dir).some((file) => file.endsWith('.compute'))).toBe(true);
  await journal.retire('remote-tab');
  expect(stopSession).toHaveBeenNthCalledWith(1, 'remote-session');
  expect(stopSession).toHaveBeenNthCalledWith(2, 'remote-session');
  expect(readdirSync(f.dir).some((file) => file.endsWith('.compute'))).toBe(false);
});
