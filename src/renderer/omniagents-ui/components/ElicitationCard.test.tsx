import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElicitationRequest } from '@/renderer/omniagents-ui/rpc/elicitation';

import { ElicitationCard } from './ElicitationCard';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const base = {
  elicitationId: 'elicit-1',
  message: 'Please provide the missing value.',
  persistResponse: false,
  sensitive: true,
} as const;

describe('ElicitationCard', () => {
  it('submits a question through the structured value envelope', async () => {
    const onRespond = vi.fn().mockResolvedValue({ status: 'accepted' });
    const request: ElicitationRequest = { ...base, kind: 'question', title: 'Clarification' };
    await act(async () => root.render(<ElicitationCard request={request} onRespond={onRespond} />));

    const input = container.querySelector('input')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Use the staging database');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit')!;
    await act(async () => submit.click());

    expect(onRespond).toHaveBeenCalledWith({
      action: 'accept',
      value: { text: 'Use the staging database' },
    });
  });

  it('uses shadcn form controls and masks write-only fields', async () => {
    const request: ElicitationRequest = {
      ...base,
      kind: 'form',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', title: 'Token', writeOnly: true },
          remember: { type: 'boolean', title: 'Remember this choice' },
        },
      },
    };
    await act(async () => root.render(<ElicitationCard request={request} onRespond={vi.fn()} />));

    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="checkbox"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="elicitation-card"]')).not.toBeNull();
  });
});
