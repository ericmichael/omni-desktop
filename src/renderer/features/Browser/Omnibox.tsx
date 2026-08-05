import { Bookmark, Globe, History, Lock, Search, Unlock } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';

import { normalizeAddress, parseOrigin } from '@/lib/url';
import { Command, CommandItem, CommandList } from '@/renderer/ds/ui/command';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/renderer/ds/ui/input-group';
import { Popover, PopoverAnchor, PopoverContent } from '@/renderer/ds/ui/popover';
import { browserApi } from '@/renderer/features/Browser/state';
import type { BrowserSuggestion } from '@/shared/types';

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
  const suggestionListId = useId();
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
  const LockIcon = origin?.secure ? Lock : Unlock;

  return (
    <Popover open={open && suggestions.length > 0} onOpenChange={setOpen}>
      <div className="relative flex-1 min-w-0">
        <PopoverAnchor className="block w-full">
          <InputGroup className="h-7 rounded-full bg-background">
            <InputGroupAddon className="pl-2.5">
              <LockIcon className={origin?.secure ? 'text-success' : 'text-muted-foreground'} />
            </InputGroupAddon>
            <InputGroupInput
              ref={inputRef}
              type="text"
              className="h-6 text-xs"
              value={draft}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={handleFocus}
              onBlur={handleBlur}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open && suggestions.length > 0}
              aria-controls={suggestionListId}
            />
          </InputGroup>
        </PopoverAnchor>
        {open && suggestions.length > 0 && (
          <PopoverContent
            align="start"
            sideOffset={6}
            className="w-[var(--radix-popover-trigger-width)] p-0"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <Command
              shouldFilter={false}
              value={highlight >= 0 ? `${suggestions[highlight]?.kind}:${suggestions[highlight]?.url}` : ''}
              onValueChange={(nextValue) => {
                const index = suggestions.findIndex(
                  (suggestion) => `${suggestion.kind}:${suggestion.url}` === nextValue
                );
                setHighlight(index);
              }}
            >
              <CommandList id={suggestionListId} className="max-h-90">
                {suggestions.map((suggestion, index) => {
                  const Icon =
                    suggestion.kind === 'bookmark'
                      ? Bookmark
                      : suggestion.kind === 'history'
                        ? History
                        : suggestion.kind === 'search'
                          ? Search
                          : Globe;
                  const commandValue = `${suggestion.kind}:${suggestion.url}`;
                  return (
                    <CommandItem
                      key={commandValue}
                      value={commandValue}
                      className="gap-2.5 text-xs"
                      onMouseEnter={() => setHighlight(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onSelect={() => commit(suggestion.url)}
                    >
                      <Icon className="shrink-0" />
                      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                        {suggestion.title ?? suggestion.url}
                      </span>
                      {suggestion.kind !== 'search' && (
                        <span className="max-w-2/5 shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
                          {suggestion.url}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandList>
            </Command>
          </PopoverContent>
        )}
      </div>
    </Popover>
  );
});
Omnibox.displayName = 'Omnibox';
