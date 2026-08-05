import { memo } from 'react';

import { AsciiLogo } from '@/renderer/common/AsciiLogo';
import { SettingsModalOpenButton } from '@/renderer/features/SettingsModal/SettingsModalOpenButton';

export const Banner = memo(() => {
  return (
    <div className="relative flex w-full items-center pl-5 pr-5 pt-2 pb-2 border-b border-border bg-card text-foreground shrink-0">
      <SettingsModalOpenButton className="absolute left-3" />
      <div className="flex-1 flex justify-center">
        <AsciiLogo className="text-xs" />
      </div>
    </div>
  );
});
Banner.displayName = 'Banner';
