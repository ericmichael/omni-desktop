import { beforeEach, expect, it, vi } from 'vitest';

import { probeRealtimeCapabilities } from './realtime-capabilities';

const fake = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), capabilities: vi.fn(), created: vi.fn() }));
vi.mock('./rpc/realtime', () => ({
  RealtimeRPCClient: class {
    constructor() {
      fake.created();
    }
    connect = fake.connect;
    disconnect = fake.disconnect;
    capabilities = fake.capabilities;
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  fake.connect.mockResolvedValue(undefined);
  fake.capabilities.mockResolvedValue({ enabled: true });
});

it('closes a completed probe', async () => {
  await expect(probeRealtimeCapabilities('ws://test', undefined, new AbortController().signal)).resolves.toBe(true);
  expect(fake.disconnect).toHaveBeenCalledOnce();
});

it('closes even when the initial connection fails', async () => {
  fake.connect.mockRejectedValue(new Error('failed'));
  await expect(probeRealtimeCapabilities('ws://test', undefined, new AbortController().signal)).rejects.toThrow(
    'failed'
  );
  expect(fake.disconnect).toHaveBeenCalledOnce();
});

it('does not create a socket after its owner was cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(probeRealtimeCapabilities('ws://test', undefined, controller.signal)).rejects.toThrow();
  expect(fake.created).not.toHaveBeenCalled();
});

it.each(['connect', 'capabilities'] as const)(
  'disconnects an in-flight %s when its owner is cancelled',
  async (phase) => {
    const controller = new AbortController();
    let release!: (value: unknown) => void;
    fake[phase].mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = probeRealtimeCapabilities('ws://test', undefined, controller.signal);
    await vi.waitFor(() => expect(fake[phase]).toHaveBeenCalledOnce());
    controller.abort();
    expect(fake.disconnect).toHaveBeenCalledOnce();
    release({ enabled: true });
    await expect(pending).rejects.toThrow();
    expect(fake.disconnect).toHaveBeenCalledOnce();
  }
);
