import { memo } from 'react';
import { PiDiscordLogoFill } from 'react-icons/pi';

import { IconButton } from '@/renderer/ds';

export const DiscordButton = memo(() => {
  return (
    <a href="https://discord.gg/ZmtBAhwWhy" target="_blank" rel="noopener noreferrer">
      <IconButton aria-label="Discord" icon={<PiDiscordLogoFill />} />
    </a>
  );
});
DiscordButton.displayName = 'DiscordButton';
