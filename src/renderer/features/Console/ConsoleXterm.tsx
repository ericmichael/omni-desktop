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
    terminal.xterm.onResize(({ rows, cols }) => {
      emitter.invoke('terminal:resize', terminal.id, cols, rows);
    });

    const fit = () => {
      terminal.fitAddon.fit();
    };
    const debouncedFit = debounce(fit, 300, { leading: false, trailing: true });

    const resizeObserver = new ResizeObserver(debouncedFit);
    resizeObserver.observe(parent);

    terminal.xterm.open(el);
    terminal.xterm.focus();

    debouncedFit();

    return () => {
      resizeObserver.disconnect();
    };
  }, [terminal.fitAddon, terminal.id, terminal.xterm, theme]);

  const styles = useStyles();
  return <div ref={ref} className={styles.root} />;
});
ConsoleXterm.displayName = 'ConsoleXterm';
