import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MessageResponse } from './message';
import { Reasoning, ReasoningContent } from './reasoning';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const typescriptFence = ['```typescript', 'const answer = 42', '```'].join('\n');

describe('Streamdown rendering', () => {
  it('renders a highlighted code fence in an assistant response', async () => {
    await act(async () => {
      root.render(<MessageResponse>{typescriptFence}</MessageResponse>);
    });

    expect(container.textContent).toContain('const answer = 42');
    expect(container.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
  });

  it('renders the same code plugin inside expanded reasoning', async () => {
    await act(async () => {
      root.render(
        <Reasoning open>
          <ReasoningContent>{typescriptFence}</ReasoningContent>
        </Reasoning>
      );
    });

    expect(container.textContent).toContain('const answer = 42');
    expect(container.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
  });
});
