import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ invoke: vi.fn(), changed: undefined as undefined | ((auth: unknown) => void) }));
vi.mock('@/renderer/services/ipc', () => ({
  emitter: { invoke: mock.invoke },
  ipc: {
    on: (_event: string, cb: (auth: unknown) => void) => {
      mock.changed = cb;
      return () => {
        mock.changed = undefined;
      };
    },
  },
}));

import { AuthGate } from './AuthGate';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mock.invoke.mockReset();
  node = document.createElement('div');
  document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
});

it('does not let an old credential read overwrite a newer sign-out event', async () => {
  let finish!: (auth: unknown) => void;
  mock.invoke.mockImplementation((method) =>
    method === 'platform:is-enterprise'
      ? Promise.resolve(true)
      : new Promise((resolve) => {
          finish = resolve;
        })
  );
  await act(async () =>
    root.render(
      <AuthGate>
        <span>Private application</span>
      </AuthGate>
    )
  );
  await act(async () => {
    mock.changed?.(null);
    finish({ accessToken: 'stale-test-credential' });
  });
  expect(node.textContent).not.toContain('Private application');
  expect(node.textContent).toContain('Sign in to Omni Code');
});

it('shows a recoverable error instead of an endless spinner when bootstrap is rejected', async () => {
  mock.invoke.mockRejectedValue(new Error('Sign in again to reconnect'));
  await act(async () =>
    root.render(
      <AuthGate>
        <span>Private application</span>
      </AuthGate>
    )
  );
  expect(node.textContent).toContain('Unable to check sign-in status');
  expect(node.textContent).toContain('Sign in again to reconnect');
  expect(node.textContent).toContain('Reload');
  expect(node.textContent).not.toContain('Private application');
});
