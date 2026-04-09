import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useRef, useState } from 'react';
import { PiArrowUpBold, PiTrayBold } from 'react-icons/pi';
import { useHotkeys } from 'react-hotkeys-hook';

import { cn } from '@/renderer/ds';

import { $quickCaptureOpen, inboxApi } from './state';

const hotkeyOptions = { enableOnFormTags: true } as const;

/**
 * Global quick-capture overlay.
 * Desktop: centered floating card (Spotlight-style).
 * Mobile: bottom sheet sliding up from the bottom.
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

  const flashColors = flash
    ? 'border-green-500/50 bg-green-950/30'
    : 'border-surface-border bg-surface-raised';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-0 z-50"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={close} />

          {/* Desktop: centered floating card */}
          <div className="hidden sm:flex items-start justify-center pt-[20vh] relative z-10">
            <motion.div
              initial={{ opacity: 0, y: -12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.97 }}
              transition={{ type: 'spring', duration: 0.25, bounce: 0.1 }}
              className={cn(
                'w-full max-w-lg rounded-2xl border shadow-2xl overflow-hidden transition-colors duration-200',
                flashColors
              )}
            >
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-surface-border">
                <PiTrayBold className="text-accent-500 shrink-0" size={16} />
                <span className="text-sm font-medium text-fg">Quick Capture</span>
                <div className="flex-1" />
                <kbd className="text-xs text-fg-subtle border border-surface-border rounded px-1.5 py-0.5">
                  Esc
                </kbd>
              </div>
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
          </div>

          {/* Mobile: bottom sheet */}
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', duration: 0.35, bounce: 0.05 }}
            className={cn(
              'sm:hidden absolute bottom-0 left-0 right-0 z-10 rounded-t-2xl border-t shadow-2xl overflow-hidden transition-colors duration-200',
              flashColors
            )}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-2.5 pb-1">
              <div className="w-8 h-1 rounded-full bg-fg-muted/30" />
            </div>

            {/* Header */}
            <div className="flex items-center gap-2 px-4 pb-2">
              <PiTrayBold className="text-accent-500 shrink-0" size={16} />
              <span className="text-sm font-medium text-fg">Quick Capture</span>
            </div>

            {/* Input row */}
            <div className="flex items-center gap-2 px-4 pb-4 pt-1">
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
                placeholder="What needs capturing?"
                className="flex-1 min-w-0 bg-surface rounded-xl border border-surface-border px-3.5 py-2.5 text-base text-fg placeholder:text-fg-muted/50 focus:outline-none focus:border-accent-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!value.trim()}
                className={cn(
                  'size-10 rounded-xl flex items-center justify-center shrink-0 transition-colors',
                  value.trim()
                    ? 'bg-accent-600 text-white active:scale-95'
                    : 'bg-surface-overlay text-fg-muted/40'
                )}
                aria-label="Submit"
              >
                <PiArrowUpBold size={18} />
              </button>
            </div>

            {/* Safe area spacer for phones with home indicator */}
            <div className="h-[env(safe-area-inset-bottom,0px)]" />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
QuickCapture.displayName = 'QuickCapture';
