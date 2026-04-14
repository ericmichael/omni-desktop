import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import type { TicketMachineCallbacks } from '@/main/ticket-machine';
import { TicketMachine } from '@/main/ticket-machine';
import type { TicketPhase } from '@/shared/ticket-phase';

// --- Test WS server helpers ---

let wss: WebSocketServer | null = null;
let serverPort = 0;

type RpcHandler = (method: string, params: Record<string, unknown>, id: string) => unknown;

const startServer = (handler: RpcHandler): Promise<string> =>
  new Promise((resolve) => {
    wss = new WebSocketServer({ port: 0 });
    wss.on('listening', () => {
      const addr = wss!.address();
      serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve(`ws://127.0.0.1:${serverPort}`);
    });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { id?: string; method?: string; params?: Record<string, unknown> };
        if (msg.id && msg.method) {
          const result = handler(msg.method, msg.params ?? {}, msg.id);
          ws.send(JSON.stringify({ id: msg.id, result }));
        }
      });
    });
  });

const stopServer = (): Promise<void> =>
  new Promise((resolve) => {
    if (wss) {
      // Force-close all open connections so the server can shut down immediately
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close(() => resolve());
      wss = null;
    } else {
      resolve();
    }
  });

// Send a JSON-RPC notification to all connected clients
const broadcastNotification = (method: string, params: Record<string, unknown>): void => {
  if (!wss) {
return;
}
  const msg = JSON.stringify({ method, params });
  for (const client of wss.clients) {
    client.send(msg);
  }
};

// --- Callback helpers ---

const makeCallbacks = (): TicketMachineCallbacks & {
  phases: TicketPhase[];
  messages: { role: string; content: string }[];
  runEnds: string[];
} => {
  const phases: TicketPhase[] = [];
  const messages: { role: string; content: string }[] = [];
  const runEnds: string[] = [];

  return {
    phases,
    messages,
    runEnds,
    onPhaseChange: (_id, phase) => phases.push(phase),
    onMessage: (_id, msg) => messages.push({ role: msg.role, content: msg.content }),
    onRunEnd: (_id, reason) => runEnds.push(reason),
    onTokenUsage: vi.fn(),
  };
};

// --- Tests ---

