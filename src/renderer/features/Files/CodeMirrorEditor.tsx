import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

import type { OpenFileLocation } from './open-file-intent';

export type CodeMirrorRevealRequest = Readonly<{
  requestId: string;
  location: OpenFileLocation;
}>;

export type CodeMirrorEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  readOnly?: boolean;
  ariaLabel?: string;
  autoFocus?: boolean;
  revealRequest?: CodeMirrorRevealRequest;
};

/**
 * Controlled CodeMirror 6 wrapper for source files. Saving is deliberately
 * explicit: Mod-S delegates to the owner and no edit is written on a timer.
 */
export function CodeMirrorEditor({
  value,
  onChange,
  onSave,
  readOnly = false,
  ariaLabel = 'Source editor',
  autoFocus = false,
  revealRequest,
}: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const syncingRef = useRef(false);
  const editableCompartmentRef = useRef(new Compartment());

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const editable = editableCompartmentRef.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          EditorState.tabSize.of(2),
          editable.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel,
            'aria-readonly': String(readOnly),
            spellcheck: 'false',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncingRef.current) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-s',
                preventDefault: true,
                run: () => {
                  onSaveRef.current();
                  return true;
                },
              },
            ])
          ),
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus) {
      view.focus();
    }
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // The editor instance is intentionally stable; controlled updates below
    // reconfigure the mutable pieces without discarding selection/history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const current = view.state.doc.toString();
    if (current === value) {
      return;
    }
    syncingRef.current = true;
    try {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    } finally {
      syncingRef.current = false;
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
    view.contentDOM.setAttribute('aria-readonly', String(readOnly));
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealRequest) {
      return;
    }
    const { location } = revealRequest;
    const position = (lineNumber: number, column = 1) => {
      const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines));
      return line.from + Math.min(column - 1, line.length);
    };
    const anchor = position(location.line, location.column);
    const head = position(location.endLine ?? location.line, location.endColumn ?? location.column);
    view.dispatch({
      selection: { anchor, head },
      effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
    });
    view.focus();
  }, [revealRequest]);

  return (
    <div
      ref={hostRef}
      className="h-full min-h-0 min-w-0 overflow-hidden bg-background [&_.cm-activeLine,_&_.cm-activeLineGutter]:bg-transparent [&_.cm-cursor]:border-l-foreground [&_.cm-editor]:h-full [&_.cm-editor]:bg-background [&_.cm-editor]:text-foreground [&_.cm-focused]:outline-2 [&_.cm-gutters]:border-r-border [&_.cm-gutters]:bg-card [&_.cm-gutters]:text-muted-foreground [&_.cm-scroller]:overflow-auto [&_.cm-scroller]:font-mono [&_.cm-scroller]:text-sm [&_.cm-scroller]:leading-relaxed [&_.cm-selectionBackground,_&_.cm-content_::selection]:!bg-primary/10 -outline-offset-2 outline-ring"
      data-testid="source-editor"
    />
  );
}
