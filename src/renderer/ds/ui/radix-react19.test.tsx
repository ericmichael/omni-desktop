import { Slot } from 'radix-ui';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Radix React 19 integration', () => {
  it('keeps composed refs stable when a slotted child stores its node in state', () => {
    function Harness() {
      const [button, setButton] = useState<HTMLButtonElement | null>(null);

      return (
        <Slot.Root>
          <button ref={setButton}>{button ? 'Attached' : 'Detached'}</button>
        </Slot.Root>
      );
    }

    expect(() => act(() => root.render(<Harness />))).not.toThrow();
    expect(host.textContent).toBe('Attached');
  });
});
