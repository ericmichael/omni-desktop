import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Input } from './Input';

// @ts-expect-error global flag consumed by React
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom doesn't implement URL.createObjectURL
  if (!('createObjectURL' in URL)) {
    // @ts-expect-error jsdom URL.createObjectURL test shim
    URL.createObjectURL = () => 'blob:stub';
  }
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function getTextarea(): HTMLTextAreaElement {
  const ta = container.querySelector('textarea');
  if (!ta) {
    throw new Error('textarea not found');
  }
  return ta as HTMLTextAreaElement;
}

describe('Input ArrowDown history', () => {
  it('ArrowDown with no history preserves draft text', () => {
    const onSubmit = vi.fn();
    act(() => {
      root.render(<Input onSubmit={onSubmit} />);
    });
    const ta = getTextarea();

    // Type draft text
    act(() => {
      ta.focus();
      // Use the native setter so React picks up the input event
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(ta, 'hello world');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ta.value).toBe('hello world');

    // Move caret to end
    ta.selectionStart = ta.value.length;
    ta.selectionEnd = ta.value.length;

    // Press ArrowDown
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });

    expect(getTextarea().value).toBe('hello world');
  });
});

describe('composer folder chip', () => {
  const chipFor = (workspacePath?: string | null) => {
    act(() => {
      root.render(<Input onSubmit={vi.fn()} workspacePath={workspacePath} />);
    });
    return container.querySelector('span[title]');
  };

  it('shows the folder basename for an attached project folder', () => {
    const chip = chipFor('/home/user/code/my-project');
    expect(chip).not.toBeNull();
    expect(chip!.getAttribute('title')).toBe('/home/user/code/my-project');
    expect(chip!.textContent).toBe('my-project');
  });

  it('renders no chip for a projectless session scratch directory', () => {
    expect(chipFor('/home/user/Omni/Workspace/Sessions/2f9d43a1-8b31-4b57-9a0e-7c2d59c4f3aa')).toBeNull();
  });

  it('renders no chip for a containerized scratch workspace root', () => {
    expect(chipFor('/workspace/2f9d43a1-8b31-4b57-9a0e-7c2d59c4f3aa')).toBeNull();
  });

  it('renders no chip when no workspace path is known', () => {
    expect(chipFor(undefined)).toBeNull();
    expect(chipFor(null)).toBeNull();
  });

  it('never renders the misleading generic "Workspace" label', () => {
    act(() => {
      root.render(<Input onSubmit={vi.fn()} workspacePath="/workspace/2f9d43a1-8b31-4b57-9a0e-7c2d59c4f3aa" />);
    });
    expect(container.textContent).not.toContain('Workspace');
  });
});
