import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { usePortalTarget } from './use-portal-target';

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

async function mutateDom(mutation: () => void): Promise<void> {
  await act(async () => {
    mutation();
    await Promise.resolve();
  });
}

describe('usePortalTarget', () => {
  it('follows a replaced target without entering an update loop', async () => {
    let resolvedTarget: HTMLElement | null = null;
    let forceRender: (() => void) | undefined;

    function Harness() {
      const [, setRevision] = useState(0);
      forceRender = () => setRevision((revision) => revision + 1);
      resolvedTarget = usePortalTarget('dock-target');
      return null;
    }

    act(() => root.render(<Harness />));
    expect(resolvedTarget).toBeNull();

    const firstTarget = document.createElement('div');
    firstTarget.id = 'dock-target';
    await mutateDom(() => document.body.appendChild(firstTarget));
    expect(resolvedTarget).toBe(firstTarget);

    const replacementTarget = document.createElement('div');
    replacementTarget.id = 'dock-target';
    await mutateDom(() => firstTarget.replaceWith(replacementTarget));
    expect(resolvedTarget).toBe(replacementTarget);

    act(() => forceRender?.());
    expect(resolvedTarget).toBe(replacementTarget);

    await mutateDom(() => replacementTarget.remove());
    expect(resolvedTarget).toBeNull();
  });
});
