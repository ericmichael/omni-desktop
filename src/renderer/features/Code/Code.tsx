import { useStore } from '@nanostores/react';
import { memo } from 'react';

import { $initialized } from '@/renderer/services/store';

import { CodeDeck } from './CodeDeck';

export const Code = memo(() => {
  const initialized = useStore($initialized);
  if (!initialized) {
    return null;
  }

  return (
    <div className="flex flex-col w-full h-full">
      <CodeDeck />
    </div>
  );
});
Code.displayName = 'Code';
