import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { WindowConsole20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';

import { cn, IconButton } from '@/renderer/ds';
import { $isConsoleOpen, $terminalHasNewOutput } from '@/renderer/features/Console/state';

const useStyles = makeStyles({
  hidden: { pointerEvents: 'none' },
  newOutput: { color: tokens.colorPaletteYellowForeground1 },
});

const hotkeyOptions = {
  enableOnFormTags: true,
};

export const ConsoleOpenButton = memo(({ className }: { className?: string }) => {
  const styles = useStyles();
  const isOpen = useStore($isConsoleOpen);
  const consoleHasNewOutput = useStore($terminalHasNewOutput);

  const openConsole = useCallback(() => {
    $isConsoleOpen.set(true);
  }, []);

  const toggleConsole = useCallback(() => {
    $isConsoleOpen.set(!$isConsoleOpen.get());
  }, []);

  useHotkeys('ctrl+`', toggleConsole, hotkeyOptions);

  return (
    <IconButton
      aria-label="Open Terminal"
      onClick={openConsole}
      icon={
        <WindowConsole20Regular
          className={cn(consoleHasNewOutput && 'animate-jump-shake', consoleHasNewOutput && styles.newOutput)}
        />
      }
      className={mergeClasses(isOpen && styles.hidden, className)}
    />
  );
});
ConsoleOpenButton.displayName = 'ConsoleOpenButton';
