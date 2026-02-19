import { memo } from 'react';

import { Omni } from '@/renderer/features/Omni/Omni';

export const MainContent = memo(() => {
  return <Omni />;
});
MainContent.displayName = 'MainContent';
