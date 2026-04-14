import '@xterm/xterm/css/xterm.css';

import { makeStyles, shorthands,tokens } from '@fluentui/react-components';
import { ChevronDown20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { debounce } from 'es-toolkit/compat';
import type { Atom } from 'nanostores';
import type { PropsWithChildren } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { $XTERM_THEME } from '@/renderer/constants';
import { IconButton } from '@/renderer/ds';

const useStyles = makeStyles({
  root: {
    position: 'relative',
    width: '100%',
    height: '100%',
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden',
  },
  container: { position: 'absolute', inset: tokens.spacingHorizontalS },
  scrollBtn: {
    position: 'absolute',
    bottom: tokens.spacingVerticalS,
    right: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground2,
    opacity: 0.8,
  },
});

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

  const styles = useStyles();
  return (
    <div className={styles.root}>
      <div ref={containerRef} className={styles.container} />
      {children}
      {!isAtBottom && (
        <IconButton
          aria-label="Scroll to Bottom"
          icon={<ChevronDown20Regular />}
          onClick={onClickScrollToBottom}
          size="sm"
          className={styles.scrollBtn}
        />
      )}
    </div>
  );
});

XTermLogViewer.displayName = 'XTermLogViewer';
