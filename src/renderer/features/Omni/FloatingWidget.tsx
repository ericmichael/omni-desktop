import { AnimatePresence, motion } from 'framer-motion';
import type { ComponentType } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PiXBold } from 'react-icons/pi';

import { Webview } from '@/renderer/common/Webview';
import { cn } from '@/renderer/ds';

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
    icon: ComponentType<{ size: number }>;
    onClose: () => void;
  }) => {
    return (
      <>
        <motion.div
          key="backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={springTransition}
          className="absolute inset-0 z-30 bg-black/40"
          onClick={onClose}
        />

        <motion.div
          key="overlay"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={springTransition}
          className="absolute inset-4 z-40 rounded-xl overflow-hidden border border-surface-border bg-surface shadow-2xl flex flex-col"
        >
          <div className="flex items-center justify-between px-3 py-2 bg-surface-raised border-b border-surface-border">
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Icon size={14} />
              <span>{label}</span>
            </div>
            <button
              onClick={onClose}
              className="text-fg-muted hover:text-fg cursor-pointer p-1 rounded hover:bg-surface-overlay transition-colors"
            >
              <PiXBold size={14} />
            </button>
          </div>
          <div className="flex-1 min-h-0">
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
  icon: ComponentType<{ size: number }>;
  overlayOpen: boolean;
  onOpenOverlay: () => void;
  onCloseOverlay: () => void;
  className?: string;
  resizable?: boolean;
};

export const FloatingWidget = memo(
  ({ src, label, icon: Icon, overlayOpen, onOpenOverlay, onCloseOverlay, className, resizable = false }: FloatingWidgetProps) => {
    const [hovering, setHovering] = useState(false);
    const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previewSizeRef = useRef<PreviewSize>(DEFAULT_PREVIEW_SIZE);
    const [previewSize, setPreviewSize] = useState<PreviewSize>(DEFAULT_PREVIEW_SIZE);
    const [isResizing, setIsResizing] = useState(false);
    const previewRef = useRef<HTMLDivElement>(null);
    const startRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
    const edgeRef = useRef<'top' | 'left' | 'top-left' | null>(null);

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

    const showPreview = (hovering || isResizing) && !overlayOpen;

    return (
      <>
        <AnimatePresence>
          {overlayOpen && <FloatingOverlay src={src} label={label} icon={Icon} onClose={handleCloseAndReset} />}
        </AnimatePresence>

        {isResizing && <div className="absolute inset-0 z-40 cursor-nw-resize" />}

        {!overlayOpen && (
          <div
            className={cn('absolute right-3 z-30', className)}
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
                  className={cn(
                    'absolute bottom-full right-0 mb-2 rounded-lg overflow-hidden border border-surface-border bg-surface shadow-xl cursor-pointer',
                    isResizing && 'select-none cursor-default'
                  )}
                  style={{ width: previewSize.width, height: previewSize.height }}
                  onClick={isResizing ? undefined : onOpenOverlay}
                >
                  {resizable && (
                    <>
                      <div
                        className="absolute top-0 left-4 right-0 h-1.5 cursor-n-resize z-10"
                        onMouseDown={handleResizeStart('top')}
                      />
                      <div
                        className="absolute top-0 left-0 bottom-4 w-1.5 cursor-w-resize z-10"
                        onMouseDown={handleResizeStart('left')}
                      />
                      <div
                        className="absolute top-0 left-0 size-3 cursor-nw-resize z-10"
                        onMouseDown={handleResizeStart('top-left')}
                      />
                    </>
                  )}
                  <Webview src={src} showUnavailable={false} />
                </motion.div>
              )}
            </AnimatePresence>

            <motion.button
              onClick={onOpenOverlay}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5',
                'bg-surface-raised border border-surface-border rounded-full',
                'text-sm text-fg-muted hover:text-fg',
                'shadow-lg cursor-pointer transition-colors'
              )}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
            >
              <Icon size={14} />
              <span>{label}</span>
            </motion.button>
          </div>
        )}
      </>
    );
  }
);
FloatingWidget.displayName = 'FloatingWidget';
