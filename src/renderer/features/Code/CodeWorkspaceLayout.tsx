import { AnimatePresence, motion } from 'framer-motion';
import { memo, useCallback } from 'react';
import { PiCodeBold, PiMonitorBold, PiXBold } from 'react-icons/pi';

import { Webview } from '@/renderer/common/Webview';

type OverlayPane = 'none' | 'code' | 'vnc';

type CodeWorkspaceLayoutProps = {
  uiSrc: string;
  codeServerSrc?: string;
  vncSrc?: string;
  overlayPane?: OverlayPane;
  onCloseOverlay?: () => void;
  onReady?: () => void;
};

const transition = { type: 'spring' as const, duration: 0.28, bounce: 0.08 };

const OverlayPaneView = memo(
  ({ pane, src, onClose }: { pane: Exclude<OverlayPane, 'none'>; src: string; onClose: () => void }) => {
    const title = pane === 'code' ? 'VS Code' : "Omni's PC";
    const Icon = pane === 'code' ? PiCodeBold : PiMonitorBold;

    return (
      <>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transition}
          className="absolute inset-0 z-30 bg-black/45"
          onClick={onClose}
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={transition}
          className="absolute inset-3 z-40 overflow-hidden rounded-xl border border-surface-border bg-surface shadow-2xl"
        >
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-surface-border bg-surface-raised px-3 py-2">
              <div className="flex items-center gap-2 text-sm text-fg-muted">
                <Icon size={14} />
                <span>{title}</span>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-overlay hover:text-fg"
                aria-label="Close overlay"
              >
                <PiXBold size={14} />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <Webview src={src} showUnavailable={false} />
            </div>
          </div>
        </motion.div>
      </>
    );
  }
);
OverlayPaneView.displayName = 'OverlayPaneView';

export const CodeWorkspaceLayout = memo(({ uiSrc, codeServerSrc, vncSrc, overlayPane = 'none', onCloseOverlay, onReady }: CodeWorkspaceLayoutProps) => {
  const overlaySrc = overlayPane === 'code' ? codeServerSrc : overlayPane === 'vnc' ? vncSrc : undefined;

  const handleUiReady = useCallback(() => {
    onReady?.();
  }, [onReady]);

  const closeOverlay = useCallback(() => {
    onCloseOverlay?.();
  }, [onCloseOverlay]);

  return (
    <div className="relative flex h-full w-full flex-col bg-surface">
      <div className="relative min-h-0 flex-1">
        <div className="h-full w-full min-w-0">
          <Webview src={uiSrc} onReady={handleUiReady} showUnavailable={false} />
        </div>
      </div>

      <AnimatePresence>
        {overlayPane !== 'none' && overlaySrc && <OverlayPaneView pane={overlayPane} src={overlaySrc} onClose={closeOverlay} />}
      </AnimatePresence>
    </div>
  );
});
CodeWorkspaceLayout.displayName = 'CodeWorkspaceLayout';
