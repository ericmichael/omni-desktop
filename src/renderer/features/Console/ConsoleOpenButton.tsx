import { useStore } from '@nanostores/react';
import { memo, useCallback } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { PiTerminalBold } from 'react-icons/pi';

import { cn, IconButton } from '@/renderer/ds';
import { $isConsoleOpen, $terminalHasNewOutput } from '@/renderer/features/Console/state';

const hotkeyOptions = {
  enableOnFormTags: true,
};

export const ConsoleOpenButton = memo(({ className }: { className?: string }) => {
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
        <PiTerminalBold
          className={cn(consoleHasNewOutput && 'animate-jump-shake', consoleHasNewOutput && 'text-yellow-400')}
        />
      }
      className={cn(isOpen && 'pointer-events-none', className)}
    />
  );
});
ConsoleOpenButton.displayName = 'ConsoleOpenButton';