describe('TicketMachine', () => {
  let wsUrl: string;

  afterEach(async () => {
    await stopServer();
    vi.restoreAllMocks();
  });

  // #region Phase transitions (no WS needed)

  describe('phase transitions', () => {
    it('starts in idle phase', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      expect(m.getPhase()).toBe('idle');
      expect(m.isActive()).toBe(false);
      expect(m.isStreaming()).toBe(false);
    });

    it('transition() broadcasts phase change on valid transition', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      expect(m.getPhase()).toBe('provisioning');
      expect(cb.phases).toEqual(['provisioning']);
    });

    it('transition() ignores invalid transitions and logs warning', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      m.transition('running'); // idle → running is invalid
      expect(m.getPhase()).toBe('idle');
      expect(cb.phases).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    });

    it('transition() is a no-op for same phase', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('idle');
      expect(cb.phases).toEqual([]); // no callback fired
    });

    it('forcePhase() bypasses validation', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.forcePhase('running'); // idle → running would be invalid
      expect(m.getPhase()).toBe('running');
      expect(cb.phases).toEqual(['running']);
    });

    it('isActive() returns true for active phases', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.forcePhase('provisioning');
      expect(m.isActive()).toBe(true);
      m.forcePhase('running');
      expect(m.isActive()).toBe(true);
      m.forcePhase('error');
      expect(m.isActive()).toBe(false);
    });

    it('isStreaming() returns true only for running/continuing', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.forcePhase('running');
      expect(m.isStreaming()).toBe(true);
      m.forcePhase('continuing');
      expect(m.isStreaming()).toBe(true);
      m.forcePhase('ready');
      expect(m.isStreaming()).toBe(false);
    });
  });

  // #endregion

  // #region Full lifecycle with WS server

  describe('createSession', () => {
    it('transitions provisioning → connecting → session_creating → ready', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);

      const sessionId = await m.createSession({ foo: 'bar' });

      expect(sessionId).toBe('sess-1');
      expect(m.getPhase()).toBe('ready');
      expect(m.getSessionId()).toBe('sess-1');
      // provisioning was done before createSession, so phases from createSession are:
      expect(cb.phases).toEqual(['provisioning', 'connecting', 'session_creating', 'ready']);
    });

    it('transitions to error when RPC returns error', async () => {
      wsUrl = await startServer(() => {
        // Return an object that has error property — but ws server helper puts it in result
        // We need to handle this differently
        return undefined; // no session_id → should error
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);

      await expect(m.createSession()).rejects.toThrow('No session_id');
      expect(m.getPhase()).toBe('error');
    });
  });

  describe('startRun', () => {
    it('transitions to running and returns session/run IDs', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        if (method === 'start_run') {
return { session_id: 'sess-1', run_id: 'run-1' };
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);

      await m.createSession();
      const result = await m.startRun('do the thing');

      expect(result).toEqual({ sessionId: 'sess-1', runId: 'run-1' });
      expect(m.getPhase()).toBe('running');
      expect(m.getRunId()).toBe('run-1');
    });

    it('rejects if phase is idle', async () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      await expect(m.startRun('test')).rejects.toThrow('Cannot start run in phase idle');
    });

    it('allows starting from continuing phase', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        if (method === 'start_run') {
return { session_id: 'sess-1', run_id: 'run-2' };
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);
      await m.createSession();

      // Simulate: after a run completes, ProjectManager sets continuing
      m.forcePhase('continuing');
      const result = await m.startRun('continue');
      expect(result.runId).toBe('run-2');
      expect(m.getPhase()).toBe('running');
    });

    it('allows starting from retrying phase', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        if (method === 'start_run') {
return { session_id: 'sess-1', run_id: 'run-3' };
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);
      await m.createSession();

      m.forcePhase('retrying');
      const result = await m.startRun('retry');
      expect(result.runId).toBe('run-3');
    });

    it('allows starting from awaiting_input phase', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        if (method === 'start_run') {
return { session_id: 'sess-1', run_id: 'run-4' };
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);
      await m.createSession();

      m.forcePhase('awaiting_input');
      const result = await m.startRun('user reply');
      expect(result.runId).toBe('run-4');
    });

    it('transitions to error on RPC failure', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        // start_run returns no session_id
        return undefined;
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);
      await m.createSession();

      await expect(m.startRun('test')).rejects.toThrow('No session_id');
      expect(m.getPhase()).toBe('error');
    });
  });

  describe('run_end notification', () => {
    it('fires onRunEnd callback and clears runId', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        if (method === 'start_run') {
return { session_id: 'sess-1', run_id: 'run-1' };
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);
      await m.createSession();
      await m.startRun('go');

      expect(m.getRunId()).toBe('run-1');

      // Simulate server sending run_end
      broadcastNotification('run_end', { reason: 'completed' });

      // Wait for the notification to be processed
      await new Promise((r) => setTimeout(r, 50));

      expect(m.getRunId()).toBeNull();
      expect(cb.runEnds).toEqual(['completed']);
      // Phase is NOT changed by the machine — ProjectManager decides
      expect(m.getPhase()).toBe('running');
    });
  });

  describe('message_output notification', () => {
    it('fires onMessage callback with content', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        if (method === 'start_run') {
return { session_id: 'sess-1', run_id: 'run-1' };
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);
      await m.createSession();
      await m.startRun('go');

      broadcastNotification('message_output', { content: 'Hello world', role: 'assistant' });
      await new Promise((r) => setTimeout(r, 50));

      expect(cb.messages).toEqual([{ role: 'assistant', content: 'Hello world' }]);
    });

    it('maps tool_name to tool_call role', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        if (method === 'start_run') {
return { session_id: 'sess-1', run_id: 'run-1' };
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);
      await m.createSession();
      await m.startRun('go');

      broadcastNotification('message_output', {
        content: 'reading file.ts',
        role: 'assistant',
        tool_name: 'Read',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(cb.messages[0]!.role).toBe('tool_call');
    });

    it('updates lastActivity on message', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        if (method === 'start_run') {
return { session_id: 'sess-1', run_id: 'run-1' };
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);
      await m.createSession();
      await m.startRun('go');

      const before = m.getLastActivity();
      await new Promise((r) => setTimeout(r, 20));

      broadcastNotification('message_output', { content: 'ping', role: 'assistant' });
      await new Promise((r) => setTimeout(r, 50));

      expect(m.getLastActivity()).toBeGreaterThan(before);
    });
  });

  // #endregion

  // #region Serialization (mutex)

  describe('serialize (mutex)', () => {
    it('serializes concurrent createSession + startRun', async () => {
      const callOrder: string[] = [];
      wsUrl = await startServer((method) => {
        callOrder.push(method);
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        if (method === 'start_run') {
return { session_id: 'sess-1', run_id: 'run-1' };
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);

      // Fire both without awaiting — they should serialize
      const p1 = m.createSession();
      const p2 = m.startRun('go');

      await p1;
      await p2;

      // server_call (session.ensure) must come before start_run
      expect(callOrder.indexOf('server_call')).toBeLessThan(callOrder.indexOf('start_run'));
      expect(m.getPhase()).toBe('running');
    });
  });

  // #endregion

  // #region stop() and dispose()

  describe('stop', () => {
    it('transitions to idle and clears runId', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        if (method === 'start_run') {
return { session_id: 'sess-1', run_id: 'run-1' };
}
        if (method === 'stop_run') {
return {};
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);
      await m.createSession();
      await m.startRun('go');

      await m.stop();
      expect(m.getPhase()).toBe('idle');
      expect(m.getRunId()).toBeNull();
    });

    it('cancels retry timer on stop', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.forcePhase('running');

      const timerCb = vi.fn();
      m.scheduleRetryTimer(60_000, timerCb);
      expect(m.getPhase()).toBe('retrying');

      m.forcePhase('retrying'); // keep in retrying for stop
      void m.stop();

      expect(m.retryTimer).toBeNull();
    });

    it('is safe to call when already idle', async () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      await m.stop(); // should not throw
      expect(m.getPhase()).toBe('idle');
    });
  });

  describe('dispose', () => {
    it('closes WebSocket and force-sets idle', async () => {
      wsUrl = await startServer((method) => {
        if (method === 'server_call') {
return { session_id: 'sess-1' };
}
        if (method === 'start_run') {
return { session_id: 'sess-1', run_id: 'run-1' };
}
        if (method === 'stop_run') {
return {};
}
        return {};
      });
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.transition('provisioning');
      m.setWsUrl(wsUrl);
      await m.createSession();
      await m.startRun('go');

      await m.dispose();
      expect(m.getPhase()).toBe('idle');
      expect(m.getRunId()).toBeNull();
    });
  });

  // #endregion

  // #region Retry timer

  describe('retry timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('scheduleRetryTimer transitions to retrying and fires callback after delay', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.forcePhase('running');

      const retryCb = vi.fn();
      m.scheduleRetryTimer(5_000, retryCb);

      expect(m.getPhase()).toBe('retrying');
      expect(retryCb).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5_000);
      expect(retryCb).toHaveBeenCalledOnce();
      expect(m.retryTimer).toBeNull();
    });

    it('cancelRetryTimer prevents callback from firing', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.forcePhase('running');

      const retryCb = vi.fn();
      m.scheduleRetryTimer(5_000, retryCb);
      m.cancelRetryTimer();

      vi.advanceTimersByTime(10_000);
      expect(retryCb).not.toHaveBeenCalled();
    });

    it('scheduling a new timer cancels the previous one', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.forcePhase('running');

      const first = vi.fn();
      const second = vi.fn();
      m.scheduleRetryTimer(5_000, first);
      m.forcePhase('running'); // reset to allow retrying transition again
      m.scheduleRetryTimer(3_000, second);

      vi.advanceTimersByTime(5_000);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });
  });

  // #endregion

  // #region Activity tracking

  describe('activity tracking', () => {
    it('recordActivity updates timestamp', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      const before = m.getLastActivity();

      // Advance time slightly
      vi.useFakeTimers();
      vi.advanceTimersByTime(100);
      m.recordActivity();
      expect(m.getLastActivity()).toBeGreaterThan(before);
      vi.useRealTimers();
    });
  });

  // #endregion

  // #region Counter management

  describe('counter management', () => {
    it('resetCounters clears retry and continuation state', () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.retryAttempt = 3;
      m.continuationTurn = 5;
      m.resetCounters();
      expect(m.retryAttempt).toBe(0);
      expect(m.continuationTurn).toBe(0);
    });
  });

  // #endregion

  // #region Connection edge cases

  describe('connection edge cases', () => {
    it('allows createSession from idle phase (e.g. after session reset)', async () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.setWsUrl('ws://127.0.0.1:1');
      // Should attempt to connect (not reject with phase error) — idle → connecting is valid
      await expect(m.createSession()).rejects.toThrow(/WebSocket/);
    });

    it('rejects createSession when in error phase', async () => {
      const cb = makeCallbacks();
      const m = new TicketMachine('t1', cb);
      m.forcePhase('error');
      m.setWsUrl('ws://127.0.0.1:1');
      await expect(m.createSession()).rejects.toThrow('Cannot connect in phase error');
    });
  });

  // #endregion
});
