import { makeStyles, mergeClasses, shorthands,tokens } from '@fluentui/react-components';
import type { FluentIcon } from '@fluentui/react-icons';
import { Dismiss20Regular,PanelLeft20Regular } from '@fluentui/react-icons';
import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Webview } from '@/renderer/common/Webview';

const useStyles = makeStyles({
  backdrop: { position: 'absolute', inset: 0, zIndex: 30, backgroundColor: 'rgba(0, 0, 0, 0.4)' },
  overlayCard: {
    position: 'absolute',
    inset: tokens.spacingHorizontalL,
    zIndex: 40,
    borderRadius: tokens.borderRadiusXLarge,
    overflow: 'hidden',
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow64,
    display: 'flex',
    flexDirection: 'column',
  },
  overlayHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
  },
  overlayHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  overlayCloseBtn: {
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    padding: '4px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover, color: tokens.colorNeutralForeground1 },
  },
  overlayBody: { flex: '1 1 0', minHeight: 0 },
  resizeOverlay: { position: 'absolute', inset: 0, zIndex: 40, cursor: 'nw-resize' },
  widgetWrap: { position: 'absolute', right: tokens.spacingHorizontalM, zIndex: 30 },
  previewBase: {
    position: 'absolute',
    bottom: '100%',
    right: 0,
    marginBottom: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden',
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow28,
    cursor: 'pointer',
  },
  previewResizing: { userSelect: 'none', cursor: 'default' },
  resizeEdgeTop: { position: 'absolute', top: 0, left: '16px', right: 0, height: '6px', cursor: 'n-resize', zIndex: 10 },
  resizeEdgeLeft: { position: 'absolute', top: 0, left: 0, bottom: '16px', width: '6px', cursor: 'w-resize', zIndex: 10 },
  resizeCorner: { position: 'absolute', top: 0, left: 0, width: '12px', height: '12px', cursor: 'nw-resize', zIndex: 10 },
  pillRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  splitBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: '9999px',
    boxShadow: tokens.shadow16,
    cursor: 'pointer',
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
    ...shorthands.borderWidth('1px'),
    ...shorthands.borderStyle('solid'),
  },
  splitBtnActive: {
    backgroundColor: tokens.colorBrandBackground,
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    color: tokens.colorNeutralForegroundOnBrand,
  },
  splitBtnInactive: {
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderColor(tokens.colorNeutralStroke1),
    color: tokens.colorNeutralForeground2,
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  pill: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: '6px',
    paddingBottom: '6px',
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: '9999px',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    boxShadow: tokens.shadow16,
    cursor: 'pointer',
    transitionProperty: 'color',
    transitionDuration: '150ms',
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
});

const springTransition = { type: 'spring' as const, duration: 0.3, bounce: 0.1 };

const DEFAULT_PREVIEW_SIZE = { width: 320, height: 208 };
const MIN_PREVIEW_SIZE = { width: 200, height: 140 };

type PreviewSize = { width: number; height: number };

const FloatingOverlay = memo(
  ({
    src,
    label,
    icon: Icon,
    onClose,
  }: {
    src: string;
    label: string;
    icon: FluentIcon;
    onClose: () => void;
  }) => {
    const styles = useStyles();
    return (
      <>
        <motion.div
          key="backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={springTransition}
          className={styles.backdrop}
          onClick={onClose}
        />

        <motion.div
          key="overlay"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={springTransition}
          className={styles.overlayCard}
        >
          <div className={styles.overlayHeader}>
            <div className={styles.overlayHeaderLeft}>
              <Icon style={{ width: 14, height: 14 }} />
              <span>{label}</span>
            </div>
            <button
              onClick={onClose}
              className={styles.overlayCloseBtn}
            >
              <Dismiss20Regular style={{ width: 14, height: 14 }} />
            </button>
          </div>
          <div className={styles.overlayBody}>
            <Webview src={src} showUnavailable={false} />
          </div>
        </motion.div>
      </>
    );
  }
);
FloatingOverlay.displayName = 'FloatingOverlay';

type FloatingWidgetProps = {
  src: string;
  label: string;
  icon: FluentIcon;
  overlayOpen: boolean;
  onOpenOverlay: () => void;
  onCloseOverlay: () => void;
  onClick?: () => void;
  className?: string;
  resizable?: boolean;
  defaultPreviewSize?: PreviewSize;
  onToggleSplit?: () => void;
  splitOpen?: boolean;
};

