import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import {
  Bookmark16Regular,
  Globe16Regular,
  History16Regular,
  LockClosed16Regular,
  LockOpen16Regular,
  Search16Regular,
} from '@fluentui/react-icons';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { normalizeAddress, parseOrigin } from '@/lib/url';
import { browserApi } from '@/renderer/features/Browser/state';
import type { BrowserSuggestion } from '@/shared/types';

const useStyles = makeStyles({
  wrap: { position: 'relative', flex: '1 1 0', minWidth: 0 },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    height: '28px',
    paddingLeft: '8px',
    paddingRight: '8px',
    borderRadius: '14px',
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: tokens.durationFaster,
    ':focus-within': {
      ...shorthands.borderColor(tokens.colorBrandStroke1),
      boxShadow: `0 0 0 2px ${tokens.colorBrandStroke2}`,
    },
  },
  secure: { color: tokens.colorPaletteGreenForeground1 },
  insecure: { color: tokens.colorNeutralForeground3 },
  input: {
    flex: '1 1 0',
    minWidth: 0,
    height: '22px',
    padding: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    backgroundColor: 'transparent',
    border: 'none',
    outline: 'none',
  },
  popover: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: 0,
    right: 0,
    zIndex: 20,
    maxHeight: '360px',
    overflowY: 'auto',
    padding: '4px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    boxShadow: tokens.shadow16,
  },
  suggestion: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    paddingLeft: '8px',
    paddingRight: '8px',
    paddingTop: '6px',
    paddingBottom: '6px',
    borderRadius: tokens.borderRadiusSmall,
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  suggestionActive: { backgroundColor: tokens.colorSubtleBackgroundHover },
  suggestionTitle: {
    flex: '1 1 0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  suggestionUrl: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '40%',
    flexShrink: 0,
  },
});

export type OmniboxHandle = {
  focus: () => void;
  select: () => void;
};

export const Omnibox = forwardRef<
  OmniboxHandle,
  {
    value: string;
    onSubmit: (url: string) => void;
    onValueChange?: (value: string) => void;
    placeholder?: string;
  }
>(({ value, onSubmit, onValueChange, placeholder = 'Search or enter URL' }, handleRef) => {
  const styles = useStyles();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<BrowserSuggestion[]>([]);
  // -1 means "no suggestion selected" — Enter commits the typed draft. Arrow
  // keys are the only way to move into the list, matching standard browsers.
  const [highlight, setHighlight] = useState(-1);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestSeqRef = useRef(0);

  // Keep the displayed value in sync when the parent navigates on its own
  // (e.g. agent-triggered navigation, back/forward, tab switch).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useImperativeHandle(
    handleRef,
    () => ({
      focus: () => inputRef.current?.focus(),
      select: () => inputRef.current?.select(),
    }),
    []
  );

  const fetchSuggestions = useCallback(async (q: string) => {
    const seq = ++suggestSeqRef.current;
    if (!q.trim()) {
      if (seq === suggestSeqRef.current) {
setSuggestions([]);
}
      return;
    }
    try {
      const out = await browserApi.suggest(q, { limit: 8 });
      if (seq === suggestSeqRef.current) {
setSuggestions(out);
}
    } catch {
      if (seq === suggestSeqRef.current) {
setSuggestions([]);
}
    }
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = e.target.value;
      setDraft(next);
      onValueChange?.(next);
      setOpen(true);
      setHighlight(-1);
      void fetchSuggestions(next);
    },
    [fetchSuggestions, onValueChange]
  );

  const commit = useCallback(
    (raw: string) => {
      const url = normalizeAddress(raw);
      setOpen(false);
      setDraft(url);
      onSubmit(url);
    },
    [onSubmit]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        setOpen(true);
        void fetchSuggestions(draft);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, Math.max(0, suggestions.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, -1));
      } else if (e.key === 'Escape') {
        setOpen(false);
        setDraft(value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = open && highlight >= 0 ? suggestions[highlight] : null;
        commit(pick ? pick.url : draft);
      }
    },
    [commit, draft, fetchSuggestions, highlight, open, suggestions, value]
  );

  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
      e.currentTarget.select();
      setOpen(true);
      void fetchSuggestions(draft);
    },
    [draft, fetchSuggestions]
  );

  const handleBlur = useCallback(() => {
    // Delay close so a click on a suggestion doesn't race the blur.
    blurTimerRef.current = setTimeout(() => setOpen(false), 120);
  }, []);

  const origin = parseOrigin(value);
  const LockIcon = origin?.secure ? LockClosed16Regular : LockOpen16Regular;

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <LockIcon className={origin?.secure ? styles.secure : styles.insecure} />
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          value={draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
        />
      </div>
      {open && suggestions.length > 0 && (
        <div className={styles.popover} role="listbox">
          {suggestions.map((s, i) => {
            const Icon =
              s.kind === 'bookmark'
                ? Bookmark16Regular
                : s.kind === 'history'
                  ? History16Regular
                  : s.kind === 'search'
                    ? Search16Regular
                    : Globe16Regular;
            return (
              <div
                key={`${s.kind}-${s.url}`}
                className={mergeClasses(styles.suggestion, i === highlight && styles.suggestionActive)}
                role="option"
                aria-selected={i === highlight}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  // Prevent the input blur from firing before click lands.
                  e.preventDefault();
                  commit(s.url);
                }}
              >
                <Icon style={{ flexShrink: 0 }} />
                <span className={styles.suggestionTitle}>{s.title ?? s.url}</span>
                {s.kind !== 'search' && <span className={styles.suggestionUrl}>{s.url}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
Omnibox.displayName = 'Omnibox';
