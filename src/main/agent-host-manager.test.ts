import { describe, expect, it, vi } from 'vitest';

import { AgentHostManager } from '@/main/agent-host-manager';

describe('AgentHostManager', () => {
  it('attaches compatible consumers to one host', () => {
    const manager = new AgentHostManager<object>();
    const create = vi.fn(() => ({}));

    const first = manager.attach('tab-a', 'compatible', create);
    const second = manager.attach('tab-b', 'compatible', create);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.host).toBe(first.host);
    expect(create).toHaveBeenCalledTimes(1);
    expect(manager.consumersForHost(first.host)).toEqual(['tab-a', 'tab-b']);
  });

  it('only releases a host after its final consumer detaches', () => {
    const manager = new AgentHostManager<object>();
    const host = manager.attach('tab-a', 'compatible', () => ({})).host;
    manager.attach('tab-b', 'compatible', () => ({}));

    expect(manager.detach('tab-a')).toEqual({ host, lastConsumer: false });
    expect(manager.detach('tab-b')).toEqual({ host, lastConsumer: true });
    expect(manager.hosts()).toEqual([]);
  });

  it('moves one consumer without releasing a host still used elsewhere', () => {
    const manager = new AgentHostManager<object>();
    const shared = manager.attach('tab-a', 'old', () => ({})).host;
    manager.attach('tab-b', 'old', () => ({}));

    const moved = manager.attach('tab-a', 'new', () => ({}));

    expect(moved.host).not.toBe(shared);
    expect(moved.released).toBeUndefined();
    expect(manager.hostForConsumer('tab-b')).toBe(shared);
    expect(manager.consumersForHost(shared)).toEqual(['tab-b']);
  });

  it('returns a released incompatible host when moving its final consumer', () => {
    const manager = new AgentHostManager<object>();
    const old = manager.attach('tab-a', 'old', () => ({})).host;

    const moved = manager.attach('tab-a', 'new', () => ({}));

    expect(moved.released).toBe(old);
    expect(manager.hosts()).toEqual([moved.host]);
  });

  it('only rekeys an exclusively attached host into a free key', () => {
    const manager = new AgentHostManager<object>();
    const host = manager.attach('tab-a', 'old', () => ({})).host;

    expect(manager.rekey('tab-a', 'new')).toBe(true);
    expect(manager.attach('tab-b', 'new', () => ({})).host).toBe(host);
    expect(manager.rekey('tab-a', 'another')).toBe(false);
  });
});
