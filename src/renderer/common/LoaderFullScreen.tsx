import { memo } from 'react';

import { Spinner } from '@/renderer/ds';

export const LoaderFullScreen = memo(() => {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <Spinner size="xl" className="opacity-50" />
    </div>
  );
});
LoaderFullScreen.displayName = 'LoaderFullScreen';
