import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useRef, useState } from 'react';
import { PiTrayBold } from 'react-icons/pi';
import { useHotkeys } from 'react-hotkeys-hook';

import { cn } from '@/renderer/ds';

import { $quickCaptureOpen, inboxApi } from './state';

const hotkeyOptions = { enableOnFormTags: true } as const;

/**
 * Global quick-capture overlay. Ctrl+I opens a floating input from any view.
 * First line becomes title, remaining lines become description.
 */
export const QuickCapture = memo(() => {
  const open = useStore($quickCaptureOpen);
  const [value, setValue] = useState('');
  const [flash, setFlash] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const toggle = useCallback(() => {
    const willOpen = !$quickCaptureOpen.get();
    if (willOpen) {
      setValue('');
      setFlash(false);
    }
    $quickCaptureOpen.set(willOpen);
  }, []);

  const close = useCallback(() => {
    $quickCaptureOpen.set(false);
  }, []);

  useHotkeys('ctrl+i', toggle, hotkeyOptions);

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) return;

    await inboxApi.addItem({ title: trimmed, status: 'open' });

    // Flash confirmation then close
    setFlash(true);
    setValue('');
    setTimeout(() => {
      $quickCaptureOpen.set(false);
      setFlash(false);
    }, 350);
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    },
    [close, submit]
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-0 z-50 flex items-start justify-center pt-[20vh]"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

          {/* Capture card */}
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ type: 'spring', duration: 0.25, bounce: 0.1 }}
            className={cn(
              'relative w-full max-w-lg rounded-xl border shadow-2xl overflow-hidden transition-colors duration-200',
              flash
                ? 'border-green-500/50 bg-green-950/30'
                : 'border-surface-border bg-surface-raised'
            )}
          >
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-border">
              <PiTrayBold className="text-accent-500 shrink-0" size={16} />
              <span className="text-sm font-medium text-fg">Quick Capture</span>
              <div className="flex-1" />
              <kbd className="text-[10px] text-fg-subtle border border-surface-border rounded px-1.5 py-0.5">
                Esc
              </kbd>
            </div>

            {/* Input */}
            <div className="px-4 py-3">
              <input
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
                placeholder="What needs capturing?"
                className="w-full bg-transparent text-sm text-fg placeholder:text-fg-muted/50 focus:outline-none"
              />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
QuickCapture.displayName = 'QuickCapture';
