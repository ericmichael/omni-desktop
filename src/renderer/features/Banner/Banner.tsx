import { memo } from 'react';

import { AsciiLogo } from '@/renderer/common/AsciiLogo';
import { SettingsModalOpenButton } from '@/renderer/features/SettingsModal/SettingsModalOpenButton';

export const Banner = memo(() => {
  return (
    <div className="relative flex w-full items-center px-4 py-2 border-b border-header-border bg-header text-header-fg shrink-0">
      <SettingsModalOpenButton className="absolute left-3" />
      <div className="flex-1 flex justify-center">
        <AsciiLogo className="text-[5px]" />
      </div>
    </div>
  );
});
Banner.displayName = 'Banner';
