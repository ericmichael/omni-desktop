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
  it('restores a conflict copy without submitting or discarding the current draft', async () => {
    const submit = vi.fn();
    const file = new File(['saved bytes'], 'saved.txt');
    act(() => {
      updateConversationDraft('conflicts', {
        text: 'current draft',
        otherDrafts: [{ id: 'saved', text: 'saved draft', files: [file] }],
      });
      root.render(<Input conversationId="conflicts" onSubmit={submit} />);
    });
    const restore = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Restore other draft'
    )!;
    await act(async () => restore.click());
    expect(submit).not.toHaveBeenCalled();
    expect(getConversationDraft('conflicts')).toMatchObject({
      text: 'saved draft',
      files: [file],
      otherDrafts: [expect.objectContaining({ text: 'current draft' })],
    });
  });
  it.each(['success', 'failure'])('ignores late %s from a replaced input attempt', async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const result = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    act(() => {
      updateConversationDraft('ownership', { text: 'old' });
      root.render(<Input conversationId="ownership" onSubmit={() => result} />);
    });
    await act(async () => {
      getTextarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    const file = new File(['new bytes'], 'new.txt');
    act(() =>
      updateConversationDraft('ownership', {
        text: 'follow-up',
        pendingInput: { id: 'new-input', text: 'new', files: [file] },
      })
    );
    await act(async () => {
      if (outcome === 'success') {
        resolve();
      } else {
        reject(new Error('old failure'));
      }
    });
    expect(getConversationDraft('ownership')).toMatchObject({
      text: 'follow-up',
      pendingInput: { id: 'new-input', text: 'new', files: [file] },
    });
    expect(getConversationDraft('ownership').error).toBeUndefined();
  });

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

  it('restores a rejected send without overwriting a follow-up draft', async () => {
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
    expect(getTextarea().value).toBe('follow-up');
    expect(getConversationDraft('a').pendingInput).toMatchObject({
      id: expect.any(String),
      text: 'first',
      files: [file],
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('queue_full');
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
