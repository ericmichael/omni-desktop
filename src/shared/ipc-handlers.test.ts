import { describe, expect, it } from 'vitest';

import { registerConfigHandlers } from '@/shared/ipc-handlers';
import type { IIpcListener } from '@/shared/ipc-listener';

/**
 * Stub listener that records handlers so tests can invoke them directly.
 * This lets us verify the shared registration wires `validateConfigPath`
 * into the read/write handlers without spinning up Electron or the server.
 */
class StubIpc implements IIpcListener {
  public readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, handler);
  }

  invoke(channel: string, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler for ${channel}`);
    }
    return handler(null, ...args);
  }
}

describe('registerConfigHandlers', () => {
  it('registers the expected config channels', () => {
    const ipc = new StubIpc();
    registerConfigHandlers(ipc, '/tmp/omni-config');
    expect(ipc.handlers.has('config:get-omni-config-dir')).toBe(true);
    expect(ipc.handlers.has('config:get-env-file-path')).toBe(true);
    expect(ipc.handlers.has('config:read-json-file')).toBe(true);
    expect(ipc.handlers.has('config:write-json-file')).toBe(true);
    expect(ipc.handlers.has('config:read-text-file')).toBe(true);
    expect(ipc.handlers.has('config:write-text-file')).toBe(true);
  });

  it('validateConfigPath is enforced on read-json-file', async () => {
    const ipc = new StubIpc();
    registerConfigHandlers(ipc, '/tmp/omni-config');
    // A path outside the config dir must be rejected.
    await expect(ipc.invoke('config:read-json-file', '/etc/passwd')).rejects.toThrow();
  });

  it('validateConfigPath is enforced on write-text-file', async () => {
    const ipc = new StubIpc();
    registerConfigHandlers(ipc, '/tmp/omni-config');
    await expect(ipc.invoke('config:write-text-file', '/etc/shadow', 'evil')).rejects.toThrow();
  });

  it('config:get-omni-config-dir returns the supplied dir', () => {
    const ipc = new StubIpc();
    registerConfigHandlers(ipc, '/tmp/omni-config');
    expect(ipc.invoke('config:get-omni-config-dir')).toBe('/tmp/omni-config');
  });
});
