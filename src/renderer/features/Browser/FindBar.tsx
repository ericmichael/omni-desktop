/**
 * Find-in-page overlay. Binds `Cmd+F` in the browser surface and drives the
 * Electron `<webview>` via `findInPage`/`stopFindInPage` through the
 * `WebviewHandle`. The parent (BrowserView) owns open/close state and passes
 * in the webview ref.
 */
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import type { WebviewHandle } from '@/renderer/common/Webview';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/renderer/ds/ui/input-group';

export const FindBar = memo(
  ({
    webviewRef,
    onClose,
    result,
  }: {
    webviewRef: React.RefObject<WebviewHandle | null>;
    onClose: () => void;
    result: { ordinal: number; matches: number } | null;
  }) => {
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
      <InputGroup className="absolute top-2 right-3 z-10 w-85 bg-background shadow-lg" aria-label="Find in page">
        <InputGroupInput
          ref={inputRef}
          type="text"
          className="text-xs"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Find in page"
          spellCheck={false}
          autoComplete="off"
        />
        <InputGroupAddon align="inline-end" className="gap-0 pr-1">
          <span className="min-w-12 text-center text-xs text-muted-foreground">{countLabel}</span>
          <InputGroupButton
            size="icon-xs"
            onClick={() => advance(false)}
            aria-label="Previous match"
            title="Previous (Shift+Enter)"
            disabled={!query}
          >
            <ChevronUp />
          </InputGroupButton>
          <InputGroupButton
            size="icon-xs"
            onClick={() => advance(true)}
            aria-label="Next match"
            title="Next (Enter)"
            disabled={!query}
          >
            <ChevronDown />
          </InputGroupButton>
          <InputGroupButton size="icon-xs" onClick={close} aria-label="Close find" title="Close (Esc)">
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    );
  }
);
FindBar.displayName = 'FindBar';
