import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { ConversationScrollButton } from './conversation';

vi.mock('use-stick-to-bottom', () => ({
  useStickToBottomContext: () => ({ isAtBottom: false, scrollToBottom: vi.fn() }),
}));

it('gives the jump-to-latest control an accessible name', () => {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<ConversationScrollButton />);
  expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Jump to latest message');
});
