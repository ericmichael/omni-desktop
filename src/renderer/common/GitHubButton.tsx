import { memo } from 'react';
import { PiGithubLogoFill } from 'react-icons/pi';

import { IconButton } from '@/renderer/ds';

export const GitHubButton = memo(() => {
  return (
    <a href="https://github.com/emm/omni-code" target="_blank" rel="noopener noreferrer">
      <IconButton aria-label="GitHub" icon={<PiGithubLogoFill />} />
    </a>
  );
});
GitHubButton.displayName = 'GitHubButton';
