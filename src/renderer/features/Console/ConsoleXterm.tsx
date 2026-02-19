import { debounce } from 'es-toolkit/compat';
import { memo, useEffect, useRef } from 'react';
import { assert } from 'tsafe';

import type { TerminalState } from '@/renderer/features/Console/state';
import { $isConsoleOpen } from '@/renderer/features/Console/state';
import { useXTermTheme } from '@/renderer/features/Console/use-xterm-theme';
import { emitter } from '@/renderer/services/ipc';

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

    const fitIfOpen = () => {
      if (!$isConsoleOpen.get()) {
        return;
      }
      terminal.fitAddon.fit();
    };
    const debouncedFitIfOpen = debounce(fitIfOpen, 300, { leading: false, trailing: true });

    const resizeObserver = new ResizeObserver(debouncedFitIfOpen);
    resizeObserver.observe(parent);

    const subscriptions = new Set<() => void>();

    subscriptions.add(() => {
      resizeObserver.disconnect();
    });
    subscriptions.add($isConsoleOpen.listen(debouncedFitIfOpen));

    terminal.xterm.open(el);
    terminal.xterm.focus();

    debouncedFitIfOpen();

    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
    };
  }, [terminal.fitAddon, terminal.id, terminal.xterm, theme]);

  return <div ref={ref} className="w-full h-full" />;
});
ConsoleXterm.displayName = 'ConsoleXterm';
