import { forwardRef, useCallback, useEffect, useRef } from 'react';

import { cn } from '@/renderer/ds/cn';

type TextareaProps = {
  maxHeight?: number;
  className?: string;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ maxHeight = 200, className, value, onChange, ...props }, forwardedRef) => {
    const internalRef = useRef<HTMLTextAreaElement | null>(null);

    const setRef = useCallback(
      (el: HTMLTextAreaElement | null) => {
        internalRef.current = el;
        if (typeof forwardedRef === 'function') {
          forwardedRef(el);
        } else if (forwardedRef) {
          forwardedRef.current = el;
        }
      },
      [forwardedRef]
    );

    useEffect(() => {
      const el = internalRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    }, [value, maxHeight]);

    return (
      <textarea
        ref={setRef}
        value={value}
        onChange={onChange}
        className={cn(
          'w-full rounded-lg border border-surface-border/50 bg-transparent text-fg outline-none transition-colors',
          'text-base sm:text-sm px-3 py-2.5 sm:py-2',
          'placeholder:text-fg-muted/50',
          'focus:border-accent-500/50',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          'resize-none',
          className
        )}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';
