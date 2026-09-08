import { atom } from 'nanostores';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('@/renderer/services/store', () => ({
  $initialized: atom(false),
  $operatingSystem: atom(undefined),
  $initializationError: atom<string | null>(null),
}));

import { $initializationError } from '@/renderer/services/store';

import { SystemInfoLoadingGate, SystemInfoProvider } from './SystemInfoContext';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('exposes failed startup before authentication or application content can mount', async () => {
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <SystemInfoProvider>
          <SystemInfoLoadingGate>Private application</SystemInfoLoadingGate>
        </SystemInfoProvider>
      )
    );
    await act(async () => $initializationError.set('Credentials rejected'));
    expect(node.textContent).toContain('Unable to start Omni');
    expect(node.textContent).toContain('Credentials rejected');
    expect(node.textContent).toContain('Reload');
    expect(node.textContent).not.toContain('Private application');
    expect(node.querySelector('[role="status"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    $initializationError.set(null);
  }
});
