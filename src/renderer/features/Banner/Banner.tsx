import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { AsciiLogo } from '@/renderer/common/AsciiLogo';
import { $launcherVersion } from '@/renderer/features/Banner/state';
import { SettingsModalOpenButton } from '@/renderer/features/SettingsModal/SettingsModalOpenButton';

export const Banner = memo(() => {
  const launcherVersion = useStore($launcherVersion);

  return (
    <div className="relative flex w-full items-center px-4 py-2 border-b border-surface-border shrink-0">
      <SettingsModalOpenButton className="absolute left-3" />
      <div className="flex-1 flex justify-center">
        <AsciiLogo />
      </div>
      {launcherVersion && (
        <span className="absolute right-3 text-[10px] text-fg-subtle bg-white/5 px-1.5 py-0.5 rounded-full select-none">
          v{launcherVersion}
        </span>
      )}
    </div>
  );
});
Banner.displayName = 'Banner';
