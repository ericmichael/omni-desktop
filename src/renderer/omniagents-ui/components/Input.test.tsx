import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  conversationDrafts,
  getConversationDraft,
  updateConversationDraft,
} from '@/renderer/omniagents-ui/conversation-drafts';

import { ConversationComposer, ConversationComposerProvider } from './ConversationComposer';
import { Input } from './Input';

// @ts-expect-error global flag consumed by React
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  conversationDrafts.set({});
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
  it('reuses attachment preview URLs on typing and revokes them on remove/unmount', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: revoke }));
    const file = new File(['bytes'], 'preview.png', { type: 'image/png' });
    act(() => {
      updateConversationDraft('preview', { files: [file] });
      root.render(<Input conversationId="preview" onSubmit={vi.fn()} />);
    });
    expect(create).toHaveBeenCalledTimes(1);
    act(() => updateConversationDraft('preview', { text: 'typing does not allocate another blob' }));
    expect(create).toHaveBeenCalledTimes(1);
    act(() => updateConversationDraft('preview', { files: [] }));
    expect(revoke).toHaveBeenCalledWith('blob:owned');
    act(() => updateConversationDraft('preview', { files: [file] }));
    act(() => root.render(null));
    expect(revoke).toHaveBeenCalledTimes(2);
    create.mockRestore();
    vi.unstubAllGlobals();
  });
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

describe('conversation draft lifecycle', () => {
  it('offers mouse submission while a response is active', async () => {
    const onSubmit = vi.fn();
    act(() => {
      updateConversationDraft('active', { text: 'next message' });
      root.render(<Input conversationId="active" thinking onSubmit={onSubmit} />);
    });
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    expect(send.disabled).toBe(false);
    expect(send.title).toBe('Queue message (Enter)');
    await act(async () => send.click());
    expect(onSubmit).toHaveBeenCalledWith('next message', [], expect.any(String));
  });
  it('keeps the same textarea and selection when the shell host is replaced', () => {
    const onSubmit = vi.fn();
    act(() => {
      updateConversationDraft('stable', { text: 'still typing' });
      root.render(
        <ConversationComposerProvider>
          <div key="shell">
            <ConversationComposer conversationId="stable" onSubmit={onSubmit} />
          </div>
        </ConversationComposerProvider>
      );
    });
    const textarea = getTextarea();
    textarea.focus();
    textarea.setSelectionRange(3, 7);
    act(() =>
      root.render(
        <ConversationComposerProvider>
          <section key="live">
            <ConversationComposer conversationId="stable" onSubmit={onSubmit} />
          </section>
        </ConversationComposerProvider>
      )
    );
    expect(getTextarea()).toBe(textarea);
    expect(textarea.selectionStart).toBe(3);
    expect(textarea.selectionEnd).toBe(7);
    expect(document.activeElement).toBe(textarea);
  });
  it('keeps text and files when the startup composer is replaced and isolates conversations', () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    act(() => {
      updateConversationDraft('a', { text: 'follow-up during startup', files: [file] });
      root.render(<Input key="shell" conversationId="a" onSubmit={vi.fn()} />);
    });
    act(() => root.render(<Input key="live" conversationId="a" onSubmit={vi.fn()} />));
    expect(getTextarea().value).toBe('follow-up during startup');
    expect(container.textContent).toContain('notes.txt');
    act(() => root.render(<Input key="b" conversationId="b" onSubmit={vi.fn()} />));
    expect(getTextarea().value).toBe('');
    act(() => root.render(<Input key="a" conversationId="a" onSubmit={vi.fn()} />));
    expect(getTextarea().value).toBe('follow-up during startup');
    expect(getConversationDraft('a').files).toEqual([file]);
  });

  it('puts a rejected send back in the box ahead of a follow-up draft, with no alert', async () => {
    let reject!: (cause: Error) => void;
    const pending = new Promise<void>((_, fail) => {
      reject = fail;
    });
    const file = new File(['content'], 'notes.txt');
    act(() => {
      updateConversationDraft('a', { text: 'first', files: [file] });
      root.render(<Input conversationId="a" onSubmit={() => pending} />);
    });
    await act(async () => {
      getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(getTextarea().value).toBe('');
    act(() => updateConversationDraft('a', { text: 'follow-up' }));
    await act(async () => {
      reject(new Error('queue_full'));
    });
    expect(getTextarea().value).toBe('first\n\nfollow-up');
    expect(getConversationDraft('a').files).toEqual([file]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // Nothing blocks the next send.
    const send = container.querySelector<HTMLButtonElement>('button[type="submit"], button[aria-label="Send"]');
    expect(send?.disabled ?? false).toBe(false);
  });

  it('does not submit via Enter while disconnected', () => {
    const onSubmit = vi.fn();
    act(() => {
      updateConversationDraft('a', { text: 'keep me' });
      root.render(<Input conversationId="a" disabled onSubmit={onSubmit} />);
    });
    act(() => {
      getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(getConversationDraft('a').text).toBe('keep me');
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
