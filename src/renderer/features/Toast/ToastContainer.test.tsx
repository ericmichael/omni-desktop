import type { ReactElement, ReactNode } from 'react';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { $toasts, addToast } from './state';
import { ToastContainer } from './ToastContainer';

const fluentMocks = vi.hoisted(() => ({
  dispatchToast: vi.fn(),
  dismissToast: vi.fn(),
}));

vi.mock('@fluentui/react-components', () => {
  return {
    Button: ({ children, icon, onClick }: { children: ReactNode; icon?: ReactNode; onClick?: () => void }) =>
      React.createElement('button', { type: 'button', onClick }, icon, children),
    Toast: ({ children }: { children: ReactNode }) => React.createElement('article', null, children),
    ToastBody: ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
    ToastFooter: ({ children }: { children: ReactNode }) => React.createElement('footer', null, children),
    ToastTitle: ({ children }: { children: ReactNode }) => React.createElement('h2', null, children),
    Toaster: ({ toasterId }: { toasterId: string }) => React.createElement('div', { 'data-toaster-id': toasterId }),
    useId: (prefix: string) => prefix,
    useToastController: () => ({
      dispatchToast: fluentMocks.dispatchToast,
      dismissToast: fluentMocks.dismissToast,
    }),
  };
});

vi.mock('@fluentui/react-icons', () => {
  return {
    Copy20Regular: () => React.createElement('span', { 'aria-hidden': 'true' }),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let renderedToastRoots: Root[] = [];
let renderedToastContainers: HTMLDivElement[] = [];

beforeEach(() => {
  $toasts.set([]);
  fluentMocks.dispatchToast.mockClear();
  fluentMocks.dismissToast.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
    for (const toastRoot of renderedToastRoots) {
      toastRoot.unmount();
    }
  });
  renderedToastRoots = [];
  for (const toastContainer of renderedToastContainers) {
    toastContainer.remove();
  }
  renderedToastContainers = [];
  container.remove();
});

const renderContainer = async () => {
  await act(async () => {
    root.render(<ToastContainer />);
    await Promise.resolve();
  });
};

const renderDispatchedToast = async (index: number): Promise<HTMLDivElement> => {
  const toastContainer = document.createElement('div');
  document.body.appendChild(toastContainer);
  const toastRoot = createRoot(toastContainer);
  renderedToastContainers.push(toastContainer);
  renderedToastRoots.push(toastRoot);

  await act(async () => {
    const dispatchedToast = fluentMocks.dispatchToast.mock.calls[index]?.[0];
    expect(dispatchedToast).toBeDefined();
    toastRoot.render(dispatchedToast as ReactElement);
    await Promise.resolve();
  });

  return toastContainer;
};

const buttonNamed = (toastContainer: HTMLDivElement, label: string): HTMLButtonElement => {
  const button = Array.from(toastContainer.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
};

describe('ToastContainer', () => {
  it('dispatches every toast level with a Dismiss action', async () => {
    const ids = [
      addToast({ level: 'info', title: 'Info', durationMs: 5000 }),
      addToast({ level: 'success', title: 'Success', durationMs: 5000 }),
      addToast({ level: 'warning', title: 'Warning', durationMs: 7000 }),
      addToast({ level: 'error', title: 'Error', durationMs: 10000 }),
    ];

    await renderContainer();

    expect(fluentMocks.dispatchToast).toHaveBeenCalledTimes(4);

    for (const [index, id] of ids.entries()) {
      const dispatchedToast = await renderDispatchedToast(index);
      const dismissButton = buttonNamed(dispatchedToast, 'Dismiss');

      act(() => {
        dismissButton.click();
      });

      expect(fluentMocks.dismissToast).toHaveBeenCalledWith(id);
    }
  });

  it('dispatches copy error toasts with Copy error and Dismiss actions', async () => {
    const id = addToast({
      level: 'error',
      title: 'Launch failed',
      description: 'Could not start agent',
      copyText: 'stack trace',
      durationMs: 10000,
    });

    await renderContainer();

    const dispatchedToast = await renderDispatchedToast(0);
    expect(buttonNamed(dispatchedToast, 'Copy error')).toBeTruthy();

    act(() => {
      buttonNamed(dispatchedToast, 'Dismiss').click();
    });

    expect(fluentMocks.dismissToast).toHaveBeenCalledWith(id);
  });
});
