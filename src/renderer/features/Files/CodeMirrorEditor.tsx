import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

export type CodeMirrorEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  readOnly?: boolean;
  ariaLabel?: string;
  autoFocus?: boolean;
  isGlass?: boolean;
};

const useStyles = makeStyles({
  root: {
    minWidth: 0,
    minHeight: 0,
    height: '100%',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
    '& .cm-editor': {
      height: '100%',
      color: tokens.colorNeutralForeground1,
      backgroundColor: tokens.colorNeutralBackground1,
    },
    '& .cm-scroller': {
      overflow: 'auto',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: tokens.fontSizeBase300,
      lineHeight: '1.55',
    },
    '& .cm-gutters': {
      color: tokens.colorNeutralForeground4,
      backgroundColor: tokens.colorNeutralBackground2,
      borderRightColor: tokens.colorNeutralStroke2,
    },
    '& .cm-activeLine, & .cm-activeLineGutter': {
      backgroundColor: tokens.colorSubtleBackground,
    },
    '& .cm-selectionBackground, & .cm-content ::selection': {
      backgroundColor: `${tokens.colorBrandBackground2} !important`,
    },
    '& .cm-focused': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
    },
    '& .cm-cursor': { borderLeftColor: tokens.colorNeutralForeground1 },
  },
  rootGlass: {
    backgroundColor: 'transparent',
    '& .cm-editor': { backgroundColor: 'transparent' },
    '& .cm-gutters': { backgroundColor: tokens.colorNeutralBackground3 },
  },
});

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
  isGlass = false,
}: CodeMirrorEditorProps) {
  const styles = useStyles();
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

  return (
    <div ref={hostRef} className={mergeClasses(styles.root, isGlass && styles.rootGlass)} data-testid="source-editor" />
  );
}
