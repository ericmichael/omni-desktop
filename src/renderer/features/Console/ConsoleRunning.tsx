import { memo } from 'react';
import { PiArrowCounterClockwiseBold, PiCaretDownBold, PiXBold } from 'react-icons/pi';

import { Divider, IconButton } from '@/renderer/ds';
import { ConsoleXterm } from '@/renderer/features/Console/ConsoleXterm';
import { $isConsoleOpen, destroyTerminal, type TerminalState } from '@/renderer/features/Console/state';
import { useNewTerminal } from '@/renderer/features/Console/use-new-terminal';

type Props = {
  terminal: TerminalState;
};

const closeConsole = () => {
  $isConsoleOpen.set(false);
};

export const ConsoleStarted = memo(({ terminal }: Props) => {
  const newTerminal = useNewTerminal();
  return (
    <div className="flex w-full h-full relative flex-col min-h-0">
      <div className="flex w-full h-10 items-center px-2">
        <IconButton
          aria-label="Kill Console"
          onClick={destroyTerminal}
          size="sm"
          icon={<PiXBold />}
          className="text-fg-error hover:bg-red-400/10"
        />
        <div className="flex-1" />
        <span className="text-fg-subtle select-none text-sm">Dev Console</span>
        <div className="flex-1" />
        <IconButton
          aria-label="Restart Console"
          onClick={newTerminal}
          size="sm"
          icon={<PiArrowCounterClockwiseBold />}
        />
        <IconButton aria-label="Hide Console" onClick={closeConsole} size="sm" icon={<PiCaretDownBold />} />
      </div>
      <Divider />
      <div className="w-full h-full p-2 min-h-0">
        <ConsoleXterm terminal={terminal} />
      </div>
    </div>
  );
});
ConsoleStarted.displayName = 'ConsoleStarted';
