import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('ArtifactAction', () => {
  it('composes a tooltip action with the stock trigger without an invalid ref', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    const { ArtifactAction } = await import('./artifact');
    const container = document.createElement('div');
    const root = createRoot(container);
    const onClick = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    act(() => {
      root.render(
        <ArtifactAction label="Download" onClick={onClick} tooltip="Download artifact">
          Download
        </ArtifactAction>
      );
    });

    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.dataset.slot).toBe('artifact-action');
    expect(button?.dataset.variant).toBe('ghost');
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('Function components cannot be given refs');

    act(() => root.unmount());
    consoleError.mockRestore();
  });
});
