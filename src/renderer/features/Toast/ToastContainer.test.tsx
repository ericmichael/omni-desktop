import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { $toasts, addToast } from './state';
import { ToastContainer } from './ToastContainer';

const sonnerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: sonnerMocks }));
vi.mock('@/renderer/ds/ui/sonner', () => ({ Toaster: () => React.createElement('div', { 'data-testid': 'toaster' }) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  $toasts.set([]);
  Object.values(sonnerMocks).forEach((mock) => mock.mockClear());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderContainer = async () => {
  await act(async () => {
    root.render(<ToastContainer />);
    await Promise.resolve();
  });
};

describe('ToastContainer', () => {
  it('dispatches every toast level through Sonner with a dismiss action', async () => {
    const ids = [
      addToast({ level: 'info', title: 'Info', durationMs: 5000 }),
      addToast({ level: 'success', title: 'Success', durationMs: 5000 }),
      addToast({ level: 'warning', title: 'Warning', durationMs: 7000 }),
      addToast({ level: 'error', title: 'Error', durationMs: 10000 }),
    ];

    await renderContainer();

    for (const [method, title, id] of [
      [sonnerMocks.info, 'Info', ids[0]],
      [sonnerMocks.success, 'Success', ids[1]],
      [sonnerMocks.warning, 'Warning', ids[2]],
      [sonnerMocks.error, 'Error', ids[3]],
    ] as const) {
      expect(method).toHaveBeenCalledOnce();
      const [actualTitle, options] = method.mock.calls[0]!;
      expect(actualTitle).toBe(title);
      expect(options.id).toBe(id);
      options.cancel.onClick();
      expect(sonnerMocks.dismiss).toHaveBeenCalledWith(id);
    }
  });

  it('offers a copy action for copyable errors', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    addToast({
      level: 'error',
      title: 'Launch failed',
      description: 'Could not start agent',
      copyText: 'stack trace',
      durationMs: 10000,
    });

    await renderContainer();
    const options = sonnerMocks.error.mock.calls[0]?.[1];
    expect(options.action.label).toBeTruthy();
    await options.action.onClick();
    expect(writeText).toHaveBeenCalledWith('stack trace');
  });
});
