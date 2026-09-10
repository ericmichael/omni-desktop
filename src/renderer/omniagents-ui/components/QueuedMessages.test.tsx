import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { QueuedMessage } from '@/renderer/omniagents-ui/rpc/client';

import { QueuedMessages } from './QueuedMessages';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const base: QueuedMessage = {
  id: 'mine',
  content: 'Follow-up question',
  role: 'user',
  trigger_run: true,
  variables: null,
  safe_tool_overrides: null,
  source: 'ui',
  enqueued_at: 1,
};

it('lists only the user’s own messages and always lets them be cancelled', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onCancel = vi.fn();
  const backend: QueuedMessage[] = [
    { ...base, id: 'notif', role: 'assistant', source: 'notifications:batch', content: 'worker finished' },
    { ...base, id: 'tick', role: 'user', source: 'goal.start', content: 'goal framing prompt' },
  ];
  try {
    act(() => root.render(<QueuedMessages items={backend} onCancel={onCancel} />));
    expect(container.textContent).toBe('');

    act(() => root.render(<QueuedMessages items={[...backend, base]} onCancel={onCancel} />));
    expect(container.textContent).toContain('1 queued');
    expect(container.textContent).toContain('Follow-up question');
    expect(container.textContent).not.toContain('worker finished');
    expect(container.textContent).not.toContain('goal framing prompt');

    const cancel = container.querySelector('button')!;
    expect(cancel.disabled).toBe(false);
    act(() => cancel.click());
    expect(onCancel).toHaveBeenCalledWith('mine');

    act(() =>
      root.render(
        <QueuedMessages
          items={[{ ...base, state: 'dispatch_uncertain', error: 'Waiting for the previous runtime.' }]}
          onCancel={onCancel}
        />
      )
    );
    expect(container.querySelector('button')?.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('Waiting for the previous runtime');
    expect(container.textContent).not.toContain('outcome unknown');

    act(() =>
      root.render(<QueuedMessages items={[{ ...base, state: 'failed', error: 'rejected' }]} onCancel={onCancel} />)
    );
    expect(container.textContent).toContain('Not started: rejected');
  } finally {
    act(() => root.unmount());
  }
});
