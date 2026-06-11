/**
 * Find-in-page overlay. Binds `Cmd+F` in the browser surface and drives the
 * Electron `<webview>` via `findInPage`/`stopFindInPage` through the
 * `WebviewHandle`. The parent (BrowserView) owns open/close state and passes
 * in the webview ref.
 */
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { ChevronDown16Regular, ChevronUp16Regular, Dismiss16Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import type { WebviewHandle } from '@/renderer/common/Webview';

const useStyles = makeStyles({
  root: {
    position: 'absolute',
    top: '8px',
    right: '12px',
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 6px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    boxShadow: tokens.shadow16,
  },
  input: {
    flex: '0 0 200px',
    height: '22px',
    padding: '0 6px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    border: 'none',
    outline: 'none',
  },
  counter: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    minWidth: '48px',
    textAlign: 'center',
  },
  btn: {
    display: 'inline-flex',
    width: '22px',
    height: '22px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusSmall,
    border: 'none',
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
    ':disabled': { opacity: 0.4, cursor: 'not-allowed', ':hover': { backgroundColor: 'transparent' } },
  },
});

export const FindBar = memo(
  ({
    webviewRef,
    onClose,
    result,
  }: {
    webviewRef: React.RefObject<WebviewHandle>;
    onClose: () => void;
    result: { ordinal: number; matches: number } | null;
  }) => {
    const styles = useStyles();
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // Autofocus + select on open.
    useEffect(() => {
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    }, []);

    const search = useCallback(
      (text: string, findNext = false) => {
        const handle = webviewRef.current;
        if (!handle) {
return;
}
        if (!text) {
          handle.stopFindInPage('clearSelection');
          return;
        }
        handle.findInPage(text, { findNext });
      },
      [webviewRef]
    );

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const next = e.target.value;
        setQuery(next);
        search(next, false);
      },
      [search]
    );

    const advance = useCallback(
      (forward: boolean) => {
        const handle = webviewRef.current;
        if (!handle || !query) {
return;
}
        handle.findInPage(query, { findNext: true, forward });
      },
      [query, webviewRef]
    );

    const close = useCallback(() => {
      webviewRef.current?.stopFindInPage('clearSelection');
      onClose();
    }, [onClose, webviewRef]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          advance(!e.shiftKey);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      },
      [advance, close]
    );

    const countLabel = result
      ? result.matches === 0
        ? '0 matches'
        : `${result.ordinal}/${result.matches}`
      : query
        ? '…'
        : '';

    return (
      <div className={styles.root} role="search" aria-label="Find in page">
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Find in page"
          spellCheck={false}
          autoComplete="off"
        />
        <span className={styles.counter}>{countLabel}</span>
        <button
          type="button"
          className={styles.btn}
          onClick={() => advance(false)}
          aria-label="Previous match"
          title="Previous (Shift+Enter)"
          disabled={!query}
        >
          <ChevronUp16Regular />
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={() => advance(true)}
          aria-label="Next match"
          title="Next (Enter)"
          disabled={!query}
        >
          <ChevronDown16Regular />
        </button>
        <button type="button" className={styles.btn} onClick={close} aria-label="Close find" title="Close (Esc)">
          <Dismiss16Regular />
        </button>
      </div>
    );
  }
);
FindBar.displayName = 'FindBar';
