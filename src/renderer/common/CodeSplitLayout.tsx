import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Webview } from '@/renderer/common/Webview';
import { OmniAgentsApp } from '@/renderer/omniagents-ui';
import { cn } from '@/renderer/ds';

const MIN_SIDEBAR_PERCENT = 20;
const MAX_SIDEBAR_PERCENT = 50;
const DEFAULT_SIDEBAR_PERCENT = 30;

type CodeSplitLayoutProps = {
  uiSrc: string;
  codeServerSrc?: string;
  uiMode?: 'webview' | 'omniagents';
  codeServerMode?: 'webview' | 'omniagents';
  onReady?: () => void;
  sandboxLabel?: string;
};

export const CodeSplitLayout = memo(({ uiSrc, codeServerSrc, uiMode = 'webview', codeServerMode = 'webview', onReady, sandboxLabel }: CodeSplitLayoutProps) => {
  const splitRef = useRef<HTMLDivElement>(null);
  const [sidebarWidthPercent, setSidebarWidthPercent] = useState(DEFAULT_SIDEBAR_PERCENT);
  const [isDragging, setIsDragging] = useState(false);
  const [uiReady, setUiReady] = useState(false);
  const [codeServerReady, setCodeServerReady] = useState(false);

  useEffect(() => {
    const codeOk = codeServerSrc ? codeServerReady : true;
    const uiOk = uiReady;
    if (codeOk && uiOk) {
      onReady?.();
    }
  }, [codeServerReady, codeServerSrc, onReady, uiReady]);

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

  const handleUiReady = useCallback(() => {
    setUiReady(true);
  }, []);

  const handleCodeServerReady = useCallback(() => {
    setCodeServerReady(true);
  }, []);

  return (
    <div ref={splitRef} className={cn('relative flex w-full h-full', isDragging && 'select-none')}>
      {isDragging && <div className="absolute inset-0 z-20 cursor-col-resize" />}

      <div className="min-w-0" style={{ width: `${100 - sidebarWidthPercent}%` }}>
        {codeServerMode === 'omniagents' && codeServerSrc ? (
          <OmniAgentsApp uiUrl={codeServerSrc} onReady={handleCodeServerReady} sandboxLabel={sandboxLabel} />
        ) : (
          <Webview src={codeServerSrc} onReady={handleCodeServerReady} showUnavailable={Boolean(codeServerSrc)} />
        )}
      </div>

      <div
        className="w-1 shrink-0 cursor-col-resize hover:bg-accent-500/50 transition-colors bg-surface-border z-10"
        onMouseDown={handleDividerMouseDown}
      />

      <div className="flex flex-col min-w-0" style={{ width: `${sidebarWidthPercent}%` }}>
        <div className="flex-1 min-h-0">
          {uiMode === 'omniagents' ? (
            <OmniAgentsApp uiUrl={uiSrc} onReady={handleUiReady} sandboxLabel={sandboxLabel} />
          ) : (
            <Webview src={uiSrc} onReady={handleUiReady} showUnavailable={false} />
          )}
        </div>
      </div>
    </div>
  );
});
CodeSplitLayout.displayName = 'CodeSplitLayout';
