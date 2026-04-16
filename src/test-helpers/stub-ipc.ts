/**
 * Stub IPC listener for handler contract tests.
 *
 * Records handlers in a Map so tests can verify channel registration and
 * invoke handlers directly without Electron or the server runtime.
 */
import type { IIpcListener } from '@/shared/ipc-listener';

export class StubIpc implements IIpcListener {
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
