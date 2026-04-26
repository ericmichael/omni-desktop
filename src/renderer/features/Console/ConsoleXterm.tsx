import { makeStyles } from '@fluentui/react-components';
import { debounce } from 'es-toolkit/compat';
import { memo, useEffect, useRef } from 'react';
import { assert } from 'tsafe';

import type { TerminalState } from '@/renderer/features/Console/state';
import { useXTermTheme } from '@/renderer/features/Console/use-xterm-theme';
import { emitter } from '@/renderer/services/ipc';

const useStyles = makeStyles({
  root: { width: '100%', height: '100%' },
});

export const ConsoleXterm = memo(({ terminal }: { terminal: TerminalState }) => {
  const theme = useXTermTheme();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    assert(el);
    assert(parent);

    terminal.xterm.options.theme = theme;
    const resizeSub = terminal.xterm.onResize(({ rows, cols }) => {
      emitter.invoke('terminal:resize', terminal.id, cols, rows);
    });

    const fit = () => {
      terminal.fitAddon.fit();
    };
    const debouncedFit = debounce(fit, 300, { leading: false, trailing: true });

    const resizeObserver = new ResizeObserver(debouncedFit);
    resizeObserver.observe(parent);

    // xterm's `open()` is documented as one-shot. On remount (e.g. toggling
    // sidecar apps) the xterm instance lives on in the atom — reparent its
    // existing root element instead of calling `open()` a second time, which
    // leaves the renderer stuck pointing at the old (detached) DOM.
    const existingRoot = terminal.xterm.element;
    if (existingRoot) {
      el.appendChild(existingRoot);
    } else {
      terminal.xterm.open(el);
    }

    // Defer to rAF so the new parent has layout, then fit + refresh so the
    // viewport paints the scrollback on the fresh DOM.
    const raf = requestAnimationFrame(() => {
      fit();
      terminal.xterm.refresh(0, terminal.xterm.rows - 1);
      terminal.xterm.focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      resizeSub.dispose();
      resizeObserver.disconnect();
    };
  }, [terminal.fitAddon, terminal.id, terminal.xterm, theme]);

  const styles = useStyles();
  return <div ref={ref} className={styles.root} />;
});
ConsoleXterm.displayName = 'ConsoleXterm';
