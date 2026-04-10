import { Textarea as FluentTextarea } from '@fluentui/react-components';
import { forwardRef, useCallback, useEffect, useRef } from 'react';

type TextareaProps = {
  maxHeight?: number;
  className?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  rows?: number;
  id?: string;
  name?: string;
  onChange?: React.ChangeEventHandler<HTMLTextAreaElement>;
  onFocus?: React.FocusEventHandler<HTMLTextAreaElement>;
  onBlur?: React.FocusEventHandler<HTMLTextAreaElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  'aria-label'?: string;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ maxHeight = 200, className, value, onChange, onFocus, onBlur, onKeyDown, ...props }, forwardedRef) => {
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
      <FluentTextarea
        ref={setRef}
        appearance="underline"
        resize="none"
        value={value}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        className={className}
        placeholder={props.placeholder}
        disabled={props.disabled}
        readOnly={props.readOnly}
        id={props.id}
        name={props.name}
        aria-label={props['aria-label']}
      />
    );
  }
);

Textarea.displayName = 'Textarea';
