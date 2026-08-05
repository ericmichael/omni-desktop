import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class ResizeObserverStub implements ResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ContextEditor', () => {
  it('renders markdown through the official Yoopta shadcn theme', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      if (!String(message).includes('Could not parse CSS stylesheet')) {
        throw message;
      }
    });
    const { ContextEditor } = await import('./ContextEditor');

    await act(async () => {
      root.render(<ContextEditor initialMarkdown="Project context" onChangeMarkdown={() => {}} />);
    });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Project context');
    expect(container.querySelector('.yoopta-editor')).not.toBeNull();
  });
});
