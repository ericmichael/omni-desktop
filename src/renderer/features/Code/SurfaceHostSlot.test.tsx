import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { SurfaceHostSlot } from './SurfaceHostSlot';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SurfaceHostSlot', () => {
  it('replaces the Files host with the Git host instead of mixing both surfaces', () => {
    const container = document.createElement('div');
    const filesHost = document.createElement('div');
    const gitHost = document.createElement('div');
    const root = createRoot(container);

    act(() => root.render(<SurfaceHostSlot host={filesHost} />));
    const slot = container.firstElementChild!;
    expect(slot.childElementCount).toBe(1);
    expect(slot.firstElementChild).toBe(filesHost);

    act(() => root.render(<SurfaceHostSlot host={gitHost} />));
    expect(slot.childElementCount).toBe(1);
    expect(slot.firstElementChild).toBe(gitHost);
    expect(filesHost.parentElement).toBeNull();

    act(() => root.render(<SurfaceHostSlot host={filesHost} />));
    expect(slot.childElementCount).toBe(1);
    expect(slot.firstElementChild).toBe(filesHost);
    expect(gitHost.parentElement).toBeNull();

    act(() => root.unmount());
  });
});
