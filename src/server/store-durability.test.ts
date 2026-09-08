// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { applyChatCommand } from '@/shared/chat-commands';

import { ServerStore } from './store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('does not publish an in-memory removal when persistence fails', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omni-store-durability-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  const store = new ServerStore(file);
  const tab = { id: 'tab-a', projectId: null, createdAt: 1 };
  store.set('codeTabs', [tab]);
  const notify = vi.fn();
  store.onDidAnyChange(notify);
  mkdirSync(`${file}.tmp`); // force an actual failed write without touching user state
  expect(() => store.set(applyChatCommand(store.store, { method: 'removeTab', args: ['tab-a'] }).patch)).toThrow();
  expect(store.get('codeTabs')).toEqual([tab]);
  expect(store.get('chatCleanupJobs')).toEqual([]);
  expect(new ServerStore(file).get('codeTabs')).toEqual([tab]);
  expect(notify).not.toHaveBeenCalled();
});