export const FloatingWidget = memo(
  ({
    src,
    label,
    icon: Icon,
    overlayOpen,
    onOpenOverlay,
    onCloseOverlay,
    onClick,
    className,
    resizable = false,
    defaultPreviewSize = DEFAULT_PREVIEW_SIZE,
    onToggleSplit,
    splitOpen = false,
  }: FloatingWidgetProps) => {
    const [hovering, setHovering] = useState(false);
    const [hoveringSplitBtn, setHoveringSplitBtn] = useState(false);
    const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previewSizeRef = useRef<PreviewSize>(defaultPreviewSize);
    const [previewSize, setPreviewSize] = useState<PreviewSize>(defaultPreviewSize);
    const [isResizing, setIsResizing] = useState(false);
    const previewRef = useRef<HTMLDivElement>(null);
    const startRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
    const edgeRef = useRef<'top' | 'left' | 'top-left' | null>(null);

    const handlePillClick = onClick ?? onOpenOverlay;

    const handleMouseEnter = useCallback(() => {
      if (isResizing) {
        return;
      }
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }
      setHovering(true);
    }, [isResizing]);

    const handleMouseLeave = useCallback(() => {
      if (isResizing) {
        return;
      }
      hoverTimeoutRef.current = setTimeout(() => {
        setHovering(false);
      }, 500);
    }, [isResizing]);

    const handleCloseAndReset = useCallback(() => {
      setHovering(false);
      onCloseOverlay();
    }, [onCloseOverlay]);

    const handleResizeStart = useCallback(
      (edge: 'top' | 'left' | 'top-left') => (e: React.MouseEvent) => {
        if (!previewRef.current) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const rect = previewRef.current.getBoundingClientRect();
        edgeRef.current = edge;
        startRef.current = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
        setIsResizing(true);
      },
      []
    );

    useEffect(() => {
      if (!isResizing) {
        return;
      }

      const handleMouseMove = (e: MouseEvent) => {
        if (!startRef.current || !edgeRef.current) {
          return;
        }
        const dx = startRef.current.x - e.clientX;
        const dy = startRef.current.y - e.clientY;
        const edge = edgeRef.current;

        const newW = edge === 'top' ? startRef.current.w : Math.max(MIN_PREVIEW_SIZE.width, startRef.current.w + dx);
        const newH = edge === 'left' ? startRef.current.h : Math.max(MIN_PREVIEW_SIZE.height, startRef.current.h + dy);

        const next = { width: newW, height: newH };
        setPreviewSize(next);
        previewSizeRef.current = next;
      };

      const handleMouseUp = () => {
        setIsResizing(false);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }, [isResizing]);

    // Restore saved size when preview opens
    useEffect(() => {
      if (hovering) {
        setPreviewSize(previewSizeRef.current);
      }
    }, [hovering]);

    const handleSplitBtnEnter = useCallback(() => setHoveringSplitBtn(true), []);
    const handleSplitBtnLeave = useCallback(() => setHoveringSplitBtn(false), []);

    const showPreview = (hovering || isResizing) && !overlayOpen && !splitOpen && !hoveringSplitBtn;

    const styles = useStyles();
    return (
      <>
        <AnimatePresence>
          {overlayOpen && <FloatingOverlay src={src} label={label} icon={Icon} onClose={handleCloseAndReset} />}
        </AnimatePresence>

        {isResizing && <div className={styles.resizeOverlay} />}

        {!overlayOpen && (
          <div
            className={mergeClasses(styles.widgetWrap, className)}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <AnimatePresence>
              {showPreview && (
                <motion.div
                  ref={previewRef}
                  key="preview"
                  initial={{ opacity: 0, scale: 0.9, y: 12 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: 12 }}
                  transition={springTransition}
                  className={mergeClasses(styles.previewBase, isResizing && styles.previewResizing)}
                  style={{ width: previewSize.width, height: previewSize.height }}
                  onClick={isResizing ? undefined : handlePillClick}
                >
                  {resizable && (
                    <>
                      <div
                        className={styles.resizeEdgeTop}
                        onMouseDown={handleResizeStart('top')}
                      />
                      <div
                        className={styles.resizeEdgeLeft}
                        onMouseDown={handleResizeStart('left')}
                      />
                      <div
                        className={styles.resizeCorner}
                        onMouseDown={handleResizeStart('top-left')}
                      />
                    </>
                  )}
                  <Webview src={src} showUnavailable={false} />
                </motion.div>
              )}
            </AnimatePresence>

            <div className={styles.pillRow}>
              {onToggleSplit && hovering && (
                <motion.button
                  onClick={onToggleSplit}
                  onMouseEnter={handleSplitBtnEnter}
                  onMouseLeave={handleSplitBtnLeave}
                  className={mergeClasses(
                    styles.splitBtn,
                    splitOpen ? styles.splitBtnActive : styles.splitBtnInactive
                  )}
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                >
                  <PanelLeft20Regular style={{ width: 13, height: 13 }} />
                </motion.button>
              )}

              <motion.button
                onClick={handlePillClick}
                className={styles.pill}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
              >
                <Icon style={{ width: 14, height: 14 }} />
                <span>{label}</span>
              </motion.button>
            </div>
          </div>
        )}
      </>
    );
  }
);
FloatingWidget.displayName = 'FloatingWidget';
