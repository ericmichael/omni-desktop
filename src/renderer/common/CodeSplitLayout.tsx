import type { ReactNode } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { PiCaretDownBold } from 'react-icons/pi';

import { Webview } from '@/renderer/common/Webview';
import { cn } from '@/renderer/ds';

const MIN_SIDEBAR_PERCENT = 20;
const MAX_SIDEBAR_PERCENT = 50;
const DEFAULT_SIDEBAR_PERCENT = 30;
const DEFAULT_DESKTOP_PANEL_HEIGHT = 200;
const MIN_DESKTOP_PANEL_HEIGHT = 80;
const MAX_DESKTOP_PANEL_PERCENT = 0.6;

const stopPropagation = (e: React.MouseEvent) => {
  e.stopPropagation();
};

type CodeSplitLayoutProps = {
  uiSrc: string;
  codeServerSrc?: string;
  vncSrc?: string;
  onReady?: () => void;
  expandDesktopButton?: ReactNode;
};

export const CodeSplitLayout = memo(
  ({ uiSrc, codeServerSrc, vncSrc, onReady, expandDesktopButton }: CodeSplitLayoutProps) => {
  const splitRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarWidthPercent, setSidebarWidthPercent] = useState(DEFAULT_SIDEBAR_PERCENT);
  const [desktopExpanded, setDesktopExpanded] = useState(false);
  const [desktopHeight, setDesktopHeight] = useState(DEFAULT_DESKTOP_PANEL_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);
  const [isDesktopDragging, setIsDesktopDragging] = useState(false);
  const [uiReady, setUiReady] = useState(false);
  const [codeServerReady, setCodeServerReady] = useState(false);
  const [vncReady, setVncReady] = useState(false);

  useEffect(() => {
    const codeOk = codeServerSrc ? codeServerReady : true;
    const uiOk = uiReady;
    const vncOk = vncSrc && desktopExpanded ? vncReady : true;
    if (codeOk && uiOk && vncOk) {
      onReady?.();
    }
  }, [codeServerReady, codeServerSrc, desktopExpanded, onReady, uiReady, vncReady, vncSrc]);

  const toggleDesktop = useCallback(() => {
    setDesktopExpanded((prev) => !prev);
  }, []);

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!splitRef.current) {
        return;
      }
      const rect = splitRef.current.getBoundingClientRect();
      const percent = ((rect.right - e.clientX) / rect.width) * 100;
      const clamped = Math.min(MAX_SIDEBAR_PERCENT, Math.max(MIN_SIDEBAR_PERCENT, percent));
      setSidebarWidthPercent(clamped);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const handleDesktopDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDesktopDragging(true);
  }, []);

  useEffect(() => {
    if (!isDesktopDragging) {
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) {
        return;
      }
      const rect = sidebarRef.current.getBoundingClientRect();
      const height = rect.bottom - e.clientY;
      const maxHeight = rect.height * MAX_DESKTOP_PANEL_PERCENT;
      const clamped = Math.min(maxHeight, Math.max(MIN_DESKTOP_PANEL_HEIGHT, height));
      setDesktopHeight(clamped);
    };

    const handleMouseUp = () => {
      setIsDesktopDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDesktopDragging]);

  const handleUiReady = useCallback(() => {
    setUiReady(true);
  }, []);

  const handleCodeServerReady = useCallback(() => {
    setCodeServerReady(true);
  }, []);

  const handleVncReady = useCallback(() => {
    setVncReady(true);
  }, []);

  return (
    <div
      ref={splitRef}
      className={cn('relative flex w-full h-full', (isDragging || isDesktopDragging) && 'select-none')}
    >
      {isDragging && <div className="absolute inset-0 z-20 cursor-col-resize" />}

      <div className="min-w-0" style={{ width: `${100 - sidebarWidthPercent}%` }}>
        <Webview src={codeServerSrc} onReady={handleCodeServerReady} showUnavailable={Boolean(codeServerSrc)} />
      </div>

      <div
        className="w-1 shrink-0 cursor-col-resize hover:bg-accent-500/50 transition-colors bg-surface-border z-10"
        onMouseDown={handleDividerMouseDown}
      />

      <div ref={sidebarRef} className="flex flex-col min-w-0" style={{ width: `${sidebarWidthPercent}%` }}>
        {isDesktopDragging && <div className="absolute inset-0 z-20 cursor-row-resize" />}
        <div className="flex-1 min-h-0">
          <Webview src={uiSrc} onReady={handleUiReady} showUnavailable={false} />
        </div>

        {vncSrc && (
          <>
            <div
              className={cn(
                'flex items-center justify-between px-2 h-8 shrink-0 border-t border-surface-border bg-surface-raised',
                desktopExpanded && 'cursor-row-resize'
              )}
              onMouseDown={desktopExpanded ? handleDesktopDividerMouseDown : undefined}
            >
              <button
                onClick={toggleDesktop}
                onMouseDown={stopPropagation}
                className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg cursor-pointer select-none"
              >
                <PiCaretDownBold
                  size={10}
                  className={cn('transition-transform', !desktopExpanded && '-rotate-90')}
                />
                <span>Desktop</span>
              </button>
              {expandDesktopButton}
            </div>
            <div
              className={cn(
                'shrink-0 overflow-hidden',
                !desktopExpanded && 'h-0',
                !isDesktopDragging && 'transition-[height]'
              )}
              style={{ height: desktopExpanded ? desktopHeight : 0 }}
            >
              <Webview src={vncSrc} onReady={handleVncReady} showUnavailable={false} />
            </div>
          </>
        )}
      </div>
    </div>
  );
  }
);
CodeSplitLayout.displayName = 'CodeSplitLayout';
