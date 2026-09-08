import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { QueuedMessage } from '@/renderer/omniagents-ui/rpc/client';

import { QueuedMessages } from './QueuedMessages';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('explains a runtime-blocked pending message without disabling safe cancellation', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onCancel = vi.fn();
  const item: QueuedMessage = {
    id: 'pending',
    content: 'Not dispatched',
    role: 'user',
    trigger_run: true,
    state: 'pending',
    error: 'Waiting for the previous runtime to finish or be reconciled.',
    variables: null,
    safe_tool_overrides: null,
    source: null,
    enqueued_at: 1,
  };
  try {
    act(() => root.render(<QueuedMessages items={[item]} onCancel={onCancel} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Waiting for the previous runtime');
    const cancel = container.querySelector('button')!;
    expect(cancel.disabled).toBe(false);
    act(() => cancel.click());
    expect(onCancel).toHaveBeenCalledWith('pending');
    act(() => root.render(<QueuedMessages items={[{ ...item, state: 'dispatch_uncertain' }]} onCancel={onCancel} />));
    expect(container.querySelector('button')?.disabled).toBe(true);
    expect(container.textContent).toContain('Dispatch outcome unknown');
  } finally {
    act(() => root.unmount());
  }
});
