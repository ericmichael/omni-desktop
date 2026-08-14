import { describe, expect, it, vi } from 'vitest';

import { AutomationManager } from '@/main/automation-manager';
import type { Automation, ChatEvent, ResidentChannelMessage, StoreData } from '@/shared/types';

const NOW = Date.parse('2026-08-13T12:00:00Z');

const makeManager = (overrides: { now?: () => number } = {}) => {
  const data = new Map<string, unknown>();
  let chatCb: ((event: ChatEvent) => void) | null = null;
  const deliver = vi.fn();
  const manager = new AutomationManager({
    store: {
      get: (key: string) => data.get(key),
      set: (key: string, value: unknown) => data.set(key, value),
    } as never,
    deliver,
    subscribeChatEvents: (cb) => {
      chatCb = cb;
      return () => {
        chatCb = null;
      };
    },
    now: overrides.now ?? (() => NOW),
  });
  const emitChat = (message: Partial<ResidentChannelMessage>): void => {
    chatCb?.({
      method: 'chat.message_added',
      params: { message: { id: 1, channel: 'team', from: 'user', text: 'hi', at: NOW, ...message } },
    });
  };
  return { manager, deliver, emitChat, data };
};

const stored = (data: Map<string, unknown>): Automation[] => (data.get('automations') as Automation[]) ?? [];

describe('AutomationManager', () => {
  it('creates, lists, updates, deletes', () => {
    const { manager } = makeManager();
    const a = manager.create({
      name: ' Fix CI ',
      trigger: { kind: 'pr_event', events: ['ci_failed'] },
      agentId: 'res_1',
      instruction: ' fix it ',
    });
    expect(a).toMatchObject({ name: 'Fix CI', instruction: 'fix it', enabled: true });
    expect(manager.list()).toHaveLength(1);
    const updated = manager.update(a.id, { enabled: false });
    expect(updated.enabled).toBe(false);
    manager.delete(a.id);
    expect(manager.list()).toHaveLength(0);
    expect(() => manager.update('nope', {})).toThrow(/Unknown automation/);
  });

  it('fires matching pr_event rules and records the firing', () => {
    const { manager, deliver, data } = makeManager();
    manager.create({
      name: 'Fix CI',
      trigger: { kind: 'pr_event', events: ['ci_failed'], repo: 'acme/' },
      agentId: 'res_1',
      instruction: 'address the failure and push',
    });
    manager.create({
      name: 'Other repo only',
      trigger: { kind: 'pr_event', repo: 'zzz/none' },
      agentId: 'res_2',
      instruction: 'never fires',
    });
    manager.onPullRequestEvent({ kind: 'ci_failed', url: 'u', number: 142, repo: 'acme/launcher' });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith('res_1', expect.stringContaining('automation "Fix CI" fired'));
    expect(deliver).toHaveBeenCalledWith('res_1', expect.stringContaining('address the failure and push'));
    const rec = stored(data).find((x) => x.name === 'Fix CI')!;
    expect(rec).toMatchObject({ fireCount: 1, lastFiredAt: NOW });
    expect(rec.lastFiredSummary).toContain('PR #142');
  });

  it('disabled rules never fire', () => {
    const { manager, deliver } = makeManager();
    const a = manager.create({
      name: 'Off',
      trigger: { kind: 'pr_event' },
      agentId: 'res_1',
      instruction: 'x',
      enabled: false,
    });
    manager.onPullRequestEvent({ kind: 'merged', url: 'u', number: 1, repo: 'a/b' });
    expect(deliver).not.toHaveBeenCalled();
    manager.update(a.id, { enabled: true });
    manager.onPullRequestEvent({ kind: 'merged', url: 'u', number: 1, repo: 'a/b' });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('channel_message rules fire on human posts only, with a cooldown', () => {
    let now = NOW;
    const { manager, deliver, emitChat } = makeManager({ now: () => now });
    manager.start();
    manager.create({
      name: 'Deploy watch',
      trigger: { kind: 'channel_message', channel: 'team', contains: 'deploy' },
      agentId: 'res_1',
      instruction: 'run the deploy checklist',
    });

    emitChat({ text: 'please deploy the fix' });
    expect(deliver).toHaveBeenCalledTimes(1);
    // Agent post: never triggers.
    emitChat({ from: 'res_9', text: 'deploy done?' });
    expect(deliver).toHaveBeenCalledTimes(1);
    // Within cooldown: suppressed. After: fires again.
    emitChat({ text: 'deploy again' });
    expect(deliver).toHaveBeenCalledTimes(1);
    now = NOW + 61_000;
    emitChat({ text: 'deploy once more' });
    expect(deliver).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it('schedule rules fire when due and advance nextRunAt without catch-up pileup', () => {
    vi.useFakeTimers();
    try {
      let now = NOW;
      const { manager, deliver, data } = makeManager({ now: () => now });
      manager.start();
      const a = manager.create({
        name: 'Standup',
        trigger: { kind: 'schedule', schedule: { kind: 'interval', everyMinutes: 30 } },
        agentId: 'res_1',
        instruction: 'post the standup summary',
      });
      expect(a.nextRunAt).toBe(NOW + 30 * 60_000);

      // Not due yet.
      vi.advanceTimersByTime(60_000);
      expect(deliver).not.toHaveBeenCalled();

      // Jump WELL past several slots (app closed): exactly one firing.
      now = NOW + 3 * 60 * 60_000;
      vi.advanceTimersByTime(60_000);
      expect(deliver).toHaveBeenCalledTimes(1);
      const rec = stored(data)[0]!;
      expect(rec.nextRunAt).toBe(now + 30 * 60_000);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runNow fires regardless of trigger shape', () => {
    const { manager, deliver } = makeManager();
    const a = manager.create({
      name: 'Manual',
      trigger: { kind: 'channel_message', channel: 'team' },
      agentId: 'res_1',
      instruction: 'do the thing',
    });
    const fired = manager.runNow(a.id);
    expect(deliver).toHaveBeenCalledWith('res_1', expect.stringContaining('run manually'));
    expect(fired.fireCount).toBe(1);
  });
});

// Type-only sanity: the store key exists on StoreData.
const _typecheck: StoreData['automations'] = [];
void _typecheck;
