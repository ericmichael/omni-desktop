import '@xterm/xterm/css/xterm.css';

import { useStore } from '@nanostores/react';
import { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { debounce } from 'es-toolkit/compat';
import { ChevronDown } from 'lucide-react';
import type { Atom } from 'nanostores';
import type { PropsWithChildren } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { $XTERM_THEME } from '@/renderer/constants';
import { Button } from '@/renderer/ds/ui/button';

const getIsAtBottom: (terminal: Terminal) => boolean = (terminal) => {
  const viewport = terminal.buffer.active.viewportY;
  const scrollback = terminal.buffer.active.length;
  const isAtBottom = viewport === scrollback - terminal.rows;
  return isAtBottom;
};

export const XTermLogViewer = memo(({ children, $xterm }: PropsWithChildren<{ $xterm: Atom<Terminal | null> }>) => {
  const xterm = useStore($xterm);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    const parent = el?.parentElement;

    if (!el || !parent || !xterm) {
      return;
    }

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.options.theme = $XTERM_THEME.get();

    const debouncedFit = debounce(
      () => {
        fitAddon.fit();
      },
      300,
      { leading: true, trailing: true }
    );
    const resizeObserver = new ResizeObserver(debouncedFit);
    resizeObserver.observe(parent);

    const onWheel = () => {
      setIsAtBottom(getIsAtBottom(xterm));
    };

    el.addEventListener('wheel', onWheel);

    xterm.open(el);
    fitAddon.fit();

    return () => {
      resizeObserver.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
  }, [xterm]);

  const onClickScrollToBottom = useCallback(() => {
    const xterm = $xterm.get();
    if (!xterm) {
      return;
    }
    xterm.scrollToBottom();
  }, [$xterm]);
  return (
    <div className="relative w-full h-full border border-border rounded-xl overflow-hidden">
      <div ref={containerRef} className="absolute inset-2" />
      {children}
      {!isAtBottom && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Scroll to Bottom"
          onClick={onClickScrollToBottom}
          className="absolute bottom-2 right-2 bg-card opacity-80"
        >
          <ChevronDown />
        </Button>
      )}
    </div>
  );
});

XTermLogViewer.displayName = 'XTermLogViewer';
