import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './Sidebar';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sessions = [
  {
    id: 'thread-1',
    created_at: new Date().toISOString(),
    archived: false,
    message_count: 3,
    title: 'Canonical title',
    pinned: true,
    first_message: { content: 'Canonical title' },
    last_message: { timestamp: new Date().toISOString() },
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((element) => element.remove());
});

describe('conversation Sidebar', () => {
  it('exposes row actions only when canonical conversation management was negotiated', async () => {
    const props = {
      open: true,
      sessions,
      onClose: vi.fn(),
      onNewChat: vi.fn(),
      onSelect: vi.fn(),
    };

    await act(async () => root.render(<Sidebar {...props} />));
    expect(container.querySelector('[aria-label="Conversation actions for Canonical title"]')).toBeNull();

    await act(async () => root.render(<Sidebar {...props} managementSupported />));
    expect(container.querySelector('[aria-label="Conversation actions for Canonical title"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Pinned"]')).not.toBeNull();
  });

  it('uses canonical server search results and reports the query to its controller', async () => {
    const onSearchQueryChange = vi.fn();
    await act(async () =>
      root.render(
        <Sidebar
          open
          sessions={sessions}
          onClose={vi.fn()}
          onNewChat={vi.fn()}
          onSelect={vi.fn()}
          managementSupported
          onSearchQueryChange={onSearchQueryChange}
          searchResults={[
            {
              ...sessions[0]!,
              id: 'thread-2',
              title: 'Server result',
              first_message: { content: 'Server result' },
              searchPreview: 'matched transcript text',
            },
          ]}
        />
      )
    );

    const input = container.querySelector('input[placeholder="Search conversations…"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'transcript');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onSearchQueryChange).toHaveBeenCalledWith('transcript');
    expect(container.textContent).toContain('Server result');
    expect(container.textContent).toContain('matched transcript text');
    expect(container.textContent).not.toContain('Canonical title');
  });
});
