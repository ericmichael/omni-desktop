/**
 * Tests for ProcessManager — mode resolution, status fallback,
 * getRunningWsUrlForTicket, and lifecycle operations.
 *
 * Mocks AgentProcess to avoid real process spawning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  agentProcessInstances: [] as Array<{
    mode: string;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
    rebuild: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    resizePty: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@/main/agent-process', () => ({
  AgentProcess: class MockAgentProcess {
    mode: string;
    start = vi.fn();
    stop = vi.fn(async () => {});
    exit = vi.fn(async () => {});
    rebuild = vi.fn(async () => {});
    getStatus = vi.fn(() => ({ type: 'uninitialized', timestamp: Date.now() }));
    resizePty = vi.fn();

    constructor(opts: { mode: string }) {
      this.mode = opts.mode;
      hoisted.agentProcessInstances.push(this);
    }
  },
}));

vi.mock('@/main/store', () => ({
  store: { get: vi.fn(() => undefined), set: vi.fn() },
  getStore: vi.fn(() => ({ get: vi.fn(() => undefined), set: vi.fn() })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ProcessManager, type ProcessManagerStoreData } from '@/main/process-manager';
import type { AgentProcessStatus, WithTimestamp } from '@/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePm(opts?: { storeData?: Partial<ProcessManagerStoreData> }) {
  hoisted.agentProcessInstances = [];
  const sendCalls: Array<{ channel: string; args: unknown[] }> = [];
  const storeData: ProcessManagerStoreData = {
    sandboxBackend: 'none',
    sandboxProfiles: null,
    selectedMachineId: null,
    ...opts?.storeData,
  };
  const pm = new ProcessManager({
    sendToWindow: ((channel: string, ...args: unknown[]) => {
      sendCalls.push({ channel, args });
    }) as ProcessManager['start'] extends (...args: infer _A) => unknown ? never : never as never,
    getStoreData: () => storeData,
  });
  return { pm, sendCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProcessManager', () => {
  beforeEach(() => {
    hoisted.agentProcessInstances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('mode resolution', () => {
    it.each([
      ['docker', 'sandbox'],
      ['podman', 'podman'],
      ['vm', 'vm'],
      ['local', 'local'],
      ['platform', 'platform'],
      ['none', 'none'],
    ] as const)('sandboxBackend=%s resolves to mode=%s', (backend, expectedMode) => {
      const { pm } = makePm({ storeData: { sandboxBackend: backend } });
      pm.start('test-1', { workspaceDir: '/tmp/ws' });

      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.mode).toBe(expectedMode);
    });
  });

  describe('getStatus', () => {
    it('returns uninitialized for unknown processId', () => {
      const { pm } = makePm();
      const status = pm.getStatus('unknown-id');
      expect(status.type).toBe('uninitialized');
    });

    it('returns status from AgentProcess when process exists', () => {
      const { pm } = makePm();
      pm.start('proc-1', { workspaceDir: '/tmp' });

      const mockStatus: WithTimestamp<AgentProcessStatus> = {
        type: 'running',
        timestamp: 1000,
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
      };
      hoisted.agentProcessInstances[0]!.getStatus.mockReturnValue(mockStatus);

      expect(pm.getStatus('proc-1')).toBe(mockStatus);
    });

    it('uses statusFallback when process does not exist', () => {
      const { pm } = makePm();
      const fallbackStatus: WithTimestamp<AgentProcessStatus> = {
        type: 'running',
        timestamp: 2000,
        data: { wsUrl: 'ws://fallback:9000/ws', uiUrl: 'http://fallback:9000' },
      };
      pm.statusFallback = (id) => (id === 'supervisor-1' ? fallbackStatus : null);

      expect(pm.getStatus('supervisor-1')).toBe(fallbackStatus);
      expect(pm.getStatus('other')).toEqual(expect.objectContaining({ type: 'uninitialized' }));
    });
  });

  describe('getRunningWsUrlForTicket', () => {
    it('returns null when no code tabs match the ticketId', () => {
      const { pm } = makePm();
      const result = pm.getRunningWsUrlForTicket('ticket-1', [
        { id: 'tab-1', ticketId: 'ticket-2' },
        { id: 'tab-2' },
      ]);
      expect(result).toBeNull();
    });

    it('returns null when matching tab has no process', () => {
      const { pm } = makePm();
      const result = pm.getRunningWsUrlForTicket('ticket-1', [{ id: 'tab-1', ticketId: 'ticket-1' }]);
      expect(result).toBeNull();
    });

    it('returns wsUrl when matching tab has a running process', () => {
      const { pm } = makePm();
      pm.start('tab-1', { workspaceDir: '/tmp' });

      hoisted.agentProcessInstances[0]!.getStatus.mockReturnValue({
        type: 'running',
        timestamp: 1000,
        data: { wsUrl: 'ws://localhost:9000/ws', uiUrl: 'http://localhost:9000' },
      });

      const result = pm.getRunningWsUrlForTicket('ticket-1', [{ id: 'tab-1', ticketId: 'ticket-1' }]);
      expect(result).toBe('ws://localhost:9000/ws');
    });

    it('returns null when matching tab process is not running', () => {
      const { pm } = makePm();
      pm.start('tab-1', { workspaceDir: '/tmp' });

      hoisted.agentProcessInstances[0]!.getStatus.mockReturnValue({
        type: 'starting',
        timestamp: 1000,
      });

      const result = pm.getRunningWsUrlForTicket('ticket-1', [{ id: 'tab-1', ticketId: 'ticket-1' }]);
      expect(result).toBeNull();
    });
  });

  describe('lifecycle', () => {
    it('start creates an AgentProcess and calls start', () => {
      const { pm } = makePm();
      pm.start('proc-1', { workspaceDir: '/tmp/ws' });

      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.start).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: '/tmp/ws' })
      );
    });

    it('start reuses existing process on same mode', () => {
      const { pm } = makePm();
      pm.start('proc-1', { workspaceDir: '/tmp/ws' });
      pm.start('proc-1', { workspaceDir: '/tmp/ws2' });

      // Should reuse — only 1 instance created
      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.start).toHaveBeenCalledTimes(2);
    });

    it('start creates new process when mode changes', () => {
      const storeData: ProcessManagerStoreData = {
        sandboxBackend: 'docker',
        sandboxProfiles: null,
        selectedMachineId: null,
      };
      const pm = new ProcessManager({
        sendToWindow: (() => {}) as never,
        getStoreData: () => storeData,
      });

      pm.start('proc-1', { workspaceDir: '/tmp' });
      expect(hoisted.agentProcessInstances).toHaveLength(1);
      expect(hoisted.agentProcessInstances[0]!.mode).toBe('sandbox');

      // Change mode
      storeData.sandboxBackend = 'podman';
      pm.start('proc-1', { workspaceDir: '/tmp' });

      expect(hoisted.agentProcessInstances).toHaveLength(2);
      expect(hoisted.agentProcessInstances[1]!.mode).toBe('podman');
      // Old process should have been exited
      expect(hoisted.agentProcessInstances[0]!.exit).toHaveBeenCalled();
    });

    it('stop removes process from map', async () => {
      const { pm } = makePm();
      pm.start('proc-1', { workspaceDir: '/tmp' });

      await pm.stop('proc-1');

      expect(hoisted.agentProcessInstances[0]!.stop).toHaveBeenCalled();
      // Subsequent getStatus should return uninitialized
      expect(pm.getStatus('proc-1').type).toBe('uninitialized');
    });

    it('stop is a no-op for unknown processId', async () => {
      const { pm } = makePm();
      await pm.stop('unknown'); // should not throw
    });

    it('cleanup exits all processes', async () => {
      const { pm } = makePm();
      pm.start('a', { workspaceDir: '/tmp/a' });
      pm.start('b', { workspaceDir: '/tmp/b' });

      await pm.cleanup();

      expect(hoisted.agentProcessInstances[0]!.exit).toHaveBeenCalled();
      expect(hoisted.agentProcessInstances[1]!.exit).toHaveBeenCalled();
      expect(pm.getStatus('a').type).toBe('uninitialized');
      expect(pm.getStatus('b').type).toBe('uninitialized');
    });
  });

  describe('sandbox profile', () => {
    it('uses variant from selected profile', () => {
      const { pm } = makePm({
        storeData: {
          sandboxBackend: 'platform',
          sandboxProfiles: [
            { resource_id: 42, name: 'GPU', backend: 'platform', variant: 'standard' },
          ],
          selectedMachineId: 42,
        },
      });

      pm.start('proc-1', { workspaceDir: '/tmp' });

      expect(hoisted.agentProcessInstances[0]!.start).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxVariant: 'standard' })
      );
    });

    it('defaults to work variant when no profile selected', () => {
      const { pm } = makePm({ storeData: { sandboxBackend: 'docker' } });
      pm.start('proc-1', { workspaceDir: '/tmp' });

      expect(hoisted.agentProcessInstances[0]!.start).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxVariant: 'work' })
      );
    });
  });
});
