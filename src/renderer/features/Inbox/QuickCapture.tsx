import { makeStyles, mergeClasses, shorthands,tokens } from '@fluentui/react-components';
import { ArrowUp20Regular, MailInbox20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { atom } from 'nanostores';
import { memo, useCallback, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { inboxApi } from '@/renderer/features/Inbox/state';

/** Whether the global quick-capture overlay is open. Exported for any future callers. */
export const $quickCaptureOpen = atom(false);

const useStyles = makeStyles({
  overlay: { position: 'absolute', inset: 0, zIndex: 50 },
  backdrop: { position: 'absolute', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.4)', backdropFilter: 'blur(4px)' },
  desktopCenter: {
    display: 'none',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '20vh',
    position: 'relative',
    zIndex: 10,
    '@media (min-width: 640px)': { display: 'flex' },
  },
  desktopCard: {
    width: '100%',
    maxWidth: '512px',
    borderRadius: '16px',
    ...shorthands.borderWidth('1px'),
    ...shorthands.borderStyle('solid'),
    boxShadow: tokens.shadow64,
    overflow: 'hidden',
    transitionProperty: 'border-color, background-color',
    transitionDuration: '200ms',
  },
  desktopCardDefault: { ...shorthands.borderColor(tokens.colorNeutralStroke1), backgroundColor: tokens.colorNeutralBackground2 },
  desktopCardFlash: { ...shorthands.borderColor('rgba(34, 197, 94, 0.5)'), backgroundColor: 'rgba(6, 78, 59, 0.3)' },
  desktopHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '10px',
    paddingBottom: '10px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
  },
  captureIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  captureTitle: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightMedium, color: tokens.colorNeutralForeground1 },
  headerSpacer: { flex: '1 1 0' },
  escKbd: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusMedium,
    paddingLeft: '6px',
    paddingRight: '6px',
    paddingTop: '2px',
    paddingBottom: '2px',
  },
  inputWrap: {
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
  },
  desktopInput: {
    width: '100%',
    backgroundColor: 'transparent',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    ':focus': { outline: 'none' },
    '::placeholder': { color: tokens.colorNeutralForeground2, opacity: 0.5 },
    border: 'none',
  },
  mobileSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    ...shorthands.borderRadius('16px', '16px', 0, 0),
    ...shorthands.borderTop('1px', 'solid'),
    boxShadow: tokens.shadow64,
    overflow: 'hidden',
    transitionProperty: 'border-color, background-color',
    transitionDuration: '200ms',
    '@media (min-width: 640px)': { display: 'none' },
  },
  dragHandle: { display: 'flex', justifyContent: 'center', paddingTop: '10px', paddingBottom: '4px' },
  dragHandleBar: { width: '32px', height: '4px', borderRadius: '9999px', backgroundColor: tokens.colorNeutralForeground2, opacity: 0.3 },
  mobileHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingBottom: tokens.spacingVerticalS,
  },
  mobileInputRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingBottom: tokens.spacingVerticalL,
    paddingTop: '4px',
  },
  mobileInput: {
    flex: '1 1 0',
    minWidth: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    paddingLeft: '14px',
    paddingRight: '14px',
    paddingTop: '10px',
    paddingBottom: '10px',
    fontSize: tokens.fontSizeBase400,
    color: tokens.colorNeutralForeground1,
    transitionProperty: 'border-color',
    transitionDuration: '150ms',
    ':focus': { outline: 'none', ...shorthands.borderColor(tokens.colorBrandStroke1) },
    '::placeholder': { color: tokens.colorNeutralForeground2, opacity: 0.5 },
  },
  submitBtn: {
    width: '40px',
    height: '40px',
    borderRadius: tokens.borderRadiusXLarge,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    border: 'none',
    cursor: 'pointer',
  },
  submitActive: { backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand },
  submitDisabled: { backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground2, opacity: 0.4 },
  safeArea: { height: 'env(safe-area-inset-bottom, 0px)' },
});

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
    if (!trimmed) {
return;
}

    // Capture lands as a global inbox item with no project context. Shaping
    // and promotion happen later from the Inbox view.
    await inboxApi.add({ title: trimmed });

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

  const styles = useStyles();

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className={styles.overlay}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
close();
}
          }}
        >
          {/* Backdrop */}
          <div className={styles.backdrop} onClick={close} />

          {/* Desktop: centered floating card */}
          <div className={styles.desktopCenter}>
            <motion.div
              initial={{ opacity: 0, y: -12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.97 }}
              transition={{ type: 'spring', duration: 0.25, bounce: 0.1 }}
              className={mergeClasses(styles.desktopCard, flash ? styles.desktopCardFlash : styles.desktopCardDefault)}
            >
              <div className={styles.desktopHeader}>
                <MailInbox20Regular className={styles.captureIcon} style={{ width: 16, height: 16 }} />
                <span className={styles.captureTitle}>Quick Capture</span>
                <div className={styles.headerSpacer} />
                <kbd className={styles.escKbd}>
                  Esc
                </kbd>
              </div>
              <div className={styles.inputWrap}>
                <input
                  ref={inputRef}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                  placeholder="What needs capturing?"
                  className={styles.desktopInput}
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
            className={mergeClasses(styles.mobileSheet, flash ? styles.desktopCardFlash : styles.desktopCardDefault)}
          >
            {/* Drag handle */}
            <div className={styles.dragHandle}>
              <div className={styles.dragHandleBar} />
            </div>

            {/* Header */}
            <div className={styles.mobileHeader}>
              <MailInbox20Regular className={styles.captureIcon} style={{ width: 16, height: 16 }} />
              <span className={styles.captureTitle}>Quick Capture</span>
            </div>

            {/* Input row */}
            <div className={styles.mobileInputRow}>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
                placeholder="What needs capturing?"
                className={styles.mobileInput}
              />
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!value.trim()}
                className={mergeClasses(styles.submitBtn, value.trim() ? styles.submitActive : styles.submitDisabled)}
                aria-label="Submit"
              >
                <ArrowUp20Regular style={{ width: 18, height: 18 }} />
              </button>
            </div>

            {/* Safe area spacer for phones with home indicator */}
            <div className={styles.safeArea} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
QuickCapture.displayName = 'QuickCapture';
