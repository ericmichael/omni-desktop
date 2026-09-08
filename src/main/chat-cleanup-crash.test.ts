// @vitest-environment node
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { ServerStore } from '@/server/store';

it.each(['commit', 'stop', 'delete', 'ack'])(
  'recovers durable cleanup after SIGKILL at %s',
  async (step) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omni-outbox-crash-'));
    const file = path.join(dir, 'config.json');
    const store = new ServerStore(file);
    store.set('codeTabs', [
      { id: 'old-tab', projectId: null, createdAt: 1 },
      { id: 'neighbor', projectId: null, createdAt: 2 },
    ]);
    writeFileSync(`${file}.runtime`, 'runtime');
    writeFileSync(`${file}.snapshot`, 'workspace');
    const spawnWorker = (pause?: string) =>
      fork(
        'node_modules/vite-node/vite-node.mjs',
        [
          '--config',
          'vitest.config.ts',
          'src/main/__fixtures__/cleanup-crash-worker.ts',
          file,
          ...(pause ? [pause] : []),
        ],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] }
      );
    const first = spawnWorker(step);
    let second: ReturnType<typeof fork> | undefined;
    try {
      const [message] = await once(first, 'message');
      expect(message).toEqual({ step });
      const exited = once(first, 'exit');
      first.kill('SIGKILL');
      await exited;
      const afterCrash = new ServerStore(file);
      expect(afterCrash.get('codeTabs').map((tab) => tab.id)).toEqual(['neighbor']);
      expect(afterCrash.get('chatCleanupJobs')).toHaveLength(1);
      second = spawnWorker();
      const [code] = await once(second, 'exit');
      expect(code).toBe(0);
      expect(new ServerStore(file).get('chatCleanupJobs')).toEqual([]);
      expect(existsSync(`${file}.runtime`)).toBe(false);
      expect(existsSync(`${file}.snapshot`)).toBe(false);
    } finally {
      if (first.exitCode === null && first.signalCode === null) {
        first.kill('SIGKILL');
      }
      if (second && second.exitCode === null && second.signalCode === null) {
        second.kill('SIGKILL');
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000
);
