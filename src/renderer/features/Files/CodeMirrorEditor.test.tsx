import { EditorView } from '@codemirror/view';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeMirrorEditor } from './CodeMirrorEditor';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('CodeMirrorEditor', () => {
  it('reports user edits, suppresses controlled-sync echoes, and reconfigures read-only state', () => {
    const onChange = vi.fn();
    const onSave = vi.fn();
    act(() =>
      root.render(
        <CodeMirrorEditor
          ariaLabel="Editor for source/app.ts"
          onChange={onChange}
          onSave={onSave}
          readOnly
          value="initial"
        />
      )
    );

    const content = container.querySelector<HTMLElement>('[aria-label="Editor for source/app.ts"]')!;
    const view = EditorView.findFromDOM(content)!;
    expect(content.getAttribute('aria-readonly')).toBe('true');
    expect(view.state.doc.toString()).toBe('initial');

    act(() =>
      root.render(
        <CodeMirrorEditor
          ariaLabel="Editor for source/app.ts"
          onChange={onChange}
          onSave={onSave}
          readOnly={false}
          value="controlled"
        />
      )
    );
    expect(content.getAttribute('aria-readonly')).toBe('false');
    expect(view.state.doc.toString()).toBe('controlled');
    expect(onChange).not.toHaveBeenCalled();

    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: ' edit' } }));
    expect(onChange).toHaveBeenCalledWith('controlled edit');
  });

  it('maps Mod-S to explicit save and prevents the browser default', () => {
    const onSave = vi.fn();
    act(() => root.render(<CodeMirrorEditor onChange={() => {}} onSave={onSave} value="content" />));
    const content = container.querySelector<HTMLElement>('.cm-content')!;
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });

    act(() => content.dispatchEvent(event));

    expect(onSave).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });
});
