import { describe, expect, it, vi } from 'vitest';

import {
  dispatchOpenFileIntent,
  type OpenFileResult,
  registerOpenFileTarget,
  subscribeOpenFileResults,
} from './open-file-intent';

describe('open-file intents', () => {
  it('routes an exact session, path, and range to the registered Files target', async () => {
    const target = vi.fn(
      async ({ requestId, intent }): Promise<OpenFileResult> => ({
        status: 'opened',
        requestId,
        sessionId: intent.sessionId,
        path: intent.path,
        location: intent.location,
      })
    );
    const unregister = registerOpenFileTarget('session-1', target);

    const result = await dispatchOpenFileIntent(
      {
        sessionId: 'session-1',
        path: 'src/app.ts',
        location: { line: 4, column: 3, endLine: 6, endColumn: 8 },
        source: 'git-diff',
      },
      { waitForTargetMs: 0 }
    );

    expect(result).toMatchObject({
      status: 'opened',
      sessionId: 'session-1',
      path: 'src/app.ts',
      location: { line: 4, column: 3, endLine: 6, endColumn: 8 },
    });
    expect(target).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^open-file-/),
        intent: expect.objectContaining({ source: 'git-diff' }),
      })
    );
    unregister();
  });

  it('waits for a Files target mounted after its column is activated', async () => {
    const pending = dispatchOpenFileIntent(
      { sessionId: 'session-later', path: 'README.md', source: 'artifact' },
      { waitForTargetMs: 100 }
    );
    const unregister = registerOpenFileTarget('session-later', async ({ requestId, intent }) => ({
      status: 'opened',
      requestId,
      sessionId: intent.sessionId,
      path: intent.path,
    }));

    await expect(pending).resolves.toMatchObject({ status: 'opened', path: 'README.md' });
    unregister();
  });

  it.each([
    [{ sessionId: 'session-1', path: '../secret' }, 'invalid-path'],
    [{ sessionId: 'session-1', path: '.' }, 'invalid-path'],
    [{ sessionId: '', path: 'src/app.ts' }, 'invalid-intent'],
    [{ sessionId: 'session-1', path: 'src/app.ts', location: { line: 0 } }, 'invalid-intent'],
    [{ sessionId: 'session-1', path: 'src/app.ts', location: { line: 4, endLine: 3 } }, 'invalid-intent'],
  ] as const)('rejects invalid input %# without invoking a target', async (intent, reason) => {
    const target = vi.fn();
    const unregister = registerOpenFileTarget('session-1', target);

    await expect(dispatchOpenFileIntent(intent, { waitForTargetMs: 0 })).resolves.toMatchObject({
      status: 'failed',
      reason,
    });
    expect(target).not.toHaveBeenCalled();
    unregister();
  });

  it('fails clearly for an unknown or unmounted session and publishes the result event', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOpenFileResults(listener);

    const result = await dispatchOpenFileIntent(
      { sessionId: 'unknown-session', path: 'src/app.ts', source: 'tool-result' },
      { waitForTargetMs: 0 }
    );

    expect(result).toMatchObject({ status: 'failed', reason: 'unknown-session' });
    expect(listener).toHaveBeenCalledWith({
      intent: expect.objectContaining({ source: 'tool-result' }),
      result,
    });
    unsubscribe();
  });

  it('restores the previous target when a newer surface for the same session unmounts', async () => {
    const first = vi.fn(async ({ requestId, intent }) => ({
      status: 'opened' as const,
      requestId,
      sessionId: intent.sessionId,
      path: intent.path,
    }));
    const second = vi.fn(async ({ requestId, intent }) => ({
      status: 'opened' as const,
      requestId,
      sessionId: intent.sessionId,
      path: intent.path,
    }));
    const unregisterFirst = registerOpenFileTarget('shared-session', first);
    const unregisterSecond = registerOpenFileTarget('shared-session', second);

    await dispatchOpenFileIntent({ sessionId: 'shared-session', path: 'one.ts' }, { waitForTargetMs: 0 });
    expect(second).toHaveBeenCalledOnce();
    unregisterSecond();
    await dispatchOpenFileIntent({ sessionId: 'shared-session', path: 'two.ts' }, { waitForTargetMs: 0 });
    expect(first).toHaveBeenCalledOnce();
    unregisterFirst();
  });
});
